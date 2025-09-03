
// All requires at the top, no duplicates
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { rules: warnRules, severityMap: warnSeverityMap, formatDurationLabel: warnFormatDurationLabel, createResultEmbed } = require('./warn');
const dbPath = path.join(__dirname, '../../data/moderation.db');
const db = new sqlite3.Database(dbPath);

// In-memory store for comments submitted via modal keyed by the message id
const pendingComments = new Map();

// Helper to format minutes as 1w 2d 3h 15m
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

function getMuteHistory(userId) {
	return new Promise((resolve, reject) => {
		db.all(`SELECT * FROM mutes WHERE userId = ? ORDER BY createdAt DESC`, [userId], (err, rows) => {
			if (err) return reject(err);
			resolve(rows || []);
		});
	});
}

// Ensure `rule` column exists in mutes table
function ensureMutesTable() {
	return new Promise((resolve) => {
		db.run(`CREATE TABLE IF NOT EXISTS mutes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			userId TEXT,
			username TEXT,
			moderatorId TEXT,
			moderatorName TEXT,
			reason TEXT,
			severity INTEGER,
			muteTime INTEGER,
			muteEnd INTEGER,
			createdAt INTEGER
		)`, [], () => {
			db.all("PRAGMA table_info(mutes)", [], (err, rows) => {
				if (err || !rows) return resolve();
				const cols = rows.map(r => r.name);
				if (!cols.includes('rule')) {
					db.run('ALTER TABLE mutes ADD COLUMN rule TEXT', [], () => resolve());
				} else resolve();
			});
		});
	});
}

ensureMutesTable().catch(() => {});

// Simple severity map (minutes) matching original defaults
let severityMap = [0, 5, 15, 60, 1440, 10080];

