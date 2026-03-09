const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setup() {
  console.log('Setting up database tables...');
  
  await pool.query(`
    -- ============================================================
    -- VIEWER SNAPSHOTS (from category-wide polling)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS viewer_snapshots (
      id SERIAL PRIMARY KEY,
      captured_at TIMESTAMPTZ NOT NULL,
      channel_slug TEXT NOT NULL,
      viewer_count INTEGER NOT NULL DEFAULT 0,
      stream_title TEXT,
      language TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vs_slug_time ON viewer_snapshots(channel_slug, captured_at);
    CREATE INDEX IF NOT EXISTS idx_vs_time ON viewer_snapshots(captured_at);

    -- ============================================================
    -- CHAT MESSAGES (from webhook events)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id TEXT PRIMARY KEY,
      broadcaster_user_id BIGINT NOT NULL,
      broadcaster_username TEXT,
      broadcaster_slug TEXT,
      sender_user_id BIGINT NOT NULL,
      sender_username TEXT,
      content TEXT,
      is_emote_only BOOLEAN DEFAULT FALSE,
      emote_count INTEGER DEFAULT 0,
      badge_types JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_broadcaster ON chat_messages(broadcaster_slug, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_sender ON chat_messages(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);

    -- ============================================================
    -- STREAM SESSIONS (from webhook events)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS stream_sessions (
      id SERIAL PRIMARY KEY,
      broadcaster_user_id BIGINT NOT NULL,
      broadcaster_username TEXT,
      broadcaster_slug TEXT,
      title TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      UNIQUE(broadcaster_user_id, started_at)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_broadcaster ON stream_sessions(broadcaster_user_id);

    -- ============================================================
    -- AUTH & CONFIG
    -- ============================================================
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS oauth_state (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      broadcaster_user_id BIGINT NOT NULL,
      event_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('✅ Database setup complete');
  await pool.end();
}

setup().catch(err => { console.error(err); process.exit(1); });
