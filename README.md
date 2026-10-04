# Discord2Playlist

A Discord bot that scrapes music links (YouTube, Spotify, SoundCloud, Bandcamp) from Discord channels, deduplicates them, and generates YouTube playlists. Supports scheduled auto-runs via cron and syncs directly to YouTube playlists via the YouTube Data API.

---

## Table of Contents

1. [Quick Start (Local Dev)](#quick-start-local-dev)
2. [Discord Commands](#discord-commands)
3. [Project Layout](#project-layout)

---

## Quick Start (Local Dev)

### Create the Discord application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Create a new bot.
3. Under **General Information**, copy **Application ID** → save to `.env` as `DISCORD_CLIENT_ID`.
4. Under **Bot**:
   - Click **Reset Token** → save to `.env` as `DISCORD_TOKEN`.
   - Add permissions: `Send Messages`, `Read Message History`.
   - Enable all 3 **Privileged Gateway Intents**.
5. Under **OAuth2**, build an invite URL with scopes `bot` + `applications.commands` and permissions `Send Messages` + `Read Message History`. Choose **Guild Install** and copy the generated URL.
6. Use the URL to invite Discord2Playlist to your Discord server.

### Run locally

```bash
git clone <this-repo>
cd <this-repo>
npm install
cp .env-template-new .env       # then fill in Discord + YouTube keys
npm run deploy                  # register slash commands with Discord
npm start                       # boot the bot
```

### YouTube API setup

1. Create a Google Cloud project, enable **YouTube Data API v3**.
2. In the OAuth2 tab, copy `GCP_CLIENT_ID` and `GCP_CLIENT_SECRET` → save to `.env`.
3. (For one-shot pushes) set `YOUTUBE_PLAYLIST_ID` in your script and run `node add_to_youtube_playlist.js`.
4. (For scheduled sync) run `npm run youtube:sync` — defaults to every hour, or pass a cron: `npm run youtube:sync -- "*/30 * * * *"`.

### Database (optional locally)

If you want the local bot to use Postgres (instead of writing JSON files), set `DATABASE_URL` in `.env`. The schema lives in [`db/schema.sql`](db/schema.sql). To apply it:

```bash
npm run db:migrate
```

Without `DATABASE_URL`, the bot falls back to the JSON-file behavior documented below.

---

## Discord Commands

All commands are prefixed with `trawl-`, so typing `/trawl` in Discord lists them all.

| Command | Purpose |
|---|---|
| `/trawl-makeplaylists [input_channel] [output_channel]` | Scan a channel for music links (YouTube/Spotify/SoundCloud/Bandcamp), save them to Postgres, and post a magic link to the results page where you can push them to a YouTube playlist |
| `/trawl-schedule input_channel cadence` | Re-run a channel's scan hourly / every 6h / daily / weekly (or `off`) and auto-push new links to YouTube |
| `/trawl-stop` | Stop all scheduled scans in this server |
| `/trawl-version` | Print the bot's running version |

Example:

```
/trawl-makeplaylists input_channel:#music-share output_channel:#debug_out
```

---

## Project Layout

```
.
├── start_discord_bot.js          # entrypoint — boots discord.js client + Express
├── deploy_discord_commands.js    # registers slash commands with Discord
├── add_to_youtube_playlist.js    # one-shot: read JSON, push to YouTube
├── youtube-sync-scheduler.js     # standalone cron wrapper around the above
├── commands/
│   ├── makePlaylists.js          # /trawl-makeplaylists handler
│   ├── schedule.js               # /trawl-schedule handler
│   ├── stop.js                   # /trawl-stop handler
│   └── version.js                # /trawl-version handler
├── db/
│   ├── schema.sql                # Postgres schema (guilds, scan_jobs, etc.)
│   ├── migrate.js                # applies schema.sql
│   ├── index.js                  # pg Pool wrapper
│   └── queries.js                # query helpers
├── Dockerfile                    # production image — see deploy guide
└── package.json
```

---

For everything else — production deployment, CI/CD, the web magic-link flow, retry behavior, and the `/trawl-schedule` command — see the **[deploy guide in martinbarker.me](https://github.com/MartinBarker/martinbarker.me/blob/main/discord2playlist_deploy_guide.md)**.