function addMute(userId, username, moderatorId, moderatorName, rule, reason, severity, muteTime, muteEnd) {
	db.run(`INSERT INTO mutes (userId, username, moderatorId, moderatorName, rule, reason, severity, muteTime, muteEnd, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[userId, username, moderatorId, moderatorName, rule, reason, severity, muteTime, muteEnd, Date.now()]);
}

// Create a result embed for moderation actions

// Send embed to log channel if set
async function getLogChannelFromDb(guildId) {
	return await new Promise((resolve) => {
		db.get('SELECT channelId FROM log_channel WHERE guildId = ? LIMIT 1', [guildId], (err, row) => {
			if (err || !row) return resolve(null);
			resolve(row.channelId || null);
		});
	});
}

async function sendToLogChannel(interaction, embed, sourceMsg = null) {
	const dbLogChannelId = await getLogChannelFromDb(interaction.guild.id).catch(() => null);
	const effectiveLogChannelId = dbLogChannelId || null;
	if (effectiveLogChannelId) {
		const logChannel = interaction.guild.channels.cache.get(effectiveLogChannelId);
		if (logChannel) {
			let sourceMsgUrl = null;
			if (sourceMsg) {
				try { sourceMsgUrl = `https://discord.com/channels/${interaction.guild.id}/${sourceMsg.channelId}/${sourceMsg.id}`; } catch {}
			}
			const logEmbed = EmbedBuilder.from(embed);
			if (sourceMsgUrl) logEmbed.addFields({ name: 'Source', value: `[Jump to message](${sourceMsgUrl})`, inline: false });
			try { await logChannel.send({ embeds: [logEmbed] }); } catch (err) { console.error('Failed to send log embed to log channel:', err); }
		}
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('warnings')
		.setDescription('Show warning/mute history for a user')
		.addUserOption(opt => opt.setName('user').setDescription('User to view history for').setRequired(true)),
	async execute(interaction) {
		try {
			// Keep same permission model as /warn: require ModerateMembers or special role
			const allowedRoleId = '1360177046302752799';
			const member = interaction.member;
			const hasModPerm = member.permissions?.has(PermissionFlagsBits.ModerateMembers);
			const hasAllowedRole = member.roles?.cache?.has(allowedRoleId);
			if (!hasModPerm && !hasAllowedRole) {
				return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
			}

			const user = interaction.options.getUser('user');
			if (!user) return interaction.reply({ content: 'Please specify a user.', ephemeral: true });
				const history = await getMuteHistory(user.id);
				// Fetch the guild member once for button rendering and status checks
				let targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);

				// Pagination params
				const pageSize = 5;
				let page = 0;
				const totalPages = Math.max(1, Math.ceil(history.length / pageSize));
				const untilDate = new Date(user.communicationDisabledUntil);
				// buildHistoryEmbed is async so it can fetch the latest member data
				async function buildHistoryEmbed(pageIndex) {
					const targetMemberFresh = await interaction.guild.members.fetch({ user: user.id, force: true }).catch(() => null);
					console.log(`[WARN DEBUG] user=${user.id} targetMemberFresh=${targetMemberFresh.communicationDisabledUntil}`);
					const start = pageIndex * pageSize;
					const slice = history.slice(start, start + pageSize);
					const emb = new EmbedBuilder()
						.setTitle(`Warn History - ${user.tag}`)
						.setColor(0x3498db);
					if (!history.length) {
						emb.setDescription('No previous mutes.');
						if (targetMemberFresh && targetMemberFresh.communicationDisabledUntil && targetMemberFresh.communicationDisabledUntil > Date.now()) {
							
							emb.setFooter({ text: `Muted until: ${untilDate.toLocaleString()}` });
						} else {
							emb.setFooter({ text: 'Not Currently Muted' });
						}
						return emb;
					}
					const startIndex = start + 1;
					const endIndex = Math.min(start + slice.length, history.length);
					// Insert timestamp and mute time (if muted) at the top of the description
					const now = new Date();
					const timestampStr = `Currently Muted until: ${untilDate.toLocaleString()}`;
					let muteTimeStr = '';
					let muteCountdownStr = '';
					if (targetMemberFresh && targetMemberFresh.communicationDisabledUntil && targetMemberFresh.communicationDisabledUntil > Date.now()) {
						const untilDate = new Date(targetMemberFresh.communicationDisabledUntil);
						const untilEpoch = Math.floor(targetMemberFresh.communicationDisabledUntil / 1000);
						muteTimeStr = `Currently Muted Until: ${untilDate.toLocaleString()}`;
						muteCountdownStr = `Mute Expires <t:${untilEpoch}:R>\n`;
					}
					const descLines = [];
					if (muteTimeStr) descLines.push(muteTimeStr);
					if (muteCountdownStr) descLines.push(muteCountdownStr);
					descLines.push(`** Page ${pageIndex + 1} of ${totalPages} - Showing ${startIndex} - ${endIndex} of ${history.length} Entries**`);
					emb.setDescription(descLines.join('\n'));
					for (const h of slice) {
						const parts = [];
						// Determine rule label and comments separately. Prefer extracting from h.reason
						// (legacy or explicit), and fall back to the h.rule column when absent.
						let ruleLabel = null;
						let commentsText = null;

						// First try to parse an embedded rule from the reason string.
						if (h.reason && typeof h.reason === 'string') {
							const m = h.reason.match(/^Rule\s+(\d+)\s*-\s*(.*?)(?:\n([\s\S]*))?$/);
							if (m) {
								const idx = Number(m[1]); // idx is 1-based
								const ruleText = m[2] ? m[2].trim() : '';
								const trailingComments = m[3] ? m[3].trim() : null;
								if (warnRules && Array.isArray(warnRules) && !isNaN(idx) && typeof warnRules[idx - 1] === 'string') {
									ruleLabel = `Rule ${idx} - ${warnRules[idx - 1]}`;
								} else {
									ruleLabel = `Rule ${idx} - ${ruleText}`;
								}
								commentsText = trailingComments;
							} else {
								// No embedded rule; treat entire reason as comments
								commentsText = h.reason.trim();
							}
						}

						// Fallback: if no ruleLabel from reason, use h.rule column
						if (!ruleLabel && h.rule !== null && h.rule !== undefined && String(h.rule).trim() !== '') {
							if (warnRules && Array.isArray(warnRules) && !isNaN(Number(h.rule))) {
								const idx = Number(h.rule);
								if (typeof warnRules[idx] === 'string') ruleLabel = `Rule ${idx + 1} - ${warnRules[idx]}`;
								else ruleLabel = `Rule ${idx + 1} - ${String(h.rule)}`;
							} else {
								ruleLabel = `Rule - ${String(h.rule)}`;
							}
						}

						if (ruleLabel) parts.push(`**Reason:** ${ruleLabel}`);
						if (commentsText) parts.push(`**Comments:** ${commentsText}`);
						parts.push(`**Mod:** <@${h.moderatorId}> (${h.moderatorName})`);
						// Combine severity and duration
						const severityVal = h.severity ?? 'N/A';
						const durationVal = formatDuration(h.muteTime);
						parts.push(`**Severity:** ${severityVal} (${durationVal})`);
						emb.addFields({ name: `#${h.id} | ${new Date(h.createdAt).toLocaleString()}`, value: parts.join('\n'), inline: false });
					}
					if (targetMemberFresh && targetMemberFresh.communicationDisabledUntil && targetMemberFresh.communicationDisabledUntil > Date.now()) {
						const untilDate = new Date(targetMemberFresh.communicationDisabledUntil);
						emb.setFooter({ text: `Muted until: ${untilDate.toLocaleString()}` });
					} else {
						emb.setFooter({ text: 'Not Currently Muted' });
					}
					// Remove the timestamp from the footer if present
					// (footer is only for mute status)
					return emb;
				}

				function makeMainButtons() {
					const row = new ActionRowBuilder();
					row.addComponents(new ButtonBuilder().setCustomId('warn_confirm').setLabel('Warn').setStyle(ButtonStyle.Primary));
					if (targetMember && targetMember.communicationDisabledUntil && targetMember.communicationDisabledUntil > Date.now()) {
						row.addComponents(new ButtonBuilder().setCustomId('extend_mute').setLabel('Extend Mute').setStyle(ButtonStyle.Secondary));
					}
					// Start remove warnings flow
					row.addComponents(new ButtonBuilder().setCustomId('remove_warnings_start').setLabel('Remove Warning').setStyle(ButtonStyle.Danger));
					return row;
				}

				// Pagination row (placed first)
				const paginationRow = new ActionRowBuilder();
				if (totalPages > 1) {
					if (page > 0) paginationRow.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
					if (page < totalPages - 1) paginationRow.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
				}

				const componentsToSend = [];
				if (totalPages > 1) componentsToSend.push(paginationRow);
				componentsToSend.push(makeMainButtons());

				// Defer reply to avoid timing out the interaction while we build components.
				// If deferReply fails, fall back to reply. Log failures to help debug InteractionNotReplied.
				const embedToSend = await buildHistoryEmbed(page);
				// Defer-first flow: defer the interaction to claim the token, then editReply.
				// If defer fails (interaction already acknowledged), fall back to followUp. This avoids reply() on already-acked interactions.
				let message = null;
				try {
					try {
						await interaction.deferReply({ ephemeral: true });
						// now update the deferred reply
						try {
							message = await interaction.editReply({ embeds: [embedToSend], components: componentsToSend });
						} catch (editErr) {
							console.error('interaction.editReply failed after defer in /warnings:', editErr);
							// try to fetch reply as last resort
							try { message = await interaction.fetchReply(); } catch (fetchErr) { /* ignore */ }
						}
					} catch (deferErr) {
						// deferReply failed. Try safe fallbacks without calling reply() which can double-ack.
						try {
							// Prefer editing an existing reply (works if a deferred reply exists)
							try {
								message = await interaction.editReply({ embeds: [embedToSend], components: componentsToSend });
							} catch (editErr2) {
								// editReply failed — try followUp as a backup (works if interaction was already acknowledged)
								try {
									message = await interaction.followUp({ embeds: [embedToSend], components: componentsToSend, ephemeral: true });
								} catch (fuErr2) {
									console.error('Failed to send history in /warnings after defer (editReply & followUp failed):', fuErr2);
									return;
								}
							}
						} catch (finalErr) {
							console.error('Unexpected error handling defer/fallback in /warnings:', finalErr);
							return;
						}
					}
				} catch (err) {
					console.error('Failed to send history in /warnings (outer):', err);
					return;
				}
				const filter = i => i.user.id === interaction.user.id;

				// Helper to send an ephemeral reply for component/modal interactions safely.
				// Tries to reply on the component interaction if it's not acknowledged, otherwise falls back to the original
				// slash interaction followUp. Keeps logic centralized to avoid double-ack errors.
				async function safeEphemeralReply(compInteraction, text) {
					try {
						if (!compInteraction.deferred && !compInteraction.replied) {
							return await compInteraction.reply({ content: text, ephemeral: true });
						}
					} catch (e) {
						// ignore - we'll try followUp next
					}
					try {
						return await interaction.followUp({ content: text, ephemeral: true });
					} catch (e) {
						if (!(e && e.code === 10062)) console.error('FollowUp error in safeEphemeralReply:', e);
					}
				}

				// track collectors so we don't create duplicates
				let outerCollector = null;
				let innerCollector = null;

				// Create outer collector for main actions
				function createOuterCollector() {
					// ensure only one outer collector exists
					try { if (outerCollector) outerCollector.stop(); } catch (e) {}
					outerCollector = message.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
					outerCollector.on('collect', async i => {
						try {
							if (i.customId === 'history_prev' || i.customId === 'history_next') {
								if (i.customId === 'history_prev') page = Math.max(0, page - 1);
								if (i.customId === 'history_next') page = Math.min(totalPages - 1, page + 1);
								const newPagination = new ActionRowBuilder();
								if (totalPages > 1) {
									if (page > 0) newPagination.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
									if (page < totalPages - 1) newPagination.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
								}
								const comps = [];
								if (totalPages > 1) comps.push(newPagination);
								comps.push(makeMainButtons());
								await i.update({ embeds: [await buildHistoryEmbed(page)], components: comps });
								return;
							}

							// Moderation actions -- fetch the member
							const targetMember = await i.guild.members.fetch(user.id).catch(() => null);
							if (!targetMember) {
								await safeEphemeralReply(i, 'User not found in this server.');
								return;
							}

							if (i.customId === 'extend_mute') {
								const severity = 2;
								const muteTime = severityMap[severity] || 0;
								const muteMs = muteTime * 60 * 1000;
								let muteEnd = null;
								if (muteTime > 0) {
									try { await targetMember.timeout(muteMs, `Moderation action via /warnings by ${i.user.tag}`); } catch (err) { /* ignore */ }
									muteEnd = Date.now() + muteMs;
								}
								addMute(targetMember.id, targetMember.user.tag, i.user.id, i.user.tag, null, `Moderation via /warnings (extend_mute)`, severity, muteTime, muteEnd);
								const logEmbed = createResultEmbed({ action: 'Muted', color: 0xffa500, member: targetMember, moderator: i.user, reason: `Moderation via /warnings (extend_mute)`, severity, muteTime });
								const publicEmbed = createResultEmbed({ action: 'Muted', color: 0xffa500, member: targetMember, moderator: i.user, reason: `Moderation action`, severity: null, muteTime: null });
								try { await i.channel.send({ embeds: [publicEmbed] }); } catch {}
								await sendToLogChannel(i, logEmbed).catch(() => null);
								try { await i.update({ content: `Action performed: extend_mute`, components: [] }); } catch {}
								try { outerCollector.stop(); } catch (e) {}
								return;
							}

							if (i.customId === 'warn_confirm') {
								// Enter warn flow (rule + severity + optional comments modal)
								try { outerCollector.stop(); } catch (e) {}
								await createWarnCollector(i, message);
								return;
							}

							if (i.customId === 'remove_warnings_start') {
								// stop outer collector and enter inner removal flow
								try { outerCollector.stop(); } catch (e) {}
								createInnerCollector(i, message);
								return;
							}

							} catch (err) {
								console.error('Error handling component interaction in /warnings:', err);
								await safeEphemeralReply(i, 'Error handling action.');
							}
					});

					outerCollector.on('end', async () => {
						outerCollector = null;
						try { await message.edit({ components: [] }); } catch {}
					});
				}

				// Inner collector for remove-warnings flow
				async function createInnerCollector(triggerInteraction, messageRef) {
					const start = page * pageSize;
					const slice = history.slice(start, start + pageSize);
					if (!slice.length) {
						await safeEphemeralReply(triggerInteraction, 'No warnings on the current page to remove.');
						// recreate outer collector
						createOuterCollector();
						return;
					}
					const options = slice.map(h => ({ label: `#${h.id} | ${new Date(h.createdAt).toLocaleString()}`, value: String(h.id) }));
					const select = new StringSelectMenuBuilder()
						.setCustomId('remove_select')
						.setPlaceholder('Select warnings to remove')
						.setMinValues(1)
						.setMaxValues(Math.min(options.length, 25))
						.addOptions(options);

					const selectRow = new ActionRowBuilder().addComponents(select);
					const confirmRow = new ActionRowBuilder().addComponents(
						new ButtonBuilder().setCustomId('remove_warnings_confirm').setLabel('Confirm Removal').setStyle(ButtonStyle.Danger),
						new ButtonBuilder().setCustomId('remove_warnings_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
					);

					const comps = [];
					if (totalPages > 1) {
						const topPagination = new ActionRowBuilder();
						if (page > 0) topPagination.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
						if (page < totalPages - 1) topPagination.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
						comps.push(topPagination);
					}
					comps.push(selectRow);
					comps.push(confirmRow);

					// store selections here
					let selectedToRemove = [];

					try { await triggerInteraction.update({ embeds: [await buildHistoryEmbed(page)], components: comps }); } catch (err) { console.error('Failed to enter remove flow:', err); }

					// ensure only one inner collector
					try { if (innerCollector) innerCollector.stop(); } catch (e) {}
					innerCollector = messageRef.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
					innerCollector.on('collect', async subI => {
						try {
							if (subI.customId === 'remove_select') {
								selectedToRemove = subI.values || [];
								try { await subI.deferUpdate(); } catch (e) {}
								return;
							}
							if (subI.customId === 'remove_warnings_confirm') {
								if (!selectedToRemove.length) {
									await safeEphemeralReply(subI, 'No warnings selected. Use the dropdown to select warnings.');
									return;
								}
								// delete from DB
								const placeholders = selectedToRemove.map(() => '?').join(',');
								await new Promise((res, rej) => {
									db.run(`DELETE FROM mutes WHERE id IN (${placeholders})`, selectedToRemove, function(err) {
										if (err) return rej(err);
										res(this.changes);
									});
								}).catch(err => console.error('Failed to delete warnings:', err));

								// remove from local history array
								for (const id of selectedToRemove) {
									const idx = history.findIndex(h => String(h.id) === String(id));
									if (idx !== -1) history.splice(idx, 1);
								}

								// recompute pages
								const newTotal = Math.max(1, Math.ceil(history.length / pageSize));
								if (page >= newTotal) page = newTotal - 1;

								const updatedEmbed = await buildHistoryEmbed(page);
								const removedLine = `Removed: ${selectedToRemove.map(id => `#${id}`).join(', ')}`;
								const existingFooter = updatedEmbed.data.footer?.text || '';
								const newFooterText = existingFooter ? `${existingFooter}\n${removedLine}` : removedLine;
								updatedEmbed.setFooter({ text: newFooterText });

								const outComps = [];
								if (newTotal > 1) {
									const topPagination = new ActionRowBuilder();
									if (page > 0) topPagination.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
									if (page < newTotal - 1) topPagination.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
									outComps.push(topPagination);
								}
								outComps.push(makeMainButtons());

								try { await subI.update({ embeds: [updatedEmbed], components: outComps }); } catch (err) { console.error(err); }
								try { innerCollector.stop(); } catch (e) {}
								// recreate outer collector so buttons work again
								createOuterCollector();
								return;
							}
							if (subI.customId === 'remove_warnings_cancel') {
								// Cancel removal: restore main history view
								const newTotal = Math.max(1, Math.ceil(history.length / pageSize));
								if (page >= newTotal) page = newTotal - 1;
								const restoredEmbed = await buildHistoryEmbed(page);
								const outComps = [];
								if (newTotal > 1) {
									const topPagination = new ActionRowBuilder();
									if (page > 0) topPagination.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
									if (page < newTotal - 1) topPagination.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
									outComps.push(topPagination);
								}
								outComps.push(makeMainButtons());
								try { await subI.update({ embeds: [restoredEmbed], components: outComps }); } catch (err) { console.error('Failed to restore after cancel:', err); }
								try { innerCollector.stop(); } catch (e) {}
								createOuterCollector();
								return;
							}
						} catch (err) { console.error('Error in removal flow:', err); }
					});
					innerCollector.on('end', () => {
						innerCollector = null;
						// ensure outer collector exists after inner ends
						try { createOuterCollector(); } catch (e) {}
					});
				}

					// Warn flow: rule select, severity select, comments modal, confirm/cancel
					async function createWarnCollector(triggerInteraction, messageRef) {
						// Build rules options from warnRules (strings), prefix with index
						const rules = (Array.isArray(warnRules) ? warnRules : []).slice(0, 25).map((r, i) => ({ label: `${i + 1} - ${r}`, value: String(i) }));

						// Build severity options from warnSeverityMap, include index in label
						const severityOptions = (Array.isArray(warnSeverityMap) ? warnSeverityMap : []).map((min, i) => ({ label: `${i} - ${warnFormatDurationLabel ? warnFormatDurationLabel(min) : (min === 0 ? 'Verbal' : String(min) + 'm')}`, value: String(i) }));

						const ruleSelect = new StringSelectMenuBuilder()
							.setCustomId('warn_rule_select')
							.setPlaceholder('Select rule')
							.setMinValues(1)
							.setMaxValues(1)
							.addOptions(rules);

						const severitySelect = new StringSelectMenuBuilder()
							.setCustomId('warn_severity_select')
							.setPlaceholder('Select severity')
							.setMinValues(1)
							.setMaxValues(1)
							.addOptions(severityOptions);

						const ruleRow = new ActionRowBuilder().addComponents(ruleSelect);
						const sevRow = new ActionRowBuilder().addComponents(severitySelect);

						let selectedRule = null;
						let selectedSeverity = null;
						// Initialize comments from any pending modal result for this message
						let comments = pendingComments.get(messageRef.id) || null;

						function buildWarnComps() {
							// rebuild selects so we can set the selected option as default
							const ruleOptions = (Array.isArray(warnRules) ? warnRules : []).slice(0, 25).map((r, i) => ({ label: `${i + 1} - ${r}`, value: String(i), default: String(i) === String(selectedRule) }));
							const severityOptionsDynamic = (Array.isArray(warnSeverityMap) ? warnSeverityMap : []).map((min, i) => ({ label: `${i} - ${warnFormatDurationLabel ? warnFormatDurationLabel(min) : (min === 0 ? 'Verbal' : String(min) + 'm')}`, value: String(i), default: String(i) === String(selectedSeverity) }));

							const ruleSelectDyn = new StringSelectMenuBuilder()
								.setCustomId('warn_rule_select')
								.setPlaceholder('Select rule')
								.setMinValues(1)
								.setMaxValues(1)
								.addOptions(ruleOptions);

							const severitySelectDyn = new StringSelectMenuBuilder()
								.setCustomId('warn_severity_select')
								.setPlaceholder('Select severity')
								.setMinValues(1)
								.setMaxValues(1)
								.addOptions(severityOptionsDynamic);

							const ruleRowDyn = new ActionRowBuilder().addComponents(ruleSelectDyn);
							const sevRowDyn = new ActionRowBuilder().addComponents(severitySelectDyn);

							const storedComments = pendingComments.get(messageRef.id) || comments;
							const commentLabel = storedComments ? 'Edit Comments' : 'Add Comments';
							const commentBtn = new ButtonBuilder().setCustomId('warn_add_comments').setLabel(commentLabel).setStyle(ButtonStyle.Secondary);
							const confirmBtn = new ButtonBuilder().setCustomId('warn_confirm_final').setLabel('Confirm Warn').setStyle(ButtonStyle.Primary);
							const cancelBtn = new ButtonBuilder().setCustomId('warn_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary);
							const controlRow = new ActionRowBuilder().addComponents(commentBtn, confirmBtn, cancelBtn);

							const comps = [];
							if (totalPages > 1) {
								const topPagination = new ActionRowBuilder();
								if (page > 0) topPagination.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
								if (page < totalPages - 1) topPagination.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
								comps.push(topPagination);
							}
							comps.push(ruleRowDyn);
							comps.push(sevRowDyn);
							comps.push(controlRow);
							return comps;
						}

						const comps = buildWarnComps();

						try { await triggerInteraction.update({ embeds: [await buildHistoryEmbed(page)], components: comps }); } catch (err) { console.error('Failed to enter warn flow:', err); }

						try { if (innerCollector) innerCollector.stop(); } catch (e) {}
						innerCollector = messageRef.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });
						innerCollector.on('collect', async subI => {
							try {
								if (subI.customId === 'warn_rule_select') {
									selectedRule = subI.values && subI.values[0];
									try { await subI.deferUpdate(); } catch (e) {}
									return;
								}
								if (subI.customId === 'warn_severity_select') {
									selectedSeverity = subI.values && subI.values[0];
									try { await subI.deferUpdate(); } catch (e) {}
									return;
								}
								if (subI.customId === 'warn_add_comments') {
									// Use a modal customId that includes the originating message id and the initiator id
									const modalCustomId = `warnings_warn_comments_modal|${messageRef.id}|${interaction.user.id}`;
									const modal = new ModalBuilder().setCustomId(modalCustomId).setTitle('Additional Comments');
									const input = new TextInputBuilder().setCustomId('warn_comments_input').setLabel('Comments (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
									modal.addComponents(new ActionRowBuilder().addComponents(input));
									try {
										await subI.showModal(modal);
									} catch (e) {
										console.error('Failed to show comments modal:', e);
										await safeEphemeralReply(subI, 'Failed to open comments modal.');
									}
									return;
								}
								if (subI.customId === 'warn_confirm_final') {
									if (!selectedSeverity) {
										await safeEphemeralReply(subI, 'Please select a severity before confirming.');
										return;
									}
									const severityIdx = parseInt(selectedSeverity, 10) || 0;
									const muteTime = (warnSeverityMap && warnSeverityMap[severityIdx]) || severityMap[severityIdx] || 0;
									const muteMs = muteTime * 60 * 1000;
									let muteEnd = null;
									const targetMember = await subI.guild.members.fetch(user.id).catch(() => null);
									if (muteTime > 0 && targetMember) {
										try { await targetMember.timeout(muteMs, `Warn via /warnings by ${subI.user.tag}`); } catch (e) { /* ignore */ }
										muteEnd = Date.now() + muteMs;
									}
									// Prefer comments submitted via the modal (stored keyed by message id)
									const finalComments = pendingComments.get(messageRef.id) || comments;
									addMute(user.id, user.tag, subI.user.id, subI.user.tag, selectedRule, finalComments, severityIdx, muteTime, muteEnd);
									// Compute a human-friendly rule label: show 1-based index and full rule text when possible
									let ruleLabel = selectedRule || 'N/A';
									if (warnRules && Array.isArray(warnRules) && !isNaN(Number(selectedRule))) {
										const idx = Number(selectedRule);
										if (typeof warnRules[idx] === 'string') ruleLabel = `${idx + 1} - ${warnRules[idx]}`;
									}
									// Use the existing Reason field to show the rule number and description in the form:
									// "Rule X - <description>" for numeric indices, or "Rule - <value>" otherwise.
									let reasonText = 'Rule - N/A';
									if (warnRules && Array.isArray(warnRules) && !isNaN(Number(selectedRule))) {
										const idx = Number(selectedRule);
										if (typeof warnRules[idx] === 'string') {
											reasonText = `Rule ${idx + 1} - ${warnRules[idx]}`;
										} else {
											reasonText = `Rule ${idx + 1} - ${String(selectedRule)}`;
										}
									} else if (selectedRule) {
										reasonText = `Rule - ${String(selectedRule)}`;
									}

									// Build the log embed to match warn.js exactly (do not import, rewrite here)
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

									const severityLabel = `${warnFormatDurationLabel ? warnFormatDurationLabel(muteTime) : formatDuration(muteTime)} (${severityIdx})`;
									const titleName = user.tag || user.username || user.id;
									// No warnId available here, so omit or use blank
									const warnNumber = '';
									const logEmbed = new EmbedBuilder()
										.setTitle(`🛡️ Warn ${warnNumber} — ${titleName}`.trim())
										.setDescription(`Total Warns: ${totalWarns}`)
										.setColor(0xffa500)
										.addFields(
											{ name: 'User', value: `<@${user.id}>`, inline: true },
											{ name: 'Moderator', value: `<@${subI.user.id}>`, inline: true },
											{ name: '\u200B', value: '\u200B', inline: true },
											{ name: 'Reason', value: reasonText, inline: true },
											{ name: 'Severity', value: severityLabel, inline: true },
											{ name: '\u200B', value: '\u200B', inline: true }
										);
									if (finalComments && String(finalComments).trim().length) {s
										logEmbed.addFields({ name: 'Comments', value: String(finalComments).trim(), inline: false });
									}
									logEmbed.setTimestamp();

									// Build the public embed to match warn.js exactly
									const muteLengthLabel = muteTime > 0 ? formatDuration(muteTime) : 'No mute (verbal)';
									const publicEmbed = new EmbedBuilder()
										.setTitle(`🛡️ Moderation Action - User Warned`)
										.setColor(0xffa500)
										.addFields(
											{ name: 'User', value: `<@${user.id}>`, inline: true },
											{ name: 'Moderator', value: `<@${subI.user.id}>`, inline: true },
											{ name: '\u200B', value: '\u200B', inline: true },
											{ name: 'Reason', value: reasonText, inline: true },
											{ name: 'Mute Time', value: muteLengthLabel, inline: true },
											{ name: '\u200B', value: '\u200B', inline: true }
										);
									if (finalComments && String(finalComments).trim().length) {
										publicEmbed.addFields({ name: 'Comments', value: String(finalComments).trim(), inline: false });
									}
									publicEmbed.setTimestamp();
									try { await subI.channel.send({ embeds: [publicEmbed] }); } catch {}
									await sendToLogChannel(subI, logEmbed).catch(() => null);
									try { await subI.update({ content: `Warn confirmed`, components: [] }); } catch (e) { console.error('Failed to update after warn confirm:', e); }
									try { innerCollector.stop(); } catch (e) {}
									// cleanup any stored comments for this message
									try { pendingComments.delete(messageRef.id); } catch (e) {}
									createOuterCollector();
									return;
								}
								if (subI.customId === 'warn_cancel') {
									const newTotal = Math.max(1, Math.ceil(history.length / pageSize));
									if (page >= newTotal) page = newTotal - 1;
									const restoredEmbed = await buildHistoryEmbed(page);
									const outComps = [];
									if (newTotal > 1) {
										const topPagination = new ActionRowBuilder();
										if (page > 0) topPagination.addComponents(new ButtonBuilder().setCustomId('history_prev').setLabel('Prev Page').setStyle(ButtonStyle.Secondary));
										if (page < newTotal - 1) topPagination.addComponents(new ButtonBuilder().setCustomId('history_next').setLabel('Next Page').setStyle(ButtonStyle.Secondary));
										outComps.push(topPagination);
									}
									outComps.push(makeMainButtons());
									try { await subI.update({ embeds: [restoredEmbed], components: outComps }); } catch (err) { console.error('Failed to restore after warn cancel:', err); }
									try { innerCollector.stop(); } catch (e) {}
									createOuterCollector();
									return;
								}
							} catch (err) { console.error('Error in warn flow:', err); }
						});
						innerCollector.on('end', () => {
							innerCollector = null;
							try { createOuterCollector(); } catch (e) {}
						});
					}

				// start the first outer collector
				createOuterCollector();
		} catch (err) {
			console.error('Error in /warnings execute:', err);
			try {
				// prefer followUp if the interaction may already be acknowledged
				try { await interaction.followUp({ content: 'An error occurred while fetching history.', ephemeral: true }); } catch (e) {
					// if followUp fails because there was no prior acknowledgment, try reply
					try { await interaction.reply({ content: 'An error occurred while fetching history.', ephemeral: true }); } catch (ee) { /* ignore */ }
				}
			} catch {}
		}
	}
};

