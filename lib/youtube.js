// Per-user YouTube OAuth + playlist pushing. Unlike the legacy
// add_to_youtube_playlist.js (single shared account in youtube-tokens.json),
// this keys an encrypted refresh token per Discord user in the youtube_tokens
// table, so every user pushes to their OWN YouTube account.
const { google } = require('googleapis');
const db = require('../db');
const { encrypt, decrypt } = require('./crypto');

// force-ssl, not the plain `youtube` scope: this bot shares ONE Google OAuth
// client with the martinbarker.me site (RipTag / Listogs), and that client is
// verified for force-ssl. Verification is scope-specific, so requesting a scope
// outside the approved list would put users back on the unverified-app screen.
// force-ssl is full read/write and covers everything used here (playlists
// list/insert, playlistItems list/insert, channels.list mine).
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

// A playlistItems.insert costs 50 quota units against the project's default
// 10,000/day allowance, so a single project can only add ~200 videos per day
// across all users. The UI shows this so a quota abort isn't a mystery.
const INSERT_QUOTA_COST = 50;
const PRIVACY_STATUSES = ['private', 'unlisted', 'public'];

const playlistUrl = id => `https://www.youtube.com/playlist?list=${id}`;

// The OAuth redirect must exactly match what's registered in the Google Cloud
// console. It points at the bot's own public callback (see api/server.js).
function redirectUri() {
  return (
    process.env.OAUTH_REDIRECT_URL ||
    `${process.env.BOT_PUBLIC_URL || 'http://localhost:3000'}/api/youtube/oauth/callback`
  );
}

function newOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GCP_CLIENT_ID,
    process.env.GCP_CLIENT_SECRET,
    redirectUri()
  );
}

// Build the Google consent URL. `state` is an opaque HMAC the caller verifies on
// callback (see api/server.js). access_type=offline + prompt=consent are what
// make Google return a refresh_token.
function buildAuthUrl(state) {
  return newOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    // No include_granted_scopes: incremental auth would fold any scope this
    // client was granted in the past (the legacy script asked for the broader
    // `youtube` scope) into the consent screen and the token, so the flow would
    // no longer show exactly the one verified scope.
  });
}

// Exchange an OAuth code, capture the refresh token, look up the channel, and
// persist (encrypted) keyed by Discord user id.
async function exchangeCodeAndStore(code, discordUserId) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh_token (re-consent required).');
  }
  client.setCredentials(tokens);

  let channelId = null;
  let channelName = null;
  try {
    const yt = google.youtube({ version: 'v3', auth: client });
    const me = await yt.channels.list({ part: ['snippet'], mine: true });
    const ch = me.data.items?.[0];
    if (ch) {
      channelId = ch.id;
      channelName = ch.snippet?.title || null;
    }
  } catch (e) {
    console.warn('[youtube] could not fetch channel info:', e.message);
  }

  await db.query(
    `INSERT INTO youtube_tokens (discord_user_id, refresh_token, youtube_channel_id, youtube_channel_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (discord_user_id) DO UPDATE
     SET refresh_token = $2, youtube_channel_id = $3, youtube_channel_name = $4`,
    [discordUserId, encrypt(tokens.refresh_token), channelId, channelName]
  );

  return { channelId, channelName };
}

// Returns true if the user has a stored YouTube connection.
async function hasYouTubeTokens(discordUserId) {
  const { rows } = await db.query(
    'SELECT 1 FROM youtube_tokens WHERE discord_user_id = $1',
    [discordUserId]
  );
  return rows.length > 0;
}

// The connected channel, or null. Used to prove a chosen playlist is the user's.
async function getYouTubeChannel(discordUserId) {
  const { rows } = await db.query(
    'SELECT youtube_channel_id, youtube_channel_name FROM youtube_tokens WHERE discord_user_id = $1',
    [discordUserId]
  );
  if (!rows[0]) return null;
  return { id: rows[0].youtube_channel_id, name: rows[0].youtube_channel_name };
}

