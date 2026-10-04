// Channel scanning → Postgres. Shared by the /trawl-makeplaylists command and the
// scheduler so both behave identically. Replaces the old file-based JSON flow.
const { ChannelType } = require('discord.js');
const db = require('../db');

// --- link extraction (ported from commands/makePlaylists.js) ---------------
const REGEX = {
  youtube: /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(?:embed\/)?(?:v\/)?(?:shorts\/)?[a-zA-Z0-9_-]+/g,
  spotify: /(?:https?:\/\/)?(?:open\.)?spotify\.com\/(track|album|playlist|artist)\/[a-zA-Z0-9]+/g,
  spotifyUri: /spotify:(track|album|playlist|artist):[a-zA-Z0-9]+/g,
  soundcloud: /(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/[^\/\s]+\/[^\/\s?]+/g,
  bandcamp: /(?:https?:\/\/)?[^.]+\.bandcamp\.com\/(?:track|album)\/[^\/\s?]+/g,
};

function extractYouTubeId(url) {
  const m = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(?:embed\/)?(?:v\/)?(?:shorts\/)?([a-zA-Z0-9_-]+)/);
  return m && m[1];
}
function extractSpotifyId(url) {
  const m = url.match(/(?:https?:\/\/)?(?:open\.)?spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/) ||
            url.match(/spotify:(track|album|playlist|artist):([a-zA-Z0-9]+)/);
  return m && `${m[1]}_${m[2]}`;
}
function extractSoundCloudId(url) {
  const m = url.match(/(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([^\/\s]+)\/([^\/\s?]+)/);
  return m && `${m[1]}_${m[2]}`;
}
function extractBandcampId(url) {
  const m = url.match(/(?:https?:\/\/)?([^.]+)\.bandcamp\.com\/(?:track|album)\/([^\/\s?]+)/);
  return m && `${m[1]}_${m[2]}`;
}

function matchAll(content, regex) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) out.push(m[0]);
  return out;
}

// Pull every (platform, media_id, url) tuple out of one message's text + embeds.
function linksFromMessage(message) {
  const found = [];
  const push = (platform, id, url) => { if (id) found.push({ platform, media_id: id, media_url: url.replace(/^https?:\/\//, '') }); };
  const text = message.content || '';

  matchAll(text, REGEX.youtube).forEach(l => push('youtube', extractYouTubeId(l), l));
  matchAll(text, REGEX.spotify).forEach(l => push('spotify', extractSpotifyId(l), l));
  matchAll(text, REGEX.spotifyUri).forEach(l => push('spotify', extractSpotifyId(l), l));
  matchAll(text, REGEX.soundcloud).forEach(l => push('soundcloud', extractSoundCloudId(l), l));
  matchAll(text, REGEX.bandcamp).forEach(l => push('bandcamp', extractBandcampId(l), l));

  (message.embeds || []).forEach(embed => {
    if (!embed.url) return;
    if (embed.url.match(REGEX.youtube)) push('youtube', extractYouTubeId(embed.url), embed.url);
    if (embed.url.match(REGEX.spotify)) push('spotify', extractSpotifyId(embed.url), embed.url);
    if (embed.url.match(REGEX.soundcloud)) push('soundcloud', extractSoundCloudId(embed.url), embed.url);
    if (embed.url.match(REGEX.bandcamp)) push('bandcamp', extractBandcampId(embed.url), embed.url);
  });

  return found;
}

// Ensure a guilds row exists.
async function ensureGuild(guildId, guildName) {
  await db.query(
    `INSERT INTO guilds (guild_id, guild_name) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET guild_name = $2`,
    [guildId, guildName]
  );
}

// Find or create the scan_job for (guild, input, output).
async function getOrCreateScanJob(guildId, inputChannelId, outputChannelId, initiatedByUserId) {
  const { rows } = await db.query(
    `INSERT INTO scan_jobs (guild_id, input_channel_id, output_channel_id, initiated_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id, input_channel_id, output_channel_id) DO UPDATE
       SET updated_at = NOW()
     RETURNING id, last_message_id`,
    [guildId, inputChannelId, outputChannelId, initiatedByUserId]
  );
  return rows[0];
}

// Scan a channel incrementally (since last_message_id) and persist links.
// Returns { scanJobId, newCount, totalCount }.
async function scanChannel({ inputChannel, outputChannel, guild, initiatedByUserId }) {
  if (!inputChannel || inputChannel.type !== ChannelType.GuildText) {
    throw new Error('input channel must be a text channel');
  }
  await ensureGuild(guild.id, guild.name);
  const job = await getOrCreateScanJob(guild.id, inputChannel.id, outputChannel.id, initiatedByUserId);
  const scanJobId = job.id;
  const lastMessageId = job.last_message_id;

  // Collect messages: forward from last_message_id if incremental, else all.
  let collected = [];
  let newestId = lastMessageId;
  let beforeId = null;

  while (true) {
    const options = { limit: 100 };
    if (lastMessageId) options.after = newestId || lastMessageId;
    else if (beforeId) options.before = beforeId;

    const batch = await inputChannel.messages.fetch(options);
    if (batch.size === 0) break;
    const arr = Array.from(batch.values());

    if (lastMessageId) {
      newestId = batch.last()?.id; // 'after' is ascending; last = newest
    } else {
      beforeId = batch.last()?.id;
    }
    collected = collected.concat(arr);
    if (batch.size < 100) break;
  }

  // Determine the new high-water message id.
  const newLastMessageId = lastMessageId
    ? (newestId || lastMessageId)
    : (collected.length ? collected[0].id : null);

  // Extract + dedupe in-memory, then upsert.
  let newCount = 0;
  for (const message of collected) {
    const links = linksFromMessage(message);
    for (const link of links) {
      const r = await db.query(
        `INSERT INTO extracted_links
           (scan_job_id, guild_id, platform, media_id, media_url, author_discord_id, author_username, source_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (scan_job_id, platform, media_id) DO NOTHING`,
        [scanJobId, guild.id, link.platform, link.media_id, link.media_url,
         message.author?.id || null, message.author?.username || null, message.id]
      );
      if (r.rowCount > 0) newCount++;
    }
  }

  if (newLastMessageId) {
    await db.query(
      'UPDATE scan_jobs SET last_message_id = $1, last_run_at = NOW() WHERE id = $2',
      [newLastMessageId, scanJobId]
    );
  } else {
    await db.query('UPDATE scan_jobs SET last_run_at = NOW() WHERE id = $1', [scanJobId]);
  }

  const { rows: cnt } = await db.query(
    'SELECT COUNT(*)::int AS total FROM extracted_links WHERE scan_job_id = $1',
    [scanJobId]
  );

  return { scanJobId, newCount, totalCount: cnt[0].total };
}

module.exports = { scanChannel, linksFromMessage };
