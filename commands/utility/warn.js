const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/moderation.db');
const db = new sqlite3.Database(dbPath);

// Minimal DB migration: ensure mutes table and `rule` column exist
db.run(`CREATE TABLE IF NOT EXISTS mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId TEXT,
  username TEXT,
  moderatorId TEXT,
  moderatorName TEXT,
  rule TEXT,
  reason TEXT,
  severity INTEGER,
  muteTime INTEGER,
  muteEnd INTEGER,
  createdAt INTEGER
)`);
db.all('PRAGMA table_info(mutes)', [], (err, rows) => {
  if (err || !rows) return;
  const cols = rows.map(r => r.name);
  if (!cols.includes('rule')) db.run('ALTER TABLE mutes ADD COLUMN rule TEXT');
});

const rules = [
  'English Only Server',
  'Be Respectful',
  'Do Not Spam/Advertise',
  'Hacks/Exploits/Datamining/Automation',
  'Off Topic',
  'Using Tags Inappropriately',
  'Permission to DM',
  'One Account/Player',
  'Bypassing Bans/Appeals',
  'Discord TOS',
  'Streaming Adult Content',
  'Sharing Private Information'
];

const severityMap = [0, 5, 15, 60, 1440, 10080];

function formatDurationLabel(minutes) {
  if (!minutes || minutes <= 0) return 'Verbal';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}

function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return 'No mute (verbal)';
  let min = minutes;
  const w = Math.floor(min / 10080); min %= 10080;
  const d = Math.floor(min / 1440); min %= 1440;
  const h = Math.floor(min / 60); min %= 60;
  const parts = [];
  if (w) parts.push(`${w}w`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (min) parts.push(`${min}m`);
  return parts.join(' ');
}

function addMute(userId, username, moderatorId, moderatorName, rule, reason, severity, muteTime, muteEnd) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO mutes (userId, username, moderatorId, moderatorName, rule, reason, severity, muteTime, muteEnd, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, moderatorId, moderatorName, rule, reason, severity, muteTime, muteEnd, Date.now()],
      function (err) {
        if (err) return reject(err);
        // sqlite3 exposes lastID on the run callback
        resolve(this?.lastID ?? null);
      }
    );
  });
}

function createResultEmbed({ action = 'Warned', color = 0xffa500, member, moderator, reason = 'No reason provided', severity = null, muteTime = null, extraFields = [] }) {
  const embed = new EmbedBuilder()
    .setTitle(`${member.user ? member.user.tag : member.tag} — ${action}`)
    .setColor(color)
    .addFields(
      { name: 'User', value: `<@${member.id}>`, inline: true },
      { name: 'Moderator', value: `<@${moderator.id}>`, inline: true },
      { name: 'Reason', value: reason, inline: false },
    );
  if (severity !== null && muteTime !== null) {
    embed.addFields({ name: 'Severity (Duration)', value: `${severity} (${formatDuration(muteTime)})`, inline: true });
  }
  for (const f of extraFields) embed.addFields(f);
  embed.setTimestamp();
  return embed;
}

async function getLogChannelFromDb(guildId) {
  return await new Promise((resolve) => {
    db.get('SELECT channelId FROM log_channel WHERE guildId = ? LIMIT 1', [guildId], (err, row) => {
      if (err || !row) return resolve(null);
      resolve(row.channelId || null);
    });
  });
}

async function sendToLogChannel(interaction, embed) {
  try {
    const dbLogChannelId = await getLogChannelFromDb(interaction.guild.id).catch(() => null);
    if (!dbLogChannelId) return;
    // Try cache first, then fetch if not present in cache.
    let ch = interaction.guild.channels.cache.get(dbLogChannelId);
    if (!ch) ch = await interaction.guild.channels.fetch(dbLogChannelId).catch(() => null);
    if (ch) await ch.send({ embeds: [EmbedBuilder.from(embed)] });
  } catch (e) {
    console.error('Failed to send log embed:', e);
  }
}