// Build an authenticated YouTube client for a user from their stored refresh
// token. Returns null if the user hasn't connected.
async function youtubeClientFor(discordUserId) {
  const { rows } = await db.query(
    'SELECT refresh_token FROM youtube_tokens WHERE discord_user_id = $1',
    [discordUserId]
  );
  if (!rows[0]) return null;
  const refreshToken = decrypt(rows[0].refresh_token);
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.youtube({ version: 'v3', auth: client });
}

// Sign the user out: revoke the refresh token at Google (so the grant also
// disappears from their Google account permissions) and delete our copy.
// Revocation is best-effort — an already-revoked or expired token still gets
// removed locally. Returns false if there was nothing to disconnect.
async function disconnectYouTube(discordUserId) {
  const { rows } = await db.query(
    'SELECT refresh_token FROM youtube_tokens WHERE discord_user_id = $1',
    [discordUserId]
  );
  if (!rows[0]) return false;
  try {
    await newOAuthClient().revokeToken(decrypt(rows[0].refresh_token));
  } catch (e) {
    console.warn('[youtube] token revoke failed (removing locally anyway):', e.message);
  }
  await db.query('DELETE FROM youtube_tokens WHERE discord_user_id = $1', [discordUserId]);
  return true;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

// Reasons that make the *rest* of the run pointless — every remaining insert
// would fail the same way, so the push aborts instead of burning quota and
// writing N identical failures.
const FATAL_REASONS = {
  quotaExceeded: "YouTube's daily API quota for this app is exhausted. It resets at midnight Pacific Time — try again then.",
  dailyLimitExceeded: "YouTube's daily API quota for this app is exhausted. It resets at midnight Pacific Time — try again then.",
  playlistNotFound: 'That playlist no longer exists. Pick another one or create a new playlist.',
  playlistItemsNotAccessible: "You don't have permission to add videos to that playlist. Pick one owned by the connected channel.",
  playlistContainsMaximumNumberOfVideos: 'That playlist is full — YouTube caps playlists at 5,000 videos. Create a new one.',
  playlistOperationUnsupported: "That playlist can't be modified (YouTube blocks edits to auto-generated playlists like Liked Videos).",
  invalid_grant: 'Your YouTube connection expired. Click "Reconnect YouTube" and try again.',
  authError: 'Your YouTube connection expired. Click "Reconnect YouTube" and try again.',
};

// Reasons that are worth waiting out: YouTube is throttling us or briefly down.
const TRANSIENT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError',
  'SERVICE_UNAVAILABLE',
]);

// Per-video problems that don't say anything about the next video.
const PERMANENT_ITEM_REASONS = {
  videoNotFound: 'Video was deleted or made private.',
  forbidden: 'The video owner blocked adding it to playlists.',
  invalidVideoId: 'Not a valid YouTube video id.',
  manualSortRequired: "The playlist's sort order must be set to manual before videos can be added.",
};

// Normalize a googleapis error into { reason, status, message, transient, fatal }.
// googleapis buries the reason in a couple of different places depending on the
// transport, hence the chain.
function classifyError(err) {
  const status = Number(err?.code) || err?.response?.status || err?.status || 0;
  const apiError = err?.response?.data?.error;
  const reason =
    err?.reason || // set by our own pre-flight checks (e.g. assertOwnedPlaylist)
    err?.errors?.[0]?.reason ||
    apiError?.errors?.[0]?.reason ||
    apiError?.status ||
    err?.response?.data?.error_description ||
    (typeof err?.code === 'string' ? err.code : null) ||
    null;

  // A revoked/expired refresh token surfaces as invalid_grant from the token
  // endpoint, not the API, so it has no `reason` — match on the message.
  const isAuth =
    reason === 'invalid_grant' ||
    /invalid_grant|Token has been expired or revoked/i.test(err?.message || '');

  const rateLimited =
    status === 429 || TRANSIENT_REASONS.has(reason) || reason === 'rateLimitExceeded';

  const transient = !isAuth && (rateLimited || status >= 500);
  const fatalReason = isAuth ? 'invalid_grant' : reason;
  const fatal = !transient && Object.hasOwn(FATAL_REASONS, fatalReason || '');

  const message =
    FATAL_REASONS[fatalReason] ||
    PERMANENT_ITEM_REASONS[reason] ||
    apiError?.message ||
    err?.message ||
    'Unknown YouTube error';

  return { reason: fatalReason || 'unknown', status, message, transient, fatal, rateLimited };
}

