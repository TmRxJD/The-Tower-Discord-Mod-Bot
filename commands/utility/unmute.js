const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/moderation.db');
const db = new sqlite3.Database(dbPath);

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Unmute a user if they are currently muted')
    .addUserOption(opt => opt.setName('user').setDescription('User to unmute').setRequired(true)),

  async execute(interaction) {
    try {
      const allowedRoleId = '1360177046302752799'; // Same as warn command
      const member = interaction.member;
      const hasModPerm = member.permissions?.has(PermissionFlagsBits.ModerateMembers);
      const hasAllowedRole = member.roles?.cache?.has(allowedRoleId);
      if (!hasModPerm && !hasAllowedRole) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      }

      const user = interaction.options.getUser('user');
      if (!user) return interaction.reply({ content: 'Please specify a user.', ephemeral: true });

      const target = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!target) return interaction.reply({ content: 'User not found in this server.', ephemeral: true });

      // Check if the user is currently muted
      if (!target.communicationDisabledUntil || target.communicationDisabledUntil <= Date.now()) {
        return interaction.reply({ content: 'This user is not currently muted.', ephemeral: true });
      }

      // Unmute by removing the timeout
      await target.timeout(null, 'Unmuted by moderator');

      await interaction.reply({ content: `${target.user.tag} has been unmuted.`, ephemeral: true });

      // Optional: Log to moderation log channel
      // You can add logging similar to warn.js if needed

    } catch (err) {
      console.error('Error in /unmute execute:', err);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An error occurred while processing your command.', ephemeral: true });
        } else {
          await interaction.followUp({ content: 'An error occurred while processing your command.', ephemeral: true });
        }
      } catch {}
    }
  }
};