module.exports = {
  category: 'utility',
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn or mute a user (no UI)')
    .addUserOption(opt => opt.setName('user').setDescription('User to warn/mute').setRequired(true))
        .addStringOption(opt => {
          const option = opt.setName('rule').setDescription('Rule # Violated').setRequired(true);
          try {
            // Add all numbered rules
            const choices = Array.isArray(rules) ? rules.slice(0, 25).map((r, i) => ({ name: `Rule ${i + 1} - ${r}`, value: String(i) })) : [];
            // Add the unnumbered 'Other' option at the end
            choices.push({ name: 'Other', value: 'other' });
            if (choices.length) option.addChoices(...choices);
          } catch (e) {
            // generous fallback: leave as free-text if addChoices fails
            console.error('Failed to add rule choices to /warn command:', e);
          }
          return option;
        })
    .addIntegerOption(opt => {
      const desc = `Severity (${severityMap.map((m, i) => `${i}=${formatDurationLabel(m)}`).join(', ')})`;
      const option = opt.setName('severity').setDescription(desc).setRequired(false);
      try {
        const choices = severityMap.map((min, i) => ({ name: `${i} - ${formatDurationLabel(min)}`, value: i }));
        if (choices.length) option.addChoices(...choices);
      } catch (e) {
        console.error('Failed to add severity choices to /warn command:', e);
      }
      return option;
    })
    .addStringOption(opt => opt.setName('reason').setDescription('Reason (for log)').setRequired(false)),
  async execute(interaction) {
    try {
      const allowedRoleId = '1360177046302752799';
      const member = interaction.member;
      const hasModPerm = member.permissions?.has(PermissionFlagsBits.ModerateMembers);
      const hasAllowedRole = member.roles?.cache?.has(allowedRoleId);
      if (!hasModPerm && !hasAllowedRole) return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });

      // DEBUG: capture interaction state immediately to help diagnose 10062 (Unknown interaction)
      try {
        console.log(`[WARN DEBUG] user=${interaction.user?.id} id=${interaction.id} token=${interaction.token ? 'yes' : 'no'} replied=${interaction.replied} deferred=${interaction.deferred} ts=${Date.now()}`);
      } catch (dbg) { /* ignore logging errors */ }

      // Required: acknowledge the interaction immediately (public confirmation).
      await interaction.deferReply({ ephemeral: false });

      const user = interaction.options.getUser('user');
      if (!user) return interaction.editReply({ content: 'Please specify a user.' });

      const rule = interaction.options.getString('rule');
      const freeTextReason = interaction.options.getString('reason') || null;
      let severity = interaction.options.getInteger('severity');
      if (severity == null) severity = 0;
      const muteTime = severityMap[severity] || 0;
      // Build reason text: prefer a rule label if rule was selected, include free-text reason under it if provided.
      let reason = 'No reason provided';
      if (rule) {
        if (rule === 'other') {
          reason = 'Other';
        } else if (!isNaN(Number(rule)) && Array.isArray(rules) && rules[Number(rule)]) {
          reason = `Rule ${Number(rule) + 1} - ${rules[Number(rule)]}`;
        } else {
          reason = `Rule - ${String(rule)}`;
        }
        if (freeTextReason) reason = `${reason}\n${freeTextReason}`;
      } else if (freeTextReason) {
        reason = freeTextReason;
      }

      const target = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!target) return interaction.editReply({ content: 'User not found in this server.' });

      const muteMs = muteTime * 60 * 1000;
      const muteEnd = muteTime > 0 ? Date.now() + muteMs : null;
      if (muteTime > 0) await target.timeout(muteMs, reason).catch(() => null);
      const muted = interaction.guild.members.cache.get(user.id)?.communicationDisabledUntil;
      console.log(`[WARN DEBUG] username=${user.username} targetID=${target.id} mutedUntil=${muted} muteTime=${muteTime} reason=${reason}`);
      const warnId = await addMute(user.id, user.tag, interaction.user.id, interaction.user.tag, rule, reason, severity, muteTime, muteEnd).catch(() => null);



      // Prepare values for display
      let publicReason = 'No reason provided';
      if (rule === 'other') {
        publicReason = 'Other';
      } else if (rule && !isNaN(Number(rule)) && Array.isArray(rules) && rules[Number(rule)]) {
        publicReason = `Rule ${Number(rule) + 1} - ${rules[Number(rule)]}`;
      } else if (rule) {
        publicReason = `Rule - ${String(rule)}`;
      }
      const muteLengthLabel = formatDuration(muteTime);
      const commentsText = freeTextReason && String(freeTextReason).trim().length ? String(freeTextReason).trim() : null;

      // User | Mod row
      // Reason | Mute Time row
      // Comments (if any)
      const publicEmbed = new EmbedBuilder()
        .setTitle(`🛡️ Moderation Action - User Warned`)
        .setColor(0xffa500)
        .addFields(
          { name: 'User', value: `<@${target.id}>`, inline: true },
          { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
          { name: '\u200B', value: '\u200B', inline: true }, // empty to force new row
          { name: 'Reason', value: publicReason, inline: true },
          { name: 'Mute Time', value: muteLengthLabel, inline: true },
          { name: '\u200B', value: '\u200B', inline: true }
        );
      if (commentsText) {
        publicEmbed.addFields({ name: 'Comments', value: commentsText, inline: false });
      }
      publicEmbed.setTimestamp();


      // Query total warnings for the user
      let totalWarns = 0;
      try {
        totalWarns = await new Promise((resolve, reject) => {
          db.get('SELECT COUNT(*) as count FROM mutes WHERE userId = ?', [user.id], (err, row) => {
            if (err) return resolve(0);
            resolve(row && row.count ? row.count : 0);
          });
        });
      } catch {}


      const severityLabel = `${formatDurationLabel(muteTime)} (${severity})`;
      const titleName = target.user ? `${target.user.tag}` : `${target.tag}`;
      const warnNumber = warnId ? `#${warnId}` : '';
      const logEmbed = new EmbedBuilder()
        .setTitle(`🛡️ Warn ${warnNumber} — ${titleName}`.trim())
        .setDescription(`Total Warns: ${totalWarns}`)
        .setColor(0xffa500)
        .addFields(
          { name: 'User', value: `<@${target.id}>`, inline: true },
          { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
          { name: '\u200B', value: '\u200B', inline: true },
          { name: 'Reason', value: publicReason, inline: true },
          { name: 'Severity', value: severityLabel, inline: true },
          { name: '\u200B', value: '\u200B', inline: true }
        );
      if (commentsText) {
        logEmbed.addFields({ name: 'Comments', value: commentsText, inline: false });
      }
      logEmbed.setTimestamp();

      try {
          // normal path: edit the deferred reply
          await interaction.editReply({ embeds: [publicEmbed] });
      } catch (sendErr) {
        console.error('Failed to send public confirmation for /warn:', sendErr);
      }
      // Always attempt to log to the configured log channel (independent of interaction token)
      try { await sendToLogChannel(interaction, logEmbed); } catch (logErr) { console.error('Failed to send log embed:', logErr); }
    } catch (err) {
      console.error('Error in /warn execute (minimal):', err);
      try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Error processing command', ephemeral: true }); else await interaction.followUp({ content: 'Error processing command', ephemeral: true }); } catch {}
    }
  }
};

// helpers exported for warnHistory.js
module.exports.rules = rules;
module.exports.severityMap = severityMap;
module.exports.formatDurationLabel = formatDurationLabel;
module.exports.createResultEmbed = createResultEmbed;
