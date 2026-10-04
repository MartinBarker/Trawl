// HTTP API the website calls. Runs in the same process as the Discord client
// (started from start_discord_bot.js). Auth model:
//   • Browser-facing endpoints (SSE push, OAuth) are gated by the magic token.
//   • The site's server-side fetch of GET /api/scans/:id additionally presents
//     SITE_SHARED_SECRET via the x-site-secret header.
const express = require('express');
const db = require('../db');
const { verifyMagicToken } = require('../lib/magicToken');
const {
  buildAuthUrl,
  exchangeCodeAndStore,
  hasYouTubeTokens,
  getYouTubeChannel,
  disconnectYouTube,
  listPlaylists,
  getSavedPlaylist,
  pushPendingToPlaylist,
  classifyError,
  PRIVACY_STATUSES,
  INSERT_QUOTA_COST,
} = require('../lib/youtube');
const { encodeState, decodeState } = require('../lib/oauthState');

// Best-effort Discord channel/guild names for the results page's auto-add
// instructions. Never fails the request — the page falls back to raw ids.
async function resolveNames(discordClient, scanJob) {
  const names = { guildName: null, inputChannelName: null, outputChannelName: null };
  if (!discordClient) return names;
  const channelName = async id => {
    if (!id) return null;
    try {
      const ch = await discordClient.channels.fetch(id);
      return ch?.name || null;
    } catch {
      return null;
    }
  };
  try {
    const guild = await discordClient.guilds.fetch(scanJob.guild_id);
    names.guildName = guild?.name || null;
  } catch {}
  names.inputChannelName = await channelName(scanJob.input_channel_id);
  names.outputChannelName = await channelName(scanJob.output_channel_id);
  return names;
}

// Turn the SSE query string into the options bag pushPendingToPlaylist expects.
// EventSource can only issue GETs with no custom headers, so the playlist choice
// travels as query params.
function parsePushOptions(query) {
  // Which end of the playlist the newest-shared video lands on. Default 'newest'
  // puts the most recently shared track at the top (see ORDER BY in youtube.js).
  const order = query.order === 'oldest' ? 'oldest' : 'newest';

  // Duplicate prevention is on by default; the results page opts out by sending
  // allowDuplicates=1 when the user un-checks "skip videos already in playlist".
  const allowDuplicates = query.allowDuplicates === '1' || query.allowDuplicates === 'true';

  if (query.playlistId) return { playlistId: String(query.playlistId), order, allowDuplicates };
  if (query.mode !== 'new') return { order, allowDuplicates }; // resume: reuse whatever this scan already targets

  const privacyStatus = PRIVACY_STATUSES.includes(query.privacy) ? query.privacy : 'private';
  return {
    order,
    allowDuplicates,
    create: {
      title: query.title ? String(query.title) : '',
      description: query.description ? String(query.description) : '',
      privacyStatus,
      tags: query.tags ? String(query.tags).split(',') : [],
      defaultLanguage: query.language ? String(query.language) : undefined,
    },
  };
}

