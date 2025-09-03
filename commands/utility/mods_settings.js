const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/move_settings.db');
const db = new sqlite3.Database(dbPath);

// Ensure mods_settings table exists
db.run(`CREATE TABLE IF NOT EXISTS mods_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT UNIQUE,
  channelId TEXT,
  roleId TEXT
)`);

// Ensure log_channel table exists for move/mods logging
db.run(`CREATE TABLE IF NOT EXISTS log_channel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT,
  channelId TEXT
)`);

async function getModsSettings(guildId) {
  return await new Promise((resolve) => {
    db.get('SELECT channelId, roleId FROM mods_settings WHERE guildId = ? LIMIT 1', [guildId], (err, row) => {
      if (err || !row) return resolve({ channelId: null, roleId: null });
      resolve({ channelId: row.channelId || null, roleId: row.roleId || null });
    });
  });
}

function setModsSettings(guildId, channelId, roleId) {
  db.run('INSERT INTO mods_settings (guildId, channelId, roleId) VALUES (?, ?, ?) ON CONFLICT(guildId) DO UPDATE SET channelId=excluded.channelId, roleId=excluded.roleId', [guildId, channelId, roleId]);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mods_settings')
    .setDescription('Configure mods notification channel and role')
  .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post mod requests in').setRequired(false))
  .addRoleOption(opt => opt.setName('role').setDescription('Role to ping for mod requests').setRequired(false))
  .addChannelOption(opt => opt.setName('log_channel').setDescription('Channel to send audit logs to').setRequired(false)),

  async execute(interaction) {
    try {
      // Require ManageGuild or ModerateMembers
      
    const member = interaction.member;
    const allowedRoleId = '1360172773649023026';
    const allowed = member.permissions?.has(PermissionFlagsBits.ManageGuild) || member.permissions?.has(PermissionFlagsBits.ModerateMembers) || member.roles?.cache?.has(allowedRoleId);
    if (!allowed) return interaction.reply({ content: 'You do not have permission to change mods settings.', ephemeral: true });

  // Acknowledge early to reserve the interaction token and avoid timing races
  try { await interaction.deferReply({ ephemeral: true }); } catch (e) { /* ignore */ }

  const channel = interaction.options.getChannel('channel');
      const role = interaction.options.getRole('role');
      const logChannel = interaction.options.getChannel('log_channel');

      // Load existing settings so we only overwrite what the user provided
      const existing = await getModsSettings(interaction.guild.id);
      const newChannelId = channel ? channel.id : existing.channelId;
      const newRoleId = role ? role.id : existing.roleId;

      setModsSettings(interaction.guild.id, newChannelId, newRoleId);

      // Handle log_channel separately; if provided, replace previous entry. If not provided, keep existing.
      let finalLogChannelId = null;
      if (logChannel) {
        // remove any previous entry for this guild, then insert the new log channel
        db.run('DELETE FROM log_channel WHERE guildId = ?', [interaction.guild.id], (err) => {
          if (err) console.error('Failed to delete old log channel:', err);
          db.run('INSERT INTO log_channel (guildId, channelId) VALUES (?, ?)', [interaction.guild.id, logChannel.id], (err2) => {
            if (err2) console.error('Failed to insert log channel:', err2);
          });
        });
        finalLogChannelId = logChannel.id;
      } else {
        // read current log channel if any
        finalLogChannelId = await new Promise((resolve) => {
          db.get('SELECT channelId FROM log_channel WHERE guildId = ? ORDER BY id DESC LIMIT 1', [interaction.guild.id], (err, row) => {
            if (err || !row) return resolve(null);
            resolve(row.channelId || null);
          });
        });
      }

      const channelDisplay = newChannelId ? `<#${newChannelId}>` : 'None';
      const roleDisplay = newRoleId ? `<@&${newRoleId}>` : 'None';
      const logDisplay = finalLogChannelId ? `<#${finalLogChannelId}>` : 'None';

      try {
        await interaction.editReply({ content: `Mods settings updated. Channel: ${channelDisplay}, Role: ${roleDisplay}, Log: ${logDisplay}` });
      } catch (e) {
        // If editReply fails, fallback to reply (best-effort)
        try { await interaction.reply({ content: `Mods settings updated. Channel: ${channelDisplay}, Role: ${roleDisplay}, Log: ${logDisplay}`, ephemeral: true }); } catch (e2) { /* ignore */ }
      }
      return;
    } catch (err) {
      console.error('Error in /mods_settings execute:', err);
      try {
        if (interaction.deferred) {
          try { await interaction.editReply({ content: 'An error occurred while processing your command.' }); } catch (e) {
            try { await interaction.followUp({ content: 'An error occurred while processing your command.', ephemeral: true }); } catch (e2) { /* ignore */ }
          }
        } else if (interaction.replied) {
          try { await interaction.followUp({ content: 'An error occurred while processing your command.', ephemeral: true }); } catch (e) { /* ignore */ }
        } else {
          try { await interaction.reply({ content: 'An error occurred while processing your command.', ephemeral: true }); } catch (e) { /* ignore */ }
        }
      } catch {}
    }
  }
};
