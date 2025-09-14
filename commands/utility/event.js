const { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, '../../data/event_submissions.db');
const db = new sqlite3.Database(dbPath);

// Helper: Ensure tables exist
function initDb() {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channelId TEXT,
    type TEXT,
    theme TEXT,
    active INTEGER,
    startedAt INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eventId INTEGER,
    userId TEXT,
    messageId TEXT,
    content TEXT,
    timestamp INTEGER,
    FOREIGN KEY(eventId) REFERENCES events(id)
  )`);
}
initDb();

// Helper: Get active event for channel/type
function getActiveEvent(channelId, type) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM events WHERE channelId = ? AND type = ? AND active = 1', [channelId, type], (err, row) => {
      if (err) return resolve(null);
      resolve(row);
    });
  });
}

// Helper: Start event
function startEvent(channelId, type, theme) {
  return new Promise((resolve) => {
    db.run('INSERT INTO events (channelId, type, theme, active, startedAt) VALUES (?, ?, ?, 1, ?)', [channelId, type, theme, Date.now()], function(err) {
      if (err) return resolve(null);
      resolve(this.lastID);
    });
  });
}

// Helper: End event
function endEvent(channelId, type) {
  return new Promise((resolve) => {
    db.run('UPDATE events SET active = 0 WHERE channelId = ? AND type = ? AND active = 1', [channelId, type], function(err) {
      if (err) return resolve(false);
      resolve(this.changes > 0);
    });
  });
}

// Helper: Save submission
function saveSubmission(eventId, userId, messageId, content) {
  return new Promise((resolve) => {
    db.run('INSERT INTO submissions (eventId, userId, messageId, content, timestamp) VALUES (?, ?, ?, ?, ?)', [eventId, userId, messageId, content, Date.now()], function(err) {
      if (err) return resolve(null);
      resolve(this.lastID);
    });
  });
}

// Helper: Get user submission for event
function getUserSubmission(eventId, userId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM submissions WHERE eventId = ? AND userId = ?', [eventId, userId], (err, row) => {
      if (err) return resolve(null);
      resolve(row);
    });
  });
}

// Helper: Update submission
function updateSubmission(submissionId, messageId, content) {
  return new Promise((resolve) => {
    db.run('UPDATE submissions SET messageId = ?, content = ?, timestamp = ? WHERE id = ?', [messageId, content, Date.now(), submissionId], function(err) {
      if (err) return resolve(false);
      resolve(this.changes > 0);
    });
  });
}

// Helper: Get all submissions for event
function getAllSubmissions(eventId) {
  return new Promise((resolve) => {
    db.all('SELECT * FROM submissions WHERE eventId = ?', [eventId], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows);
    });
  });
}

// Helper: Get event by ID
function getEventById(eventId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM events WHERE id = ?', [eventId], (err, row) => {
      if (err) return resolve(null);
      resolve(row);
    });
  });
}

// Command definitions
const eventCommand = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Manage server events')
  .addSubcommand(sub =>
    sub.setName('start')
      .setDescription('Start an event')
      .addStringOption(opt =>
        opt.setName('type')
          .setDescription('Event type (Pun or Meme)')
          .setRequired(true)
          .addChoices(
            { name: 'Pun', value: 'Pun' },
            { name: 'Meme', value: 'Meme' }
          )
      )
      .addStringOption(opt =>
        opt.setName('theme')
          .setDescription('Theme for the event')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('end')
      .setDescription('End an event')
      .addStringOption(opt =>
        opt.setName('type')
          .setDescription('Event type (Pun or Meme)')
          .setRequired(true)
          .addChoices(
            { name: 'Pun', value: 'Pun' },
            { name: 'Meme', value: 'Meme' }
          )
      )
  )
  .addSubcommand(sub =>
    sub.setName('make_polls')
      .setDescription('Create polls for Pun event entries')
  )
  .addSubcommand(sub =>
    sub.setName('add_reactions')
      .setDescription('Add :pogcat: reaction to Meme event entries and remove old reactions')
  );


// Store collectors per channel/type
const activeCollectors = {};

// Restore collectors for active events on bot startup
async function restoreActiveCollectors(client) {
  // Get all active events from DB
  db.all('SELECT channelId, type FROM events WHERE active = 1', [], async (err, rows) => {
    if (err || !rows) return;
    for (const row of rows) {
      const channel = await client.channels.fetch(row.channelId).catch(() => null);
      if (channel && channel.isTextBased?.()) {
        startSubmissionCollector(channel, row.type);
      }
    }
  });
}

function startSubmissionCollector(channel, type) {
  const key = `${channel.id}:${type}`;
  if (activeCollectors[key]) return; // Already collecting
  const filter = m => !m.author.bot;
  const collector = channel.createMessageCollector({ filter });
  activeCollectors[key] = collector;
  collector.on('collect', async message => {
    // Only process if event is still active
    const event = await getActiveEvent(channel.id, type);
    if (!event || !event.active) return;
    // ...existing message submission logic...
    await module.exports.execute(message);
  });
  collector.on('end', () => {
    delete activeCollectors[key];
  });
}

function stopSubmissionCollector(channel, type) {
  const key = `${channel.id}:${type}`;
  if (activeCollectors[key]) {
    activeCollectors[key].stop();
    delete activeCollectors[key];
  }
}

module.exports = {
  category: 'utility',
  data: eventCommand,
  restoreActiveCollectors,
  async execute(interactionOrMessage) {
    // If this is a command interaction
    if (interactionOrMessage.isChatInputCommand?.()) {
      const interaction = interactionOrMessage;
      const sub = interaction.options.getSubcommand();
      const channelId = interaction.channel.id;
      if (sub === 'start') {
        const type = interaction.options.getString('type');
        const theme = interaction.options.getString('theme');
        const activeEvent = await getActiveEvent(channelId, type);
        if (activeEvent) {
          return interaction.reply({ content: `An active ${type} event is already running in this channel.`, ephemeral: true });
        }
        await startEvent(channelId, type, theme);
        // Start collector for this channel/type
        startSubmissionCollector(interaction.channel, type);
        return interaction.reply({ content: `Event started! Type: **${type}** | Theme: **${theme}**\nPlease submit your entries in this channel. Refrain from chatting until the event ends.`, ephemeral: true });
      }
      if (sub === 'end') {
        const type = interaction.options.getString('type');
        const ended = await endEvent(channelId, type);
        // Stop collector for this channel/type
        stopSubmissionCollector(interaction.channel, type);
        if (!ended) {
          return interaction.reply({ content: `No active ${type} event found in this channel.`, ephemeral: true });
        }
        return interaction.reply({ content: `Event ended for type: **${type}**. Submissions are now closed.`, ephemeral: true });
      }
      if (sub === 'make_polls') {
        // Only for Pun type
        const activeEvent = await getActiveEvent(channelId, 'Pun');
        if (!activeEvent) {
          return interaction.reply({ content: 'No active Pun event found in this channel.', ephemeral: true });
        }
        const entries = await getAllSubmissions(activeEvent.id);
        if (entries.length === 0) {
          return interaction.reply({ content: 'No entries found for this event.', ephemeral: true });
        }
        // Polls as embeds with emoji reactions
        const total = entries.length;
        let idx = 0;
        let pollNum = 1;
        const pollMessages = [];
        const pollOptions = [];
        const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
        while (idx < total) {
          const pollEntries = entries.slice(idx, idx + 10);
          idx += 10;
          let desc = pollEntries.map((e, n) => `${numberEmojis[n]} ${e.content}`).join('\n');
          const pollMsg = await interaction.channel.send({
            embeds: [{
              title: `Vote for your favorite puns! #${pollNum}/${Math.ceil(total/10)}`,
              description: desc,
              footer: { text: `Vote by reacting below!` }
            }]
          });
          // Add reactions for voting
          for (let i = 0; i < pollEntries.length; i++) {
            await pollMsg.react(numberEmojis[i]);
          }
          pollMessages.push(pollMsg.id);
          pollOptions.push(pollEntries.map(e => e.content));
          pollNum++;
        }
        // Follow-up message
        await interaction.channel.send({
          content: `If you don't see ${pollMessages.length} polls or aren't able to vote for every pun you like, press \`ctrl/cmd + R\` to refresh discord, or restart your mobile app.`
        });
        await interaction.reply({ content: 'Polls created!', ephemeral: true });

        // Timer for 24 hours to tally votes
        setTimeout(async () => {
          let results = [];
          for (let i = 0; i < pollMessages.length; i++) {
            try {
              const pollMsg = await interaction.channel.messages.fetch(pollMessages[i]);
              const options = pollOptions[i];
              let maxVotes = 0;
              let winners = [];
              for (let j = 0; j < options.length; j++) {
                const emoji = numberEmojis[j];
                const reaction = pollMsg.reactions.cache.get(emoji);
                const count = reaction ? reaction.count - 1 : 0; // subtract bot's own reaction
                if (count > maxVotes) {
                  maxVotes = count;
                  winners = [options[j]];
                } else if (count === maxVotes && count > 0) {
                  winners.push(options[j]);
                }
              }
              if (winners.length === 0) {
                results.push(`Poll #${i+1}: No votes received.`);
              } else if (winners.length === 1) {
                results.push(`Poll #${i+1}: Winner is **${winners[0]}** with ${maxVotes} vote(s)!`);
              } else {
                results.push(`Poll #${i+1}: Tie between: ${winners.map(w => `**${w}**`).join(', ')} with ${maxVotes} vote(s) each!`);
              }
            } catch {
              results.push(`Poll #${i+1}: Could not fetch poll message.`);
            }
          }
          await interaction.channel.send({
            content: `Polls have ended! Results:\n${results.join('\n')}`
          });
        }, 86400000); // 24 hours
      }
      if (sub === 'add_reactions') {
        // Only for Meme type
        const activeEvent = await getActiveEvent(channelId, 'Meme');
        if (!activeEvent) {
          return interaction.reply({ content: 'No active Meme event found in this channel.', ephemeral: true });
        }
        const entries = await getAllSubmissions(activeEvent.id);
        if (entries.length === 0) {
          return interaction.reply({ content: 'No entries found for this event.', ephemeral: true });
        }
        // Remove reactions and add :pogcat:
        let failed = 0;
        for (const entry of entries) {
          try {
            const msg = await interaction.channel.messages.fetch(entry.messageId);
            await msg.reactions.removeAll();
            await msg.react('pogcat');
          } catch {
            failed++;
          }
        }
        return interaction.reply({ content: `Reactions updated for all entries.${failed ? ` (${failed} failed)` : ''}`, ephemeral: true });
      }
    }
    // If this is a message (submission)
    if (interactionOrMessage.content && interactionOrMessage.author) {
      const message = interactionOrMessage;
      if (message.author.bot) return;
      const channelId = message.channel.id;
      // Check for active event in this channel
      const punEvent = await getActiveEvent(channelId, 'Pun');
      const memeEvent = await getActiveEvent(channelId, 'Meme');
      let event = punEvent || memeEvent;
      if (!event || !event.active) return;
      // Only allow submissions in event channel
      // Validate format
      if (event.type === 'Pun') {
        // Format: Name | Pun
        if (!/^.+\s*\|\s*.+$/.test(message.content)) {
          await message.delete();
          await message.channel.send({ content: `${message.author}, Invalid format! Please use: Name | Pun, and refrain from chatting until after the event ends.`, ephemeral: true });
          return;
        }
      } else if (event.type === 'Meme') {
        // Must contain a screenshot (attachment or image link)
        const hasImage = message.attachments.size > 0 || /(https?:\/\/\S+\.(jpg|jpeg|png|gif|webp))/.test(message.content);
        if (!hasImage) {
          await message.delete();
          await message.channel.send({ content: `${message.author}, Invalid submission! Please include a screenshot, and refrain from chatting until after the event ends.`, ephemeral: true });
          return;
        }
      }
      // Only allow one submission per user per event
      const prev = await getUserSubmission(event.id, message.author.id);
      if (prev) {
        // Prompt with buttons to confirm replacement
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('event_replace_yes').setLabel('Yes').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('event_replace_no').setLabel('No').setStyle(ButtonStyle.Danger)
        );
        const promptMsg = await message.channel.send({
          content: `${message.author}, You already submitted an entry. Do you want to replace it with: \n\n **${message.content}**?\n\nYour original will be removed if you click Yes.`,
          components: [row]
        });
        // Auto-delete prompt after 5 min
        setTimeout(() => {
          promptMsg.delete().catch(() => {});
        }, 300000);

        // Collector for button interaction
        const filter = i => i.user.id === message.author.id && i.customId.startsWith('event_replace_');
        const collector = promptMsg.createMessageComponentCollector({ filter, time: 15000, max: 1 });
        collector.on('collect', async i => {
          if (i.customId === 'event_replace_yes') {
            let newContent = message.content;
            // Validate format
            if (event.type === 'Pun') {
              if (!/^.+\s*\|\s*.+$/.test(newContent)) {
                await i.update({ content: `${message.author} Invalid format! Please use: Name | Pun`, components: [] });
                setTimeout(() => {
                  i.message.delete().catch(() => {});
                }, 300000);
                return;
              }
            } else if (event.type === 'Meme') {
              const hasImage = message.attachments.size > 0 || /(https?:\/\/\S+\.(jpg|jpeg|png|gif|webp))/.test(newContent);
              if (!hasImage) {
                await i.update({ content: `${message.author} Invalid submission! Please include a screenshot.`, components: [] });
                setTimeout(() => {
                  i.message.delete().catch(() => {});
                }, 300000);
                return;
              }
            }
            // Delete the original message
            try {
              const origMsg = await message.channel.messages.fetch(prev.messageId);
              await origMsg.delete();
            } catch {}
            // Update DB with new message ID and content
            await updateSubmission(prev.id, message.id, newContent);
            await i.update({ content: `${message.author} Your entry has been updated!`, components: [] });
            setTimeout(() => {
              i.message.delete().catch(() => {});
            }, 300000);
          } else {
            await i.update({ content: `${message.author} Your original entry was kept.`, components: [] });
            setTimeout(() => {
              i.message.delete().catch(() => {});
            }, 300000);
          }
        });
        return;
      }
      // Save submission
      await saveSubmission(event.id, message.author.id, message.id, message.content);
      try {
        const replyMsg = await message.reply({ content: `Submission confirmed! Submit again to change your entry.` });
        setTimeout(() => {
          replyMsg.delete().catch(() => {});
        }, 300000);
      } catch {
        // fallback if reply fails
        if (message.interaction && message.interaction.reply) {
          const replyMsg = await message.interaction.reply({ content: `Submission confirmed! Submit again to change your entry.` });
          setTimeout(() => {
            replyMsg.delete?.().catch(() => {});
          }, 300000);
        } else {
          // If not possible, do not send a public message
        }
      }
    }
    // If this is a button interaction for replacing entry
    if (interactionOrMessage.isButton?.()) {
      const interaction = interactionOrMessage;
      if (!interaction.customId.startsWith('event_replace_')) return;
      const channelId = interaction.channel.id;
      const userId = interaction.user.id;
      // Find active event
      const punEvent = await getActiveEvent(channelId, 'Pun');
      const memeEvent = await getActiveEvent(channelId, 'Meme');
      let event = punEvent || memeEvent;
      if (!event) return;
      const prev = await getUserSubmission(event.id, userId);
      if (!prev) return interaction.reply({ content: 'No previous submission found.', ephemeral: true });
      if (interaction.customId === 'event_replace_yes') {
        // Remove old message
        try {
          const oldMsg = await interaction.channel.messages.fetch(prev.messageId);
          await oldMsg.delete();
        } catch {}
        // Update DB with new submission
        await updateSubmission(prev.id, interaction.message.reference.messageId, interaction.message.content);
        await interaction.reply({ content: 'Your entry has been replaced!', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Your original entry was kept.', ephemeral: true });
      }
    }
  },
};
