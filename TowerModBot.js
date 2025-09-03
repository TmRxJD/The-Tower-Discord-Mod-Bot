require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { token } = require('./config.json');
const event = require('./commands/utility/event.js');

const client = new Client({ intents: [
	GatewayIntentBits.Guilds,
	GatewayIntentBits.GuildMessages,
	GatewayIntentBits.GuildMessageTyping,
	GatewayIntentBits.GuildMessageReactions,
	GatewayIntentBits.MessageContent,
	GatewayIntentBits.GuildMembers
] });

client.cooldowns = new Collection();
client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

// Async function to load commands
async function loadCommands() {
	for (const folder of commandFolders) {
		const commandsPath = path.join(foldersPath, folder);
		const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
		for (const file of commandFiles) {
			const filePath = path.join(commandsPath, file);
			const command = require(filePath);
			if ('data' in command && 'execute' in command) {
				// Handle both sync and async data
				const commandData = typeof command.data === 'function' ? await command.data() : command.data;
				client.commands.set(commandData.name, command);
			} else {
				console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
			}
		}
	}
}

client.once(Events.ClientReady, async c => {
	// Load commands after client is ready
	await loadCommands();
	// Restore event listeners for active events with logging
	const db = require('sqlite3').verbose();
	const dbPath = require('path').join(__dirname, 'data/event_submissions.db');
	const restoreDb = new db.Database(dbPath);
	restoreDb.all('SELECT channelId, type FROM events WHERE active = 1', [], async (err, rows) => {
	  if (err || !rows || rows.length === 0) {
		console.log('No active events found');
	  } else {
		const eventList = rows.map(r => `Channel: ${r.channelId}, Type: ${r.type}`).join(' | ');
		console.log('Restoring Event Listeners for Active Events:', eventList);
	  }
	  await event.restoreActiveCollectors(client);
	  restoreDb.close();
	  console.log(`Ready! Logged in as ${c.user.tag}`);
	});
});

client.on(Events.InteractionCreate, async interaction => {
	if (interaction.isModalSubmit()) {
		try {
			const command = client.commands.get(interaction.customId.split('_')[0]);
			if (command && command.handleModal) {
				await command.handleModal(interaction);
			}
		} catch (error) {
			console.error(error);
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: 'There was an error processing your submission!', flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: 'There was an error processing your submission!', flags: MessageFlags.Ephemeral });
			}
		}
		return;
	}
	
	if (!interaction.isChatInputCommand()) return;
	const command = client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	const { cooldowns } = interaction.client;

	if (!cooldowns.has(command.data.name)) {
		cooldowns.set(command.data.name, new Collection());
	}

	const now = Date.now();
	const timestamps = cooldowns.get(command.data.name);
	const defaultCooldownDuration = 5;
	const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1000;

	if (timestamps.has(interaction.user.id)) {
		const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

		if (now < expirationTime) {
			const expiredTimestamp = Math.round(expirationTime / 1000);
			return interaction.reply({ content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`, flags: MessageFlags.Ephemeral });
		}
	}

	timestamps.set(interaction.user.id, now);
	setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
			}
		} catch (err) {
			console.error('Failed to send error response to interaction:', err);
		}
	}
});

client.login(token);