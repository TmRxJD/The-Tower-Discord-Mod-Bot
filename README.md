# The Tower Discord Mod Bot

Lightweight moderation and utility bot used in The Tower Discord server. 

## Quick start

- Node.js (14+ recommended) environment
- Install dependencies: run your package manager (project already has `package.json`)
- Ensure the `data/` directory is writable — the bot uses several sqlite DB files there.
- Configure `config.json` with your bot token and any other secrets (not included in repo).

## Important files

- `TowerModBot.js` — main bot launcher
- `deploy-commands.js` — registers slash commands with Discord
- `config.json` — runtime configuration (tokens, IDs)
- `commands/utility/*.js` — slash command implementations (documented below)
- `data/*.db` — sqlite databases used by various features (moderation, events, move settings)

## Commands (scanned)

Below are the slash commands found in `commands/utility` with a short description and options.

- `/warn` — Warn or mute a user (no UI)
  - Options:
    - `user` (user, required) — User to warn/mute
    - `rule` (string, required) — Rule violated (choices populated from built-in rules)
    - `severity` (integer, optional) — Severity index (maps to mute durations)
    - `reason` (string, optional) — Free-text reason (appended to rule)
  - Notes: Mod-only (requires ModerateMembers permission or configured role). Stores entries in `data/moderation.db` table `mutes`. Public and log embeds are generated; when severity > 0 the target member is muted via Discord timeout.

- `/warnings` — Show warning/mute history for a user (interactive UI)
  - Options:
    - `user` (user, required) — User to view history for
  - Notes: Mod-only. Presents paginated history, supports: Warn flow (rule + severity + comments modal), Extend Mute, and Remove Warning flows. Uses the same embed formatting as `/warn` for public and log messages. Modal submissions are handled by `handleModal` export in the module.

- `/spendcheck` — Check a player's purchase and booster history
  - Options:
    - `playerid` (string, required) — Player ID to check
  - Notes: Restricted by role or specific allowed user ID. Fetches data from a configured external API and formats purchase/booster info.

- `/move` — Send a polite move message to an approved off-topic channel
  - Options:
    - `channel` (string, required) — Choice of configured approved channel names (choices populated from DB)
  - Notes: Mod-only. Approved channels and ping role are configured via `/move_settings`. Logs the move and saves history in `data/move_settings.db`.

- `/move_settings` — Configure approved channels, ping role, and log channel for the move command
  - Options: none (interactive UI)
  - Notes: Mod-only. Presents an ephemeral UI to configure approved channels, ping role, and log channel. Supports pagination for large server channel lists and allows creating/claiming a Move role.

- `/mods` — Notify moderators (quick notify)
  - Options:
    - `reason` (string, required) — Why mods are needed
  - Notes: Notifies the configured mods channel/role (configured with `/mods_settings`). Saves a small history (re-uses move history table) and logs to the configured log channel.

- `/mods_settings` — Configure mods notification channel and role
  - Options:
    - `channel` (channel, optional) — Channel to post mod requests in
    - `role` (role, optional) — Role to ping for mod requests
    - `log_channel` (channel, optional) — Channel to send audit logs to
  - Notes: Requires ManageGuild or ModerateMembers (or configured allowed role). Persists settings to `data/move_settings.db`.

- `/event` — Manage server events (subcommands)
  - Subcommands:
    - `start` — Start an event (type + theme)
    - `end` — End an event (type)
    - `make_polls` — Create voting polls for active Pun events
    - `add_reactions` — Add reaction/pogcat for Meme events
  - Notes: Events are stored in `data/event_submissions.db` with a `submissions` table. The module supports running collectors to accept submissions (Pun/Meme formats), creating polls and tallying votes.

## Databases

- `data/moderation.db` — stores `mutes` (warns/mutes) and log channel config
- `data/move_settings.db` — stores approved channels, ping role, log channel, and move history
- `data/event_submissions.db` — stores events and submissions for the event system

Keep DB files out of version control; they are included in `.gitignore`.

## Notes & operational hints

- Many moderation commands require the bot to have `ModerateMembers` permission to apply timeouts.
- The interactive flows use message component collectors and modals; collectors run for a limited time (typically 5 minutes) and UI actions are ephemeral when appropriate.
- The repo uses CommonJS modules (require/module.exports) and discord.js builders for registering commands. `deploy-commands.js` is used to register the commands with Discord.
- If you add new commands, follow the existing pattern: export a `data` SlashCommandBuilder and an `execute(interaction)` function.

