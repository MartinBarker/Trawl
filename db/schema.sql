-- discord2playlist schema. Idempotent — safe to run repeatedly (CREATE ... IF NOT EXISTS).
-- Applied via `npm run db:migrate` (db/migrate.js).

-- Guilds (Discord servers) using Discord2Playlist
CREATE TABLE IF NOT EXISTS guilds (
    guild_id        TEXT PRIMARY KEY,
    guild_name      TEXT,
    tier            TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'team')),
    stripe_customer_id TEXT,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scan jobs: each /trawl-makeplaylists run creates or updates one of these
CREATE TABLE IF NOT EXISTS scan_jobs (
    id                  SERIAL PRIMARY KEY,
    guild_id            TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    input_channel_id    TEXT NOT NULL,
    output_channel_id   TEXT NOT NULL,
    output_message_id   TEXT,
    initiated_by_user_id TEXT NOT NULL,
    youtube_sync_mode   TEXT NOT NULL DEFAULT 'admin-only'
        CHECK (youtube_sync_mode IN ('admin-only', 'anyone', 'role')),
    youtube_sync_role_id TEXT,
    last_message_id     TEXT,
    cron_expression     TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    last_run_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (guild_id, input_channel_id, output_channel_id)
);

-- Magic tokens for unauthenticated web access
CREATE TABLE IF NOT EXISTS magic_tokens (
    token_id         TEXT PRIMARY KEY,
    scan_job_id      INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    discord_user_id  TEXT NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked          BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extracted media links
CREATE TABLE IF NOT EXISTS extracted_links (
    id                  SERIAL PRIMARY KEY,
    scan_job_id         INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    guild_id            TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
    platform            TEXT NOT NULL
        CHECK (platform IN ('youtube', 'spotify', 'soundcloud', 'bandcamp')),
    media_id            TEXT NOT NULL,
    media_url           TEXT,
    author_discord_id   TEXT,
    author_username     TEXT,
    source_message_id   TEXT,
    extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scan_job_id, platform, media_id)
);

-- Per-user YouTube OAuth tokens (refresh_token encrypted at rest)
CREATE TABLE IF NOT EXISTS youtube_tokens (
    discord_user_id  TEXT PRIMARY KEY,
    refresh_token    BYTEA NOT NULL,
    youtube_channel_id   TEXT,
    youtube_channel_name TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-(scan, user, playlist, video) push status — drives the retry/resume logic
CREATE TABLE IF NOT EXISTS playlist_items (
    id                  SERIAL PRIMARY KEY,
    scan_job_id         INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    discord_user_id     TEXT NOT NULL,
    media_id            TEXT NOT NULL,
    youtube_playlist_id TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'inserted', 'failed', 'skipped')),
    error               TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness includes the playlist: a user may push the same scan to more than
-- one playlist, and "already inserted" is only true per target playlist.
--
-- Pre-existing databases still carry the old UNIQUE (scan_job_id,
-- discord_user_id, media_id) constraint, which would reject the second
-- playlist. Drop it by matching its columns rather than its generated name.
DO $migrate_playlist_items$
DECLARE
    old_constraint TEXT;
BEGIN
    SELECT c.conname INTO old_constraint
    FROM pg_constraint c
    WHERE c.conrelid = 'playlist_items'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname ORDER BY a.attname)
        FROM unnest(c.conkey) AS k
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
      ) = ARRAY['discord_user_id', 'media_id', 'scan_job_id']::name[]
    LIMIT 1;

    IF old_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE playlist_items DROP CONSTRAINT %I', old_constraint);
    END IF;
END
$migrate_playlist_items$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_playlist_items_scan_user_playlist_media
    ON playlist_items(scan_job_id, discord_user_id, youtube_playlist_id, media_id);

-- Stores the resolved YouTube playlist per (scan_job, user) so re-runs
-- and scheduled pushes target the same playlist.
CREATE TABLE IF NOT EXISTS scan_playlists (
    scan_job_id         INTEGER NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    discord_user_id     TEXT NOT NULL,
    youtube_playlist_id TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scan_job_id, discord_user_id)
);

-- Cached title of the target playlist, so the results page can name it without
-- spending a YouTube API call on every page load.
ALTER TABLE scan_playlists ADD COLUMN IF NOT EXISTS youtube_playlist_title TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scan_jobs_guild
    ON scan_jobs(guild_id);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_active_cron
    ON scan_jobs(is_active, cron_expression)
    WHERE is_active = true AND cron_expression IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extracted_links_job
    ON extracted_links(scan_job_id);
CREATE INDEX IF NOT EXISTS idx_magic_tokens_scan
    ON magic_tokens(scan_job_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_scan_user
    ON playlist_items(scan_job_id, discord_user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_status
    ON playlist_items(scan_job_id, status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers (dropped first so re-running the schema doesn't error on duplicates)
DROP TRIGGER IF EXISTS trg_guilds_updated_at ON guilds;
CREATE TRIGGER trg_guilds_updated_at         BEFORE UPDATE ON guilds         FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_scan_jobs_updated_at ON scan_jobs;
CREATE TRIGGER trg_scan_jobs_updated_at      BEFORE UPDATE ON scan_jobs      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_youtube_tokens_updated_at ON youtube_tokens;
CREATE TRIGGER trg_youtube_tokens_updated_at BEFORE UPDATE ON youtube_tokens FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_playlist_items_updated_at ON playlist_items;
CREATE TRIGGER trg_playlist_items_updated_at BEFORE UPDATE ON playlist_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