// ---------------------------------------------------------------------------
// Playlist resolution
// ---------------------------------------------------------------------------

// Every playlist owned by the connected channel, newest first. Costs 1 quota
// unit per page of 50 (vs 50 for a single insert), so paging is cheap. The
// results page asks for up to 100 pages (5,000 playlists) so none are hidden.
async function listPlaylists(discordUserId, { maxPages = 5 } = {}) {
  const youtube = await youtubeClientFor(discordUserId);
  if (!youtube) return null;

  const out = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const res = await youtube.playlists.list({
      part: ['snippet', 'status', 'contentDetails'],
      mine: true,
      maxResults: 50,
      pageToken,
    });
    for (const p of res.data.items || []) {
      out.push({
        id: p.id,
        title: p.snippet?.title || '(untitled)',
        description: p.snippet?.description || '',
        privacyStatus: p.status?.privacyStatus || 'private',
        itemCount: p.contentDetails?.itemCount ?? 0,
        publishedAt: p.snippet?.publishedAt || null,
        url: playlistUrl(p.id),
      });
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// Every video id currently in a playlist, as a Set. Used to skip re-adding
// videos that are already there — including ones added outside this scan or by
// hand — so a push never creates duplicate entries. Costs 1 quota unit per page
// of 50 (vs 50 per insert), so scanning even a big playlist is cheap.
async function listPlaylistVideoIds(youtube, playlistId, { maxPages = 100 } = {}) {
  const ids = new Set();
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const res = await youtube.playlistItems.list({
      part: ['contentDetails'],
      playlistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of res.data.items || []) {
      const videoId = item.contentDetails?.videoId;
      if (videoId) ids.add(videoId);
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

async function savePlaylistForScan(scanJobId, discordUserId, id, title) {
  await db.query(
    `INSERT INTO scan_playlists (scan_job_id, discord_user_id, youtube_playlist_id, youtube_playlist_title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scan_job_id, discord_user_id) DO UPDATE
     SET youtube_playlist_id = $3, youtube_playlist_title = $4`,
    [scanJobId, discordUserId, id, title]
  );
}

// The playlist previously used for this (scan, user), or null.
async function getSavedPlaylist(scanJobId, discordUserId) {
  const { rows } = await db.query(
    `SELECT youtube_playlist_id AS id, youtube_playlist_title AS title
     FROM scan_playlists WHERE scan_job_id = $1 AND discord_user_id = $2`,
    [scanJobId, discordUserId]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, title: rows[0].title, url: playlistUrl(rows[0].id) };
}

// Confirm a user-supplied playlist id exists AND belongs to the connected
// channel. Without the ownership check a user could point the push at someone
// else's public playlist id and get a confusing 403 mid-run.
async function assertOwnedPlaylist(youtube, discordUserId, id) {
  const res = await youtube.playlists.list({ part: ['snippet', 'status', 'contentDetails'], id: [id] });
  const found = res.data.items?.[0];
  if (!found) {
    const err = new Error(FATAL_REASONS.playlistNotFound);
    err.reason = 'playlistNotFound';
    throw err;
  }
  const channel = await getYouTubeChannel(discordUserId);
  if (channel?.id && found.snippet?.channelId && found.snippet.channelId !== channel.id) {
    const err = new Error(FATAL_REASONS.playlistItemsNotAccessible);
    err.reason = 'playlistItemsNotAccessible';
    throw err;
  }
  return {
    id: found.id,
    title: found.snippet?.title || '(untitled)',
    description: found.snippet?.description || '',
    privacyStatus: found.status?.privacyStatus || 'private',
    itemCount: found.contentDetails?.itemCount ?? 0,
    publishedAt: found.snippet?.publishedAt || null,
    url: playlistUrl(found.id),
  };
}

// Look up one playlist by id for the results page's "paste a link or ID" box.
// Same ownership rule as a push, so a pasted id that would fail mid-run is
// rejected up front. Returns null when YouTube isn't connected.
async function getOwnedPlaylist(discordUserId, id) {
  const youtube = await youtubeClientFor(discordUserId);
  if (!youtube) return null;
  return assertOwnedPlaylist(youtube, discordUserId, id);
}

function sanitizeCreateOptions(create = {}) {
  // YouTube truncates past these limits server-side; trimming here keeps the
  // stored title in sync with what actually lands on YouTube.
  const title = String(create.title || '').trim().slice(0, 150);
  const description = String(create.description || '').slice(0, 5000);
  const privacyStatus = PRIVACY_STATUSES.includes(create.privacyStatus)
    ? create.privacyStatus
    : 'private';
  const tags = (Array.isArray(create.tags) ? create.tags : [])
    .map(s => String(s).trim())
    .filter(Boolean)
    .slice(0, 20);
  const defaultLanguage = create.defaultLanguage
    ? String(create.defaultLanguage).trim().slice(0, 10)
    : undefined;
  return { title, description, privacyStatus, tags, defaultLanguage };
}

async function createPlaylist(youtube, scanJobId, create) {
  const opts = sanitizeCreateOptions(create);
  const title = opts.title || `Trawl — scan ${scanJobId}`;
  const snippet = {
    title,
    description:
      opts.description ||
      'Created by Trawl (https://martinbarker.me/trawl).',
  };
  if (opts.tags.length) snippet.tags = opts.tags;
  if (opts.defaultLanguage) snippet.defaultLanguage = opts.defaultLanguage;

  const created = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: { snippet, status: { privacyStatus: opts.privacyStatus } },
  });
  return { id: created.data.id, title };
}

// Decide which playlist this push targets:
//   { playlistId }  → an existing playlist the user picked (ownership verified)
//   { create: {…} } → a brand-new playlist with the user's customizations
//   {}              → the one saved for this scan, else a new default playlist
// The choice is persisted so scheduled re-runs keep hitting the same playlist.
async function resolveTargetPlaylist(scanJobId, discordUserId, youtube, options = {}) {
  if (options.playlistId) {
    const found = await assertOwnedPlaylist(youtube, discordUserId, options.playlistId);
    await savePlaylistForScan(scanJobId, discordUserId, found.id, found.title);
    return { ...found, created: false, url: playlistUrl(found.id) };
  }

  if (options.create) {
    const made = await createPlaylist(youtube, scanJobId, options.create);
    await savePlaylistForScan(scanJobId, discordUserId, made.id, made.title);
    return { ...made, created: true, url: playlistUrl(made.id) };
  }

  const saved = await getSavedPlaylist(scanJobId, discordUserId);
  if (saved) return { ...saved, created: false };

  const made = await createPlaylist(youtube, scanJobId, {});
  await savePlaylistForScan(scanJobId, discordUserId, made.id, made.title);
  return { ...made, created: true, url: playlistUrl(made.id) };
}

// ---------------------------------------------------------------------------
// Pushing
// ---------------------------------------------------------------------------

// A stop was requested (the browser closed the SSE stream). Thrown so the loop
// can tell "user stopped" apart from a real insert failure and NOT mark the
// in-flight video as failed — it just stays pending for the next resume.
class PushAbortedError extends Error {
  constructor() {
    super('push stopped');
    this.name = 'PushAbortedError';
  }
}

// setTimeout that resolves early if `signal` aborts, so a Stop during a 30s
// backoff halts within milliseconds instead of stalling the whole run.
function abortableSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// Insert one video, backing off on throttling/5xx. `onRetry` lets the caller
// stream "we're rate limited, waiting Ns" to the browser instead of the UI
// silently stalling for up to 30s. videoAlreadyInPlaylist counts as success.
// If `signal` aborts (Stop / disconnect) during a backoff, throws PushAbortedError.
async function insertWithRetry(youtube, playlistId, videoId, onRetry = () => {}, attempt = 0, signal) {
  const MAX_ATTEMPTS = 5;
  if (signal?.aborted) throw new PushAbortedError();
  try {
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
      },
    });
    return 'inserted';
  } catch (err) {
    const info = classifyError(err);
    if (info.reason === 'videoAlreadyInPlaylist') return 'skipped';

    if (info.transient && attempt < MAX_ATTEMPTS) {
      const delayMs = Math.min(2 ** attempt * 1000 + Math.random() * 500, 30000);
      onRetry({
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS,
        delayMs: Math.round(delayMs),
        reason: info.reason,
        rateLimited: info.rateLimited,
      });
      await abortableSleep(delayMs, signal);
      if (signal?.aborted) throw new PushAbortedError();
      return insertWithRetry(youtube, playlistId, videoId, onRetry, attempt + 1, signal);
    }

    // Retries exhausted on a throttle → surface it as the rate limit it is,
    // and treat it as fatal so we stop hammering YouTube.
    err.classified = info.transient
      ? { ...info, fatal: true, message: `YouTube kept rate limiting us after ${MAX_ATTEMPTS} retries. Wait a few minutes and resume.` }
      : info;
    throw err;
  }
}

