const { SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spendcheck')
    .setDescription('Check a player\'s purchase and booster history')
    .addStringOption(option =>
      option.setName('playerid')
        .setDescription('The player ID to check')
        .setRequired(true)
    ),
  async execute(interaction) {
    // Restrict to users with the required role or specific user ID
    const requiredRole = '1006842693382590524';
    const allowedUserId = '371914184822095873';
    if (!interaction.member.roles.cache.has(requiredRole) && interaction.user.id !== allowedUserId) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }
    const playerId = interaction.options.getString('playerid');
    const url = `https://store.techtreegames.com/thetower/api/auth/?id=${encodeURIComponent(playerId)}`;
    await interaction.deferReply({ ephemeral: true });
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`API returned status ${response.status}`);
      const data = await response.json();
      if (!data || !data.playerID) {
        return interaction.editReply('No data found for that player ID.');
      }
      // Format boosters
      const boosters = Object.entries(data.boosters || {})
        .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`)
        .join('\n');
      // Format purchases with stone pack monthly mapping
      const purchasesArr = Object.entries(data.purchasedSales || {});
      const now = new Date();
      // Stone pack monthly 1 = June 2025, 2 = July, etc.
      const baseMonth = 5; // June (0-indexed)
      const baseYear = 2025;
      function getStonePackMonth(num) {
        // num: 1 = June 2025, 2 = July 2025, ...
        let month = baseMonth + (num - 1);
        let year = baseYear + Math.floor(month / 12);
        month = month % 12;
        // Get month name
        const monthName = new Date(year, month, 1).toLocaleString('default', { month: 'long' });
        return `${monthName} ${year}`;
      }
      // Group and display stone packs and IAPs in order, grouped by month, with leader/limit/emoji
      const stonePackPurchasesArr = [];
      const monthData = {};
      // First, collect all stone-web-monthly and stone-sale in order
      purchasesArr.forEach(([k, v]) => {
        if (k.startsWith('stone-web-monthly-') || k.startsWith('stone-sale-')) {
          const num = parseInt(k.split('-').pop(), 10);
          if (!monthData[num]) monthData[num] = { packs: null, iap: null };
          if (k.startsWith('stone-web-monthly-')) monthData[num].packs = v;
          if (k.startsWith('stone-sale-')) monthData[num].iap = v;
        }
      });
      // Now, display in order of appearance in purchasesArr, grouping by month
      let lastMonthNum = null;
      purchasesArr.forEach(([k, v]) => {
        if (k.startsWith('stone-web-monthly-') || k.startsWith('stone-sale-')) {
          const num = parseInt(k.split('-').pop(), 10);
          if (k.startsWith('stone-web-monthly-')) {
            if (num !== lastMonthNum) {
              stonePackPurchasesArr.push(`__${getStonePackMonth(num)}__`);
              lastMonthNum = num;
            }
            let icon = '';
            if (v === 5) icon = '✅';
            else if (v > 5) icon = '❌';
            else icon = [':zero:',':one:',':two:',':three:',':four:',''][5-v] || '';
            stonePackPurchasesArr.push(`${icon} Stone Pack: ${v} / 5`);
          }
          if (k.startsWith('stone-sale-')) {
            let icon = '';
            if (v === 1) icon = '✅';
            else if (v > 1) icon = '❌';
            else icon = [':one:',''][1-v] || '';
            stonePackPurchasesArr.push(`${icon} IAP: ${v} / 1`);
          }
        }
      });
      // end-of-summer-bundle
      purchasesArr.filter(([k]) => k.startsWith('end-of-summer-bundle')).forEach(([k, v]) => {
        let icon = '';
        if (v === 3) icon = '✅';
        else if (v > 3) icon = '❌';
        else icon = [':three:',':two:',':one:',''][3-v] || '';
        stonePackPurchasesArr.push(`${icon} End of Summer Bundle: ${v} / 3`);
      });
      const stonePackPurchases = stonePackPurchasesArr.join('\n') || 'None';
      const embed = {
        title: `Purchase History for ${data.username || data.playerID}`,
        fields: [
          { name: 'Player ID', value: data.playerID, inline: false },
          { name: 'Username', value: data.username || 'Unknown', inline: false },
          { name: 'Boosters', value: boosters || 'None', inline: false },
          { name: 'Stone Pack Purchases', value: stonePackPurchases, inline: false },
        ],
        color: 0x3498db,
        timestamp: new Date().toISOString(),
      };
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Error in /spendcheck:', err);
      await interaction.editReply('Failed to fetch or parse player data.');
    }
  }
};