// Handle modal submits routed from the central interactionCreate handler in towermodbot.js
module.exports.handleModal = async function(interaction) {
	try {
		if (!interaction.isModalSubmit()) return;
		const cid = interaction.customId || '';
		// modal customId format: warnings_warn_comments_modal|<messageId>|<initiatorId>
		if (!cid.startsWith('warnings_warn_comments_modal|')) return;
		const parts = cid.split('|');
		const messageId = parts[1] || null;
		const initiatorId = parts[2] || null;
		// Only allow the original initiator to submit comments for this flow
		if (initiatorId && interaction.user.id !== initiatorId) {
			// acknowledge silently with an ephemeral reply
			try { await interaction.reply({ content: 'This modal is not for you.', ephemeral: true }); } catch (e) {}
			return;
		}
		const val = interaction.fields.getTextInputValue('warn_comments_input') || null;
		if (messageId) pendingComments.set(messageId, val);
		// Acknowledge the modal submission using the library reply (ephemeral) — safe and single-use.
		try { await interaction.reply({ content: 'Comments saved.', ephemeral: true }); } catch (e) { console.error('Failed to ack comments modal:', e); }
	} catch (err) {
		console.error('Error in warnHistory.handleModal:', err);
		try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'Error processing modal.', ephemeral: true }); } catch (e) {}
	}
};