function createApiServer({ discordClient = null } = {}) {
  const app = express();
  app.use(express.json());

  // Permissive CORS: browsers on https://martinbarker.me open SSE/OAuth here.
  // The real auth is the signed magic token, not the origin.
  app.use((req, res, next) => {
    const origin = process.env.SITE_ORIGIN || '*';
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-site-secret');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Liveness probe for ALB / UptimeRobot.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Optional shared-secret gate for server-to-server calls. The browser can't
  // send the header, so we only enforce it when the header is present at all
  // OR when explicitly required for this route.
  function requireSiteSecret(req, res, next) {
    const expected = process.env.SITE_SHARED_SECRET;
    if (!expected) return next(); // not configured → skip (dev)
    if (req.get('x-site-secret') !== expected) {
      return res.status(401).json({ error: 'bad site secret' });
    }
    next();
  }

  // Scan results for the website results page (server-side render).
  app.get('/api/scans/:id', requireSiteSecret, verifyMagicToken, async (req, res) => {
    try {
      const { rows: jobRows } = await db.query(
        `SELECT id, guild_id, input_channel_id, output_channel_id, initiated_by_user_id,
                cron_expression, is_active, last_run_at, created_at
         FROM scan_jobs WHERE id = $1`,
        [req.scanJobId]
      );
      const scanJob = jobRows[0];
      if (!scanJob) return res.status(404).json({ error: 'scan not found' });

      const { rows: tracks } = await db.query(
        `SELECT platform, media_id, media_url, author_username, source_message_id, extracted_at
         FROM extracted_links
         WHERE scan_job_id = $1
         ORDER BY id ASC`,
        [req.scanJobId]
      );

      const alreadyConnected = await hasYouTubeTokens(req.discordUserId);
      const targetPlaylist = await getSavedPlaylist(req.scanJobId, req.discordUserId);
      const youtubeChannel = alreadyConnected ? await getYouTubeChannel(req.discordUserId) : null;

      // Prior push outcome per video, scoped to the playlist this scan targets,
      // so a reloaded page shows which links already landed and which errored.
      let itemStatuses = {};
      if (targetPlaylist) {
        const { rows } = await db.query(
          `SELECT media_id, status, error, attempts
           FROM playlist_items
           WHERE scan_job_id = $1 AND discord_user_id = $2 AND youtube_playlist_id = $3`,
          [req.scanJobId, req.discordUserId, targetPlaylist.id]
        );
        itemStatuses = Object.fromEntries(
          rows.map(r => [r.media_id, { status: r.status, error: r.error, attempts: r.attempts }])
        );
      }

      res.json({
        tracks,
        alreadyConnected,
        scanJob,
        youtubeChannel,
        targetPlaylist,
        itemStatuses,
        quotaCostPerInsert: INSERT_QUOTA_COST,
        discord: await resolveNames(discordClient, scanJob),
      });
    } catch (err) {
      console.error('GET /api/scans/:id failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // The connected channel's playlists, so the user can add to an existing one
  // instead of always creating a new playlist.
  app.get('/api/scans/:id/youtube/playlists', verifyMagicToken, async (req, res) => {
    try {
      const playlists = await listPlaylists(req.discordUserId);
      if (playlists === null) return res.status(409).json({ error: 'no_youtube' });
      res.json({ playlists, channel: await getYouTubeChannel(req.discordUserId) });
    } catch (err) {
      const info = classifyError(err);
      console.error('GET /api/scans/:id/youtube/playlists failed:', err);
      res.status(info.reason === 'quotaExceeded' ? 429 : 500)
        .json({ error: info.reason, message: info.message });
    }
  });

  // Sign out of YouTube: revoke the grant at Google and forget the stored token.
  // Scheduled auto-add runs for this user stop working until they reconnect.
  app.post('/api/scans/:id/youtube/disconnect', verifyMagicToken, async (req, res) => {
    try {
      const removed = await disconnectYouTube(req.discordUserId);
      res.json({ ok: true, removed });
    } catch (err) {
      console.error('POST /api/scans/:id/youtube/disconnect failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // SSE stream that pushes pending YouTube videos to the chosen playlist.
  // EventSource is GET-only, so this is GET (not POST as some docs show).
  app.get('/api/scans/:id/push', verifyMagicToken, async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let the reverse proxy buffer the stream
    });
    res.flushHeaders?.();

    // When the browser closes the stream (Stop button, refresh, or tab close)
    // the socket 'close' fires; abort so the push loop halts between videos
    // instead of running on invisibly to completion. `finished` guards against
    // the 'close' we ourselves trigger with res.end() on normal completion.
    let finished = false;
    const ac = new AbortController();
    res.on('close', () => { if (!finished) ac.abort(); });

    const emit = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await pushPendingToPlaylist(
        req.scanJobId,
        req.discordUserId,
        emit,
        { ...parsePushOptions(req.query), signal: ac.signal }
      );
    } catch (err) {
      console.error('push failed:', err);
      const info = classifyError(err);
      emit('error', { code: info.reason || 'push_failed', message: info.message });
    } finally {
      finished = true;
      res.end();
    }
  });

  // Begin YouTube OAuth. Nested under /scans/:id so verifyMagicToken can match
  // the token against the scan. Redirects to Google with a signed state
  // carrying (scanJobId, discordUserId).
  app.get('/api/scans/:id/youtube/oauth/start', verifyMagicToken, (req, res) => {
    const state = encodeState(req.scanJobId, req.discordUserId);
    res.redirect(buildAuthUrl(state));
  });

  // Google redirects here after consent. Verify state, exchange the code, store
  // the encrypted refresh token, and render a self-closing confirmation page.
  app.get('/api/youtube/oauth/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;
      if (error) throw new Error(`Google returned error: ${error}`);
      const { discordUserId } = decodeState(state);
      await exchangeCodeAndStore(code, discordUserId);
      res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>YouTube connected</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;">
  <h2>✅ YouTube connected</h2>
  <p>You can close this window and return to the results page.</p>
  <script>
    try { if (window.opener) { window.opener.postMessage({ type: 'youtube-connected' }, '*'); } } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch (e) {} }, 1500);
  </script>
</body></html>`);
    } catch (err) {
      console.error('OAuth callback failed:', err);
      res.status(400).set('Content-Type', 'text/html').send(
        `<!doctype html><body style="font-family:sans-serif;text-align:center;padding:60px;">
         <h2>❌ Couldn't connect YouTube</h2><p>${err.message}</p></body>`
      );
    }
  });

  return app;
}

module.exports = { createApiServer };
