const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/move_settings.db');
const db = new sqlite3.Database(dbPath);

// Helper functions to get settings from database
async function getApprovedChannels(guildId) {
  return await new Promise((resolve) => {
    db.all('SELECT channelName, channelId FROM approved_channels WHERE guildId = ?', [guildId], (err, rows) => {
      if (err) {
        console.error('Database error in getApprovedChannels:', err);
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

// Helper function to build command with static choices
function buildMoveCommand() {
  const command = new SlashCommandBuilder()
    .setName('move')
    .setDescription('Ask users to move the conversation to offtopic channels')
    .addStringOption(option => {
      const opt = option
        .setName('channel')
        .setDescription('Which channel to send the move message to?')
        .setRequired(true);
      
      // Static choices
      opt.addChoices(
        { name: 'Tower Talks', value: 'Tower Talks' },
        { name: 'Player Questions', value: 'Player Questions' },
        { name: 'Player Questions Q&A', value: 'Player Questions Q&A' }
      );
      
      return opt;
    });

  return command;
}

module.exports = {
  category: 'utility',
  data: buildMoveCommand(),  // Synchronous now
  async execute(interaction) {
    try {
      // Static channel mapping
      const staticChannels = {
        'Tower Talks': '851012141837975602',
        'Player Questions': '1104477649549664327',
        'Player Questions Q&A': '1413097207107817564'
      };

      const allowedRoleId = '1082576750472609892';
      const member = interaction.member;
      const hasModPerm = member.permissions?.has(PermissionFlagsBits.ModerateMembers);
      const hasAllowedRole = member.roles?.cache?.has(allowedRoleId);
      if (!hasModPerm && !hasAllowedRole) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      }

      // Get the selected channel name from the string option
      const selectedChannelName = interaction.options.getString('channel');
      
      const targetChannelId = staticChannels[selectedChannelName];
      if (!targetChannelId) {
        return interaction.reply({ content: 'Invalid channel selected.', ephemeral: true });
      }
      
      const targetChannel = interaction.guild.channels.cache.get(targetChannelId);
      
      if (!targetChannel) {
        return interaction.reply({ content: 'Could not find the selected channel in this server.', ephemeral: true });
      }

      // Build the embed message
      const embed = {
        author: { name: 'The Tower Officer' },
        title: 'Off Topic',
        description:
          'This conversation is a little off-topic for this chat.\n\nPlease get back on track or move over to\n' +
          '<#850137218290417757>\n\nThank you!',
        footer: { text: 'To use this command type /move' }
      };

      // Send the move message without ping
      const sentMsg = await targetChannel.send({ 
        embeds: [embed] 
      });
      
      await interaction.reply({ content: `Move message sent to ${targetChannel}.`, ephemeral: true });

      // Save to history
      saveToHistory(
        interaction.guild.id,
        interaction.user.id, 
        interaction.user.username, 
        interaction.channel.id, 
        targetChannel.id
      );

      // Send a log embed to the log channel
      const logChannelId = await getLogChannel(interaction.guild.id);
      if (logChannelId) {
        const logChannel = interaction.guild.channels.cache.get(logChannelId);
        if (logChannel) {
          // Build a link to the move message sent to the target channel
          const moveMsgUrl = `https://discord.com/channels/${interaction.guild.id}/${targetChannel.id}/${sentMsg.id}`;
          const logEmbed = {
            title: 'Move Command Used',
            color: 0x3498db,
            fields: [
              {
                name: 'User:',
                value: `<@${interaction.user.id}> (${interaction.user.username})`,    
                inline: false
              },
              {
                name: 'Source Channel',
                value: `<#${interaction.channel.id}>`,
                inline: false
              },
              {
                name: 'Target Channel',
                value: `<#${targetChannel.id}>`,
                inline: false
              },
              {
                name: 'Message Link',
                value: `[Jump to message](${moveMsgUrl})`,
                inline: false
              }
            ],
            timestamp: new Date().toISOString(),
            thumbnail: {
              url: interaction.user.displayAvatarURL({ dynamic: true })
            },
          };
          
          // Get ping role from database for log message
          const pingRoleId = await getPingRole(interaction.guild.id);
          let logPingContent = '';
          if (pingRoleId) {
            logPingContent = `<@&${pingRoleId}>`;
          }
          
          await logChannel.send({ content: logPingContent, embeds: [logEmbed] });
        }
      }
    } catch (err) {
      console.error('Error in /move execute:', err);
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
