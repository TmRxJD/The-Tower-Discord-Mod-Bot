const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('pin')
    .setDescription('Request to pin a message by notifying moderators')
    .addStringOption(opt => opt.setName('message_link').setDescription('Link to the message to pin (optional)').setRequired(false)),

  async execute(interaction) {
    try {
      const allowedRoleId = '1082576750472609892';
      const member = interaction.member;
      const hasAllowedRole = member.roles?.cache?.has(allowedRoleId);
      if (!hasAllowedRole) {
        return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
      }

      const messageLink = interaction.options.getString('message_link');

      // Mod channel ID
      const modChannelId = '1394574057181155439';
      const logChannelId = '934057793143599174';
      const modChannel = interaction.guild.channels.cache.get(modChannelId);
      if (!modChannel) {
        return interaction.reply({ content: 'Could not find the mod channel.', ephemeral: true });
      }

      // Build embed
      const embed = new EmbedBuilder()
        .setTitle('Pin Request')
        .setColor(0xffa500) // Orange like warn
        .addFields(
          { name: 'Requested By', value: `<@${interaction.user.id}>`, inline: false },
          { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: false },
          { name: 'Link to Request', value: `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`, inline: false }
        );
      
      if (messageLink) {
        embed.addFields({ name: 'Message to Pin', value: messageLink, inline: false });
      }

      embed.setTimestamp();

      // Send to mod channel
      await modChannel.send({ embeds: [embed] });

      // Build log embed
      const logEmbed = new EmbedBuilder()
        .setTitle('Pin Command Used')
        .setColor(0xffa500) // Orange like warn
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: 'Requested By', value: `<@${interaction.user.id}>`, inline: false },
          { name: 'Channel', value: `<#${interaction.channel.id}>`, inline: false },
          { name: 'Link to Request', value: `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`, inline: false }
        );
      
      if (messageLink) {
        logEmbed.addFields({ name: 'Message to Pin', value: messageLink, inline: false });
      }

      logEmbed.setTimestamp();
      // Send to log channel
      const logChannel = interaction.guild.channels.cache.get(logChannelId);
      if (logChannel) {
        await logChannel.send({ embeds: [logEmbed] });
      }

      // Public embed in the channel
      const publicEmbed = new EmbedBuilder()
        .setTitle('Pin Request Sent')
        .setDescription('Your pin request has been sent to the moderators for review.')
        .setColor(0x00ff00) // Green for success
        .setTimestamp();

      if (messageLink) {
        publicEmbed.addFields({ name: 'Requested Pin', value: messageLink, inline: false });
      }

      await interaction.reply({ embeds: [publicEmbed] });

    } catch (err) {
      console.error('Error in /pin execute:', err);
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
