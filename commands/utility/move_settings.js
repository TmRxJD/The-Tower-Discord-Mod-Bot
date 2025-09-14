
const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/move_settings.db');
const db = new sqlite3.Database(dbPath);

// Create tables for settings and history
db.run(`CREATE TABLE IF NOT EXISTS approved_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT,
  channelName TEXT,
  channelId TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS ping_role (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT,
  roleId TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS log_channel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT,
  channelId TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS move_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guildId TEXT,
  userId TEXT,
  username TEXT,
  usedAt INTEGER,
  sourceChannelId TEXT,
  targetChannelId TEXT
)`);

const allowedRoleId = '1360177046302752799';

function isModOrAllowed(member) {
  const hasModPerm = member.permissions?.has(PermissionFlagsBits.ModerateMembers);
  const hasAllowedRole = member.roles?.cache?.has(allowedRoleId);
  return hasModPerm || hasAllowedRole;
}

async function getApprovedChannels(guildId) {
  return await new Promise((resolve) => {
    db.all('SELECT channelName, channelId FROM approved_channels WHERE guildId = ?', [guildId], (err, rows) => {
      if (err) return resolve([]);
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

async function getMoveHistory(guildId, offset = 0, limit = 5) {
  return await new Promise((resolve) => {
    db.all('SELECT * FROM move_history WHERE guildId = ? ORDER BY usedAt DESC LIMIT ? OFFSET ?', [guildId, limit, offset], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows);
    });
  });
}

async function getTotalHistoryCount(guildId) {
  return await new Promise((resolve) => {
    db.get('SELECT COUNT(*) as count FROM move_history WHERE guildId = ?', [guildId], (err, row) => {
      if (err) return resolve(0);
      resolve(row.count);
    });
  });
}

function buildSettingsEmbed(approvedChannels, pingRole, logChannel, interaction, tempChannelSelections = null) {
  const embed = new EmbedBuilder()
    .setTitle('Move Command Settings')
    .setDescription('Configure approved channels, ping role, and log channel for the move command.');

  // Use temp selections if provided, otherwise use approved channels from database
  let channelsToShow;
  if (tempChannelSelections && tempChannelSelections instanceof Set) {
    // Convert Set to array and get channel objects
    const channelIds = Array.from(tempChannelSelections);
    channelsToShow = channelIds.map(id => {
      const channel = interaction.guild.channels.cache.get(id);
      return channel ? { channelId: id, channelName: channel.name } : null;
    }).filter(Boolean);
  } else {
    channelsToShow = approvedChannels;
  }

  embed.addFields(
    {
      name: 'Approved Channels',
      value: channelsToShow.length
        ? channelsToShow.map(c => `<#${c.channelId}> (${c.channelName})`).join('\n')
        : 'None set',
    },
    {
      name: 'Ping Role',
      value: pingRole ? `<@&${pingRole}>` : 'None set',
    },
    {
      name: 'Log Channel',
      value: logChannel ? `<#${logChannel}>` : 'None set',
    }
  );

  // Add claim status if there's a ping role
  if (pingRole && interaction) {
    const moveRole = interaction.guild.roles.cache.get(pingRole);
    if (moveRole) {
      const hasRole = interaction.member.roles.cache.has(moveRole.id);
      embed.addFields({
        name: 'Your Status',
        value: hasRole ? '✅ You have claimed the role' : '❌ You have not claimed the role',
      });
    }
  }

  return embed;
}

function buildHistoryEmbed(historyEntries, currentPage, totalPages) {
  const embed = new EmbedBuilder()
    .setTitle('Move Command History')
    .setDescription(`Recent uses of the move command (Page ${currentPage + 1} of ${totalPages})`);

  if (historyEntries.length === 0) {
    embed.addFields({
      name: 'No History',
      value: 'No move commands have been used yet.',
    });
  } else {
    const historyText = historyEntries.map((entry, index) => {
      const date = new Date(entry.usedAt);
      const sourceChannel = entry.sourceChannelId ? `<#${entry.sourceChannelId}>` : 'Unknown';
      const targetChannel = entry.targetChannelId ? `<#${entry.targetChannelId}>` : 'Unknown';
      return `**${currentPage * 5 + index + 1}.** ${entry.username} (<@${entry.userId}>)\n` +
             `📅 ${date.toLocaleString()}\n` +
             `📤 From: ${sourceChannel}\n` +
             `📥 To: ${targetChannel}\n`;
    }).join('\n');

    embed.addFields({
      name: 'Recent Uses',
      value: historyText,
    });
  }

  return embed;
}

function buildHistoryComponents(currentPage, totalPages) {
  const buttons = [];

  // Previous page button
  if (currentPage > 0) {
    const prevButton = new ButtonBuilder()
      .setCustomId(`move_history_prev_${currentPage - 1}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary);
    buttons.push(prevButton);
  }

  // Next page button
  if (currentPage < totalPages - 1) {
    const nextButton = new ButtonBuilder()
      .setCustomId(`move_history_next_${currentPage + 1}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary);
    buttons.push(nextButton);
  }

  // Back to main menu button
  const backButton = new ButtonBuilder()
    .setCustomId('move_settings_back')
    .setLabel('Back to Settings')
    .setStyle(ButtonStyle.Primary);
  buttons.push(backButton);

  const rows = [];
  if (buttons.length > 0) {
    const row = new ActionRowBuilder().addComponents(buttons);
    rows.push(row);
  }

  return rows;
}

function buildSettingsComponents(interaction, approvedChannels, pingRole, logChannel, page = 0, tempChannelSelections = null) {
  const allChannels = interaction.guild.channels.cache.filter(ch => ch.type === 0 || ch.type === 5);
  // Sort channels alphabetically by name
  const channelsArray = Array.from(allChannels.values()).sort((a, b) => a.name.localeCompare(b.name));
  
  // Calculate total pages
  const totalPages = Math.ceil(channelsArray.length / 25);
  
  // Use temp selections if provided, otherwise use approved channels from database
  let selectedChannelIds;
  if (tempChannelSelections && tempChannelSelections instanceof Set) {
    selectedChannelIds = Array.from(tempChannelSelections);
  } else if (tempChannelSelections && Array.isArray(tempChannelSelections)) {
    selectedChannelIds = tempChannelSelections;
  } else {
    selectedChannelIds = approvedChannels.map(c => c.channelId);
  }
  
  // Pagination for both dropdowns (25 channels per page)
  const startIndex = page * 25;
  const endIndex = Math.min(startIndex + 25, channelsArray.length);
  const channelOptions = channelsArray.slice(startIndex, endIndex).map(ch => ({
    label: ch.name,
    value: ch.id,
    default: selectedChannelIds.includes(ch.id)
  }));
  
  const channelSelect = new StringSelectMenuBuilder()
    .setCustomId('move_settings_channels')
    .setPlaceholder(`Select approved channels (Page ${page + 1} of ${totalPages})`)
    .setMinValues(0)
    .setMaxValues(channelOptions.length)
    .addOptions(channelOptions);

  // Log channel dropdown uses same pagination
  const logChannelOptions = channelsArray.slice(startIndex, endIndex).map(ch => ({
    label: ch.name,
    value: ch.id,
    default: ch.id === logChannel
  }));
  
  const logChannelSelect = new StringSelectMenuBuilder()
    .setCustomId('move_settings_log_channel')
    .setPlaceholder(`Select log channel (Page ${page + 1} of ${totalPages})`)
    .setMinValues(0)
    .setMaxValues(1)
    .addOptions(logChannelOptions);

  // Find the Move role (either from pingRole parameter or by name)
  let moveRole = null;
  if (pingRole) {
    moveRole = interaction.guild.roles.cache.get(pingRole);
  }
  if (!moveRole) {
    moveRole = interaction.guild.roles.cache.find(r => r.name === 'Move' && !r.managed);
  }

  // Create Move Role button - only show if no role exists
  const buttons = [];
  if (!moveRole) {
    const createRoleButton = new ButtonBuilder()
      .setCustomId('move_settings_create_role')
      .setLabel('Create Move Role')
      .setStyle(ButtonStyle.Success);
    buttons.push(createRoleButton);
  }

  // Claim/Unclaim button only enabled if Move role exists
  if (moveRole) {
    let claimLabel = 'Claim Move Role';
    let claimStyle = ButtonStyle.Primary;
    const member = interaction.member;
    const hasRole = member.roles.cache.has(moveRole.id);
    claimLabel = hasRole ? 'Unclaim Move Role' : 'Claim Move Role';
    claimStyle = hasRole ? ButtonStyle.Danger : ButtonStyle.Primary;
    
    const claimButton = new ButtonBuilder()
      .setCustomId('move_settings_claim')
      .setLabel(claimLabel)
      .setStyle(claimStyle);
    buttons.push(claimButton);
  }

  // Always show View History button
  const historyButton = new ButtonBuilder()
    .setCustomId('move_settings_history')
    .setLabel('View History')
    .setStyle(ButtonStyle.Secondary);
  buttons.push(historyButton);

  // Shared pagination buttons for both dropdowns
  const paginationButtons = [];
  if (page > 0) {
    const prevButton = new ButtonBuilder()
      .setCustomId(`move_channels_prev_${page - 1}`)
      .setLabel('◀ Previous Page')
      .setStyle(ButtonStyle.Secondary);
    paginationButtons.push(prevButton);
  }
  if (page < totalPages - 1) {
    const nextButton = new ButtonBuilder()
      .setCustomId(`move_channels_next_${page + 1}`)
      .setLabel('Next Page ▶')
      .setStyle(ButtonStyle.Secondary);
    paginationButtons.push(nextButton);
  }

  const row1 = new ActionRowBuilder().addComponents(channelSelect);
  const row2 = new ActionRowBuilder().addComponents(logChannelSelect);
  const rows = [row1, row2];
  
  // Add pagination buttons if needed
  if (paginationButtons.length > 0) {
    const paginationRow = new ActionRowBuilder().addComponents(paginationButtons);
    rows.push(paginationRow);
  }
  
  if (buttons.length > 0) {
    const actionRow = new ActionRowBuilder().addComponents(buttons);
    rows.push(actionRow);
  }
  
  return rows;
}

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('move_settings')
    .setDescription('Configure settings for the move command (mods only)'),

  async execute(interaction) {
    if (!isModOrAllowed(interaction.member)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    // Ephemeral reply with initial UI
    let approvedChannels = await getApprovedChannels(interaction.guild.id);
    let pingRole = await getPingRole(interaction.guild.id);
    let logChannel = await getLogChannel(interaction.guild.id);
    let embed = buildSettingsEmbed(approvedChannels, pingRole, logChannel, interaction);
    let components = buildSettingsComponents(interaction, approvedChannels, pingRole, logChannel, 0);
    const reply = await interaction.reply({
      embeds: [embed],
      components,
      ephemeral: true
    });

    // Set up temp state for this user
    let tempState = { channels: new Set(approvedChannels.map(c => c.channelId)) };
    let page = 0;

    // Collector setup
    const filter = i => i.user.id === interaction.user.id;
    const collector = reply.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });

    collector.on('collect', async i => {
      if (!isModOrAllowed(i.member)) {
        await i.reply({ content: 'You do not have permission to use this.', ephemeral: true });
        return;
      }
      
      if (i.isStringSelectMenu()) {
        if (i.customId === 'move_settings_channels') {
          // Update temp state with current page selections
          const currentPageChannels = i.values;
          const allChannels = i.guild.channels.cache.filter(ch => ch.type === 0 || ch.type === 5);
          const channelsArray = Array.from(allChannels.values()).sort((a, b) => a.name.localeCompare(b.name));
          const startIndex = page * 25;
          const endIndex = Math.min(startIndex + 25, channelsArray.length);
          const currentPageChannelIds = channelsArray.slice(startIndex, endIndex).map(ch => ch.id);
          
          // Remove any previous selections from current page
          currentPageChannelIds.forEach(id => tempState.channels.delete(id));
          // Add new selections from current page
          currentPageChannels.forEach(id => tempState.channels.add(id));
          
          // Auto-save channel settings to database (with error handling)
          try {
            await new Promise((resolve, reject) => {
              db.run('DELETE FROM approved_channels WHERE guildId = ?', [i.guild.id], (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
            
            for (const channelId of tempState.channels) {
              const channel = i.guild.channels.cache.get(channelId);
              if (channel) {
                await new Promise((resolve, reject) => {
                  db.run('INSERT INTO approved_channels (guildId, channelName, channelId) VALUES (?, ?, ?)', 
                    [i.guild.id, channel.name, channel.id], (err) => {
                      if (err) reject(err);
                      else resolve();
                    });
                });
              }
            }
            
            // Refresh UI from database
            approvedChannels = await getApprovedChannels(i.guild.id);
          } catch (error) {
            console.error('Database error:', error);
            // If database fails, at least update the UI with temp state
          }
        }
        else if (i.customId === 'move_settings_log_channel') {
          // Auto-save log channel to database
          db.run('DELETE FROM log_channel WHERE guildId = ?', [i.guild.id]);
          if (i.values.length > 0) {
            db.run('INSERT INTO log_channel (guildId, channelId) VALUES (?, ?)', [i.guild.id, i.values[0]]);
          }
          
          // Refresh log channel from database
          logChannel = await getLogChannel(i.guild.id);
        }
        
        // Update embed/components to reflect new selection
        const currentPingRole = await getPingRole(i.guild.id);
        const currentLogChannel = await getLogChannel(i.guild.id);
        embed = buildSettingsEmbed(approvedChannels, currentPingRole, currentLogChannel, interaction, tempState.channels);
        components = buildSettingsComponents(interaction, approvedChannels, currentPingRole, currentLogChannel, page, tempState.channels);
        await i.update({
          embeds: [embed],
          components,
          ephemeral: true
        });
      }
      
      if (i.isButton()) {
        // Handle pagination buttons
        if (i.customId.startsWith('move_channels_prev_') || i.customId.startsWith('move_channels_next_')) {
          const parts = i.customId.split('_');
          page = parseInt(parts[3]);
          
          // Don't update tempState when just navigating pages
          const currentPingRole = await getPingRole(i.guild.id);
          const currentLogChannel = await getLogChannel(i.guild.id);
          components = buildSettingsComponents(i, approvedChannels, currentPingRole, currentLogChannel, page, tempState.channels);
          
          await i.update({
            embeds: [embed],
            components,
            ephemeral: true
          });
        }
        else if (i.customId === 'move_settings_history') {
          // Show history view
          const historyEntries = await getMoveHistory(i.guild.id, 0, 5);
          const totalCount = await getTotalHistoryCount(i.guild.id);
          const totalPages = Math.max(1, Math.ceil(totalCount / 5));
          
          const historyEmbed = buildHistoryEmbed(historyEntries, 0, totalPages);
          const historyComponents = buildHistoryComponents(0, totalPages);
          
          await i.update({
            embeds: [historyEmbed],
            components: historyComponents,
            ephemeral: true
          });
        }
        else if (i.customId === 'move_settings_back') {
          // Go back to main settings view
          approvedChannels = await getApprovedChannels(i.guild.id);
          const currentPingRole = await getPingRole(i.guild.id);
          const currentLogChannel = await getLogChannel(i.guild.id);
          embed = buildSettingsEmbed(approvedChannels, currentPingRole, currentLogChannel, i, tempState.channels);
          components = buildSettingsComponents(i, approvedChannels, currentPingRole, currentLogChannel, page, tempState.channels);
          
          await i.update({
            embeds: [embed],
            components,
            ephemeral: true
          });
        }
        else if (i.customId.startsWith('move_history_prev_') || i.customId.startsWith('move_history_next_')) {
          // Handle pagination
          const page = parseInt(i.customId.split('_').pop());
          const historyEntries = await getMoveHistory(i.guild.id, page * 5, 5);
          const totalCount = await getTotalHistoryCount(i.guild.id);
          const totalPages = Math.max(1, Math.ceil(totalCount / 5));
          
          const historyEmbed = buildHistoryEmbed(historyEntries, page, totalPages);
          const historyComponents = buildHistoryComponents(page, totalPages);
          
          await i.update({
            embeds: [historyEmbed],
            components: historyComponents,
            ephemeral: true
          });
        }
        else if (i.customId === 'move_settings_create_role') {
          // Create role and save to database
          const moveRole = await i.guild.roles.create({ name: 'Move', mentionable: true, reason: 'Created by TowerModBot move_settings' });
          db.run('DELETE FROM ping_role WHERE guildId = ?', [i.guild.id]);
          db.run('INSERT INTO ping_role (guildId, roleId) VALUES (?, ?)', [i.guild.id, moveRole.id]);
          
          // Refresh UI
          const currentPingRole = await getPingRole(i.guild.id);
          const currentLogChannel = await getLogChannel(i.guild.id);
          embed = buildSettingsEmbed(approvedChannels, currentPingRole, currentLogChannel, i, tempState.channels);
          components = buildSettingsComponents(i, approvedChannels, currentPingRole, currentLogChannel, page, tempState.channels);
          await i.update({
            embeds: [embed],
            components,
            ephemeral: true
          });
        }
        else if (i.customId === 'move_settings_claim') {
          // Get current ping role from database
          let currentPingRole = await getPingRole(i.guild.id);
          let moveRole = null;
          
          if (currentPingRole) {
            moveRole = i.guild.roles.cache.get(currentPingRole);
          }
          if (!moveRole) {
            moveRole = i.guild.roles.cache.find(r => r.name === 'Move' && !r.managed);
          }
          
          if (!moveRole) {
            await i.update({ content: 'Move role does not exist.', ephemeral: true });
            return;
          }
          
          const memberObj = await i.guild.members.fetch(i.user.id);
          let actionMessage = '';
          if (memberObj.roles.cache.has(moveRole.id)) {
            await memberObj.roles.remove(moveRole);
            actionMessage = 'You have unclaimed the Move role.';
          } else {
            await memberObj.roles.add(moveRole);
            actionMessage = 'You have claimed the Move role.';
          }
          
          // Refresh UI
          currentPingRole = await getPingRole(i.guild.id);
          const currentLogChannel = await getLogChannel(i.guild.id);
          embed = buildSettingsEmbed(approvedChannels, currentPingRole, currentLogChannel, i, tempState.channels);
          components = buildSettingsComponents(i, approvedChannels, currentPingRole, currentLogChannel, page, tempState.channels);
          await i.update({
            embeds: [embed],
            components,
            ephemeral: true
          });
        }
      }
    });

    collector.on('end', async () => {
      // Optionally disable components when collector ends
      try {
        await reply.edit({ components: [] });
      } catch {}
    });
  }
};