// Resumable push of every not-yet-inserted YouTube link for a scan to the
// target playlist. `emit(event, data)` streams progress (used by the SSE
// endpoint); for internal/scheduled use pass a no-op.
//
// Events: start, progress, retry, aborted, stopped, done, error.
// `options.signal` (AbortSignal) stops the run between videos when the browser
// disconnects. Returns { playlistId, inserted, failed, skipped, aborted, stopped }.
async function pushPendingToPlaylist(scanJobId, discordUserId, emit = () => {}, options = {}) {
  const signal = options.signal;
  const youtube = await youtubeClientFor(discordUserId);
  if (!youtube) {
    emit('error', { code: 'no_youtube', message: 'Connect a YouTube account first.' });
    return { error: 'no_youtube' };
  }

  let target;
  try {
    target = await resolveTargetPlaylist(scanJobId, discordUserId, youtube, options);
  } catch (err) {
    const info = classifyError(err);
    emit('error', { code: info.reason, message: info.message });
    return { error: info.reason };
  }

  // Playlist order. YouTube appends each inserted item to the *end* of the
  // playlist, so to land the newest-shared video on top we must insert newest
  // first — i.e. walk the extracted rows in DESC id order. 'oldest' flips it so
  // the oldest share sits on top. Value is validated to a literal, never
  // interpolated from raw user input.
  const orderSql = options.order === 'oldest' ? 'ASC' : 'DESC';

  // Scope "already inserted" to *this* playlist: switching targets must re-add
  // the tracks to the new playlist rather than skipping them as done.
  const { rows: todo } = await db.query(
    `SELECT el.media_id
     FROM extracted_links el
     LEFT JOIN playlist_items pi
       ON pi.scan_job_id = el.scan_job_id
      AND pi.media_id = el.media_id
      AND pi.discord_user_id = $1
      AND pi.youtube_playlist_id = $3
      AND pi.status IN ('inserted', 'skipped')
     WHERE el.scan_job_id = $2 AND el.platform = 'youtube' AND pi.id IS NULL
     ORDER BY el.id ${orderSql}`,
    [discordUserId, scanJobId, target.id]
  );

  emit('start', {
    total: todo.length,
    playlistId: target.id,
    playlistTitle: target.title,
    playlistUrl: target.url || playlistUrl(target.id),
    createdPlaylist: !!target.created,
    quotaCostPerInsert: INSERT_QUOTA_COST,
  });

  const record = (mediaId, status, error) =>
    db.query(
      `INSERT INTO playlist_items (scan_job_id, discord_user_id, media_id, youtube_playlist_id, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scan_job_id, discord_user_id, youtube_playlist_id, media_id) DO UPDATE
       SET status = $5, error = $6, attempts = playlist_items.attempts + 1`,
      [scanJobId, discordUserId, mediaId, target.id, status, error]
    );

  // Duplicate prevention (on by default): pull the video ids already in the
  // target playlist so we never insert one twice. YouTube's API happily adds a
  // duplicate playlist entry, so without this a video that's already in the
  // playlist — added by hand, by another scan, or before playlist_items tracked
  // it — would land a second time. A freshly created playlist is empty, so skip
  // the lookup. Pass options.allowDuplicates to opt out and add everything.
  let existingVideoIds = new Set();
  if (!options.allowDuplicates && !target.created) {
    try {
      existingVideoIds = await listPlaylistVideoIds(youtube, target.id);
    } catch (err) {
      // A failed contents fetch shouldn't sink the whole push; fall back to the
      // per-scan tracking + YouTube's own videoAlreadyInPlaylist skip.
      console.error('listPlaylistVideoIds failed; proceeding without dedupe:', err?.message || err);
    }
  }

  let inserted = 0;
  let failed = 0;
  let skipped = 0;
  let processed = 0;

  const stopSummary = () => ({
    reason: 'stopped',
    playlistId: target.id,
    playlistTitle: target.title,
    playlistUrl: target.url || playlistUrl(target.id),
    inserted,
    failed,
    skipped,
    remaining: todo.length - processed,
  });

  for (const { media_id } of todo) {
    // Honour a stop requested between videos before starting the next insert.
    if (signal?.aborted) {
      emit('stopped', stopSummary());
      return { playlistId: target.id, inserted, failed, skipped, aborted: null, stopped: true };
    }
    // Already in the playlist → record it as skipped without spending an insert
    // (50 quota units) or risking a duplicate entry.
    if (existingVideoIds.has(media_id)) {
      await record(media_id, 'skipped', null);
      skipped++;
      processed++;
      emit('progress', { mediaId: media_id, status: 'skipped' });
      continue;
    }
    try {
      const result = await insertWithRetry(
        youtube, target.id, media_id,
        retry => emit('retry', { mediaId: media_id, ...retry }),
        0, signal
      );
      await record(media_id, result, null);
      // Remember what we just landed so a repeated id later in this run (or a
      // retry-resume) is skipped rather than added again.
      if (result === 'inserted') existingVideoIds.add(media_id);
      if (result === 'skipped') skipped++;
      else inserted++;
      processed++;
      emit('progress', { mediaId: media_id, status: result });
    } catch (err) {
      // A stop mid-retry is not a failure: leave the video pending so a later
      // resume retries it, and end the run cleanly.
      if (err instanceof PushAbortedError || signal?.aborted) {
        emit('stopped', stopSummary());
        return { playlistId: target.id, inserted, failed, skipped, aborted: null, stopped: true };
      }
      const info = err.classified || classifyError(err);
      await record(media_id, 'failed', info.message);
      failed++;
      processed++;
      emit('progress', {
        mediaId: media_id,
        status: 'failed',
        reason: info.reason,
        message: info.message,
        rateLimited: info.rateLimited,
      });

      if (info.fatal) {
        emit('aborted', {
          reason: info.reason,
          message: info.message,
          rateLimited: info.rateLimited,
          playlistId: target.id,
          playlistUrl: target.url || playlistUrl(target.id),
          inserted,
          failed,
          skipped,
          remaining: todo.length - processed,
        });
        return { playlistId: target.id, inserted, failed, skipped, aborted: info.reason };
      }
    }
  }

  emit('done', {
    playlistId: target.id,
    playlistTitle: target.title,
    playlistUrl: target.url || playlistUrl(target.id),
    inserted,
    failed,
    skipped,
  });
  return { playlistId: target.id, inserted, failed, skipped, aborted: null, stopped: false };
}

module.exports = {
  SCOPES,
  INSERT_QUOTA_COST,
  PRIVACY_STATUSES,
  playlistUrl,
  buildAuthUrl,
  exchangeCodeAndStore,
  hasYouTubeTokens,
  getYouTubeChannel,
  disconnectYouTube,
  youtubeClientFor,
  listPlaylists,
  getOwnedPlaylist,
  listPlaylistVideoIds,
  getSavedPlaylist,
  resolveTargetPlaylist,
  classifyError,
  insertWithRetry,
  pushPendingToPlaylist,
};
