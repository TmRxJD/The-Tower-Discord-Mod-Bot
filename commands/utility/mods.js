const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/move_settings.db');
const db = new sqlite3.Database(dbPath);

// Ensure mods_settings table exists (stores notification channel and ping role)
db.run(`CREATE TABLE IF NOT EXISTS mods_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT UNIQUE,
  channelId TEXT,
  roleId TEXT
)`);

// Helper functions to get settings from database
async function getApprovedChannels(guildId) {
  return await new Promise((resolve) => {
    db.all('SELECT channelName, channelId FROM approved_channels WHERE guildId = ?', [guildId], (err, rows) => {
      if (err) {
        console.error('Database error in getApprovedChannels (mods):', err);
        return resolve([]);
      }
      resolve(rows);
    });
  });
}

async function getPingRole(guildId) {
  return await new Promise((resolve) => {
    db.get('SELECT roleId FROM ping_role WHERE guildId = ? ORDER BY id DESC LIMIT 1', [guildId], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row.roleId);
    });
  });
}

async function getLogChannel(guildId) {
  return await new Promise((resolve) => {
    db.get('SELECT channelId FROM log_channel WHERE guildId = ? ORDER BY id DESC LIMIT 1', [guildId], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row.channelId);
    });
  });
}

function saveToHistory(guildId, userId, username, sourceChannelId, targetChannelId) {
  const timestamp = Date.now();
  db.run('INSERT INTO move_history (guildId, userId, username, usedAt, sourceChannelId, targetChannelId) VALUES (?, ?, ?, ?, ?, ?)', 
    [guildId, userId, username, timestamp, sourceChannelId, targetChannelId]);
}

// Mods settings helpers
async function getModsSettings(guildId) {
  return await new Promise((resolve) => {
    db.get('SELECT channelId, roleId FROM mods_settings WHERE guildId = ? LIMIT 1', [guildId], (err, row) => {
      if (err || !row) return resolve({ channelId: null, roleId: null });
      resolve({ channelId: row.channelId || null, roleId: row.roleId || null });
    });
  });
}

function setModsSettings(guildId, channelId, roleId) {
  // Upsert: try update, if no row updated insert
  db.run('INSERT INTO mods_settings (guildId, channelId, roleId) VALUES (?, ?, ?) ON CONFLICT(guildId) DO UPDATE SET channelId=excluded.channelId, roleId=excluded.roleId', [guildId, channelId, roleId]);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mods')
    .setDescription('Notify moderators')
    .addStringOption(option => option.setName('reason').setDescription('Why do you need moderators?').setRequired(true)),

  async execute(interaction) {
    try {
      const reason = interaction.options.getString('reason') || 'No reason provided';
      // Use configured mods channel if set, otherwise current channel
      const cfg = await getModsSettings(interaction.guild.id);
      const targetChannel = cfg.channelId ? interaction.guild.channels.cache.get(cfg.channelId) : interaction.channel;
      if (!targetChannel) {
        return interaction.reply({ content: 'Could not find the configured mods channel.', ephemeral: true });
      }

      // Build embed message for moderators
      const embed = {
        title: 'Moderator Assistance Requested',
        fields: [
          { name: 'Requested By', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: false },
          { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: false },        
          { name: 'Reason', value: reason, inline: false }        
        ],
        timestamp: new Date().toISOString()
      };

      // Acknowledge interaction quickly to avoid "application did not respond"
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (e) {}

      // Public notification in the channel where the command was used
      const publicEmbed = {
        author: { name: 'The Tower Officer' },
        title: `Mods have been notified`,
        description: 'Please wait for a mod to come and help.\n\nIf you need to make a ticket please use\nhttps://discord.com/channels/850137217828388904/1095418650732798103',
        color: 0x2ecc71,
        footer: { text: 'Do not ping moderators unnecessarily' },
        timestamp: new Date().toISOString()
      };
      let publicMsg = null;
      try {
        publicMsg = await interaction.channel.send({ embeds: [publicEmbed] });
      } catch (e) {}

      // Send the moderators notification, ping configured role if present
      const pingRoleId = cfg.roleId;
      const mention = pingRoleId ? `<@&${pingRoleId}>` : null;
      // Add a link to the public notification (if available)
      if (publicMsg) {
        embed.fields.push({ name: 'Source', value: `[Jump to notification](https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}/${publicMsg.id})`, inline: false });
      } else {
        embed.fields.push({ name: 'Source Channel', value: `<#${interaction.channel.id}>`, inline: false });
      }
      embed.thumbnail = { url: interaction.user.displayAvatarURL({ dynamic: true }) };
      const sentMsg = await targetChannel.send({ content: mention ?? undefined, embeds: [embed] });

      // Save to history (re-using move_history)
      saveToHistory(
        interaction.guild.id,
        interaction.user.id,
        interaction.user.username,
        interaction.channel.id,
        targetChannel.id
      );

      // Log to configured log channel
      const logChannelId = await getLogChannel(interaction.guild.id);
      if (logChannelId) {
        const logChannel = interaction.guild.channels.cache.get(logChannelId);
        if (logChannel) {
          const modsMsgUrl = `https://discord.com/channels/${interaction.guild.id}/${targetChannel.id}/${sentMsg.id}`;
          const logEmbed = {
            title: 'Mods Command Used',
            color: 0x3498db,
            fields: [
              { name: 'User', value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: false },
              { name: 'Source Channel', value: `<#${interaction.channel.id}>`, inline: false },
              { name: 'Message Link', value: `[Jump to message](${modsMsgUrl})`, inline: false },
              { name: 'Reason', value: reason, inline: false }
            ],
            timestamp: new Date().toISOString(),
            thumbnail: { url: interaction.user.displayAvatarURL({ dynamic: true }) }
          };

          const pingRoleIdFromDb = await getPingRole(interaction.guild.id);
          let logPingContent = '';
          if (pingRoleIdFromDb) logPingContent = `<@&${pingRoleIdFromDb}>`;

          await logChannel.send({ content: logPingContent, embeds: [logEmbed] });
        }
      }

      // delete the deferred ephemeral reply so nothing extra is shown to the user
      try {
        await interaction.deleteReply();
      } catch (e) {}
    } catch (err) {
      console.error('Error in /mods execute:', err);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: 'An error occurred while processing your command.', ephemeral: true });
        } else {
          await interaction.reply({ content: 'An error occurred while processing your command.', ephemeral: true });
        }
      } catch {}
    }
  }
};
