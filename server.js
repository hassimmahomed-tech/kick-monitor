const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Kick public key for webhook signature verification
const KICK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

// Config
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_APP_TOKEN = process.env.KICK_APP_TOKEN;
const BASE_URL = process.env.BASE_URL;
const POLL_INTERVAL_MS = (parseInt(process.env.POLL_INTERVAL_MINUTES) || 5) * 60 * 1000;
const CATEGORY_ID = process.env.CATEGORY_ID || '28'; // Slots & Casino

// Database
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ============================================================
// MIDDLEWARE
// ============================================================
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/kick', express.raw({ type: 'application/json' }));
app.use(express.json());

// ============================================================
// VIEWER COUNT POLLING - Runs on interval, no Tasklet needed
// ============================================================
let pollTimer = null;

async function pollViewerCounts() {
  try {
    const resp = await fetch(`https://api.kick.com/public/v1/livestreams?category_id=${CATEGORY_ID}`, {
      headers: {
        'Authorization': `Bearer ${KICK_APP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      console.error(`Kick API error: ${resp.status} ${resp.statusText}`);
      return;
    }

    const data = await resp.json();
    const streams = data.data || [];
    const now = new Date().toISOString();

    if (streams.length === 0) {
      console.log(`[${now}] No live streams in category ${CATEGORY_ID}`);
      return;
    }

    // Batch insert all viewer snapshots
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const stream of streams) {
      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4})`);
      params.push(
        now,
        stream.channel?.slug || stream.slug || 'unknown',
        stream.viewer_count || 0,
        stream.session_title || stream.title || '',
        stream.language || ''
      );
      paramIdx += 5;
    }

    await pool.query(`
      INSERT INTO viewer_snapshots (captured_at, channel_slug, viewer_count, stream_title, language)
      VALUES ${values.join(', ')}
    `, params);

    console.log(`[${now}] Captured ${streams.length} streams`);
  } catch (err) {
    console.error('Viewer poll error:', err.message);
  }
}

function startPolling() {
  console.log(`Starting viewer count polling every ${POLL_INTERVAL_MS / 60000} minutes for category ${CATEGORY_ID}`);
  pollViewerCounts(); // First poll immediately
  pollTimer = setInterval(pollViewerCounts, POLL_INTERVAL_MS);
}

// ============================================================
// WEBHOOK RECEIVER - Kick pushes chat events here
// ============================================================
app.post(['/webhook', '/api/webhooks/kick'], async (req, res) => {
  try {
    const messageId = req.headers['kick-event-message-id'];
    const timestamp = req.headers['kick-event-message-timestamp'];
    const signature = req.headers['kick-event-signature'];
    const eventType = req.headers['kick-event-type'];
    const body = req.body;

    // Verify signature
    if (signature && messageId && timestamp) {
      const signaturePayload = `${messageId}.${timestamp}.${body}`;
      const verifier = crypto.createVerify('SHA256');
      verifier.update(signaturePayload);
      const isValid = verifier.verify(KICK_PUBLIC_KEY, signature, 'base64');
      if (!isValid) {
        console.warn('Invalid webhook signature');
        return res.status(401).send('Invalid signature');
      }
    }

    const data = JSON.parse(body);

    if (eventType === 'chat.message.sent') {
      await handleChatMessage(data, messageId);
    } else if (eventType === 'livestream.status.updated') {
      await handleStreamEvent(data);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).send('Error');
  }
});

async function handleChatMessage(data, messageId) {
  const { sender, broadcaster, content, emotes, created_at } = data;
  const isEmoteOnly = isContentOnlyEmotes(content, emotes);

  await pool.query(`
    INSERT INTO chat_messages (
      message_id, broadcaster_user_id, broadcaster_username, broadcaster_slug,
      sender_user_id, sender_username, content, is_emote_only,
      emote_count, badge_types, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (message_id) DO NOTHING
  `, [
    messageId,
    broadcaster?.user_id,
    broadcaster?.username,
    broadcaster?.channel_slug,
    sender?.user_id,
    sender?.username,
    content?.substring(0, 500),
    isEmoteOnly,
    emotes?.length || 0,
    JSON.stringify(sender?.identity?.badges?.map(b => b.type) || []),
    created_at
  ]);
}

function isContentOnlyEmotes(content, emotes) {
  if (!content || !emotes || emotes.length === 0) return false;
  let stripped = content.replace(/\[emote:\d+:[^\]]+\]/g, '').trim();
  return stripped.length === 0;
}

async function handleStreamEvent(data) {
  const { broadcaster, is_live, title, started_at, ended_at } = data;
  if (is_live) {
    await pool.query(`
      INSERT INTO stream_sessions (
        broadcaster_user_id, broadcaster_username, broadcaster_slug,
        title, started_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (broadcaster_user_id, started_at) DO NOTHING
    `, [broadcaster?.user_id, broadcaster?.username, broadcaster?.channel_slug, title, started_at]);
  } else if (ended_at) {
    await pool.query(`
      UPDATE stream_sessions SET ended_at = $1
      WHERE broadcaster_user_id = $2 AND ended_at IS NULL
    `, [ended_at, broadcaster?.user_id]);
  }
}

// ============================================================
// OAUTH - Authorization flow for User Access Token
// ============================================================
app.get('/auth', async (req, res) => {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  await pool.query(
    'INSERT INTO oauth_state (state, code_verifier) VALUES ($1, $2)',
    [state, codeVerifier]
  );

  const authUrl = `https://id.kick.com/oauth/authorize?` +
    `response_type=code&` +
    `client_id=${KICK_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(BASE_URL + '/callback')}&` +
    `scope=events:subscribe&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    `state=${state}`;

  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');

  const stateRow = await pool.query('SELECT code_verifier FROM oauth_state WHERE state = $1', [state]);
  if (stateRow.rows.length === 0) return res.status(400).send('Invalid state');

  const codeVerifier = stateRow.rows[0].code_verifier;

  const tokenResp = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      redirect_uri: `${BASE_URL}/callback`,
      code_verifier: codeVerifier,
      code
    })
  });

  const tokenData = await tokenResp.json();

  if (tokenData.access_token) {
    await pool.query(`
      INSERT INTO tokens (id, access_token, refresh_token, scope, expires_at)
      VALUES ('kick_user', $1, $2, $3, NOW() + INTERVAL '1 second' * $4)
      ON CONFLICT (id) DO UPDATE SET
        access_token = $1, refresh_token = $2, scope = $3,
        expires_at = NOW() + INTERVAL '1 second' * $4
    `, [tokenData.access_token, tokenData.refresh_token, tokenData.scope, tokenData.expires_in]);

    await pool.query('DELETE FROM oauth_state WHERE state = $1', [state]);
    res.send('<h1>✅ Authorization successful!</h1><p>You can close this tab. The Kick Monitor is now active.</p>');
  } else {
    res.status(400).send(`<h1>❌ Authorization failed</h1><pre>${JSON.stringify(tokenData, null, 2)}</pre>`);
  }
});

// ============================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================
app.post('/api/subscribe', async (req, res) => {
  const { broadcaster_user_ids } = req.body;

  const tokenRow = await pool.query('SELECT access_token FROM tokens WHERE id = $1', ['kick_user']);
  if (tokenRow.rows.length === 0) return res.status(401).json({ error: 'Not authorized. Visit /auth first.' });

  const token = tokenRow.rows[0].access_token;
  const results = [];

  for (const bid of broadcaster_user_ids) {
    try {
      const resp = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          broadcaster_user_id: bid,
          events: [
            { name: 'chat.message.sent', version: 1 },
            { name: 'livestream.status.updated', version: 1 }
          ],
          method: 'webhook'
        })
      });
      const data = await resp.json();
      results.push({ broadcaster_user_id: bid, status: resp.status, data });
    } catch (err) {
      results.push({ broadcaster_user_id: bid, error: err.message });
    }
  }

  res.json(results);
});

app.get('/api/subscriptions', async (req, res) => {
  const tokenRow = await pool.query('SELECT access_token FROM tokens WHERE id = $1', ['kick_user']);
  if (tokenRow.rows.length === 0) return res.status(401).json({ error: 'Not authorized' });

  const resp = await fetch('https://api.kick.com/public/v1/events/subscriptions', {
    headers: { 'Authorization': `Bearer ${tokenRow.rows[0].access_token}` }
  });
  const data = await resp.json();
  res.json(data);
});

// ============================================================
// ANALYTICS ENDPOINTS - Viewer Data
// ============================================================

// Viewer stats for a channel
app.get('/api/viewers/:slug', async (req, res) => {
  const { slug } = req.params;
  const { days = 7 } = req.query;

  const result = await pool.query(`
    SELECT 
      COUNT(*) as snapshots,
      ROUND(AVG(viewer_count)) as avg_viewers,
      MAX(viewer_count) as peak_viewers,
      MIN(viewer_count) as min_viewers,
      MIN(captured_at) as first_seen,
      MAX(captured_at) as last_seen
    FROM viewer_snapshots
    WHERE channel_slug = $1 AND captured_at >= NOW() - INTERVAL '1 day' * $2
  `, [slug, days]);
  res.json(result.rows[0]);
});

// Viewer history (time series) for a channel
app.get('/api/viewers/:slug/history', async (req, res) => {
  const { slug } = req.params;
  const { hours = 24 } = req.query;

  const result = await pool.query(`
    SELECT captured_at, viewer_count, stream_title
    FROM viewer_snapshots
    WHERE channel_slug = $1 AND captured_at >= NOW() - INTERVAL '1 hour' * $2
    ORDER BY captured_at ASC
  `, [slug, hours]);
  res.json(result.rows);
});

// Category overview - all channels ranked by avg viewers
app.get('/api/viewers/category/overview', async (req, res) => {
  const { days = 1 } = req.query;

  const result = await pool.query(`
    SELECT 
      channel_slug,
      COUNT(*) as snapshots,
      ROUND(AVG(viewer_count)) as avg_viewers,
      MAX(viewer_count) as peak_viewers,
      MAX(stream_title) as last_title,
      MAX(language) as language,
      MIN(captured_at) as first_seen,
      MAX(captured_at) as last_seen
    FROM viewer_snapshots
    WHERE captured_at >= NOW() - INTERVAL '1 day' * $1
    GROUP BY channel_slug
    ORDER BY avg_viewers DESC
  `, [days]);
  res.json(result.rows);
});

// Bot detection: viewer ramp analysis (sharp jumps = suspicious)
app.get('/api/viewers/:slug/ramp-analysis', async (req, res) => {
  const { slug } = req.params;
  const { hours = 24 } = req.query;

  const result = await pool.query(`
    WITH snapshots AS (
      SELECT captured_at, viewer_count,
        LAG(viewer_count) OVER (ORDER BY captured_at) as prev_count,
        LAG(captured_at) OVER (ORDER BY captured_at) as prev_time
      FROM viewer_snapshots
      WHERE channel_slug = $1 AND captured_at >= NOW() - INTERVAL '1 hour' * $2
    )
    SELECT 
      captured_at, viewer_count, prev_count,
      viewer_count - COALESCE(prev_count, 0) as delta,
      ROUND(ABS(viewer_count - COALESCE(prev_count, 0))::numeric / NULLIF(GREATEST(prev_count, 1), 0) * 100) as pct_change
    FROM snapshots
    WHERE prev_count IS NOT NULL
      AND ABS(viewer_count - prev_count) > 50
    ORDER BY ABS(viewer_count - prev_count) DESC
    LIMIT 20
  `, [slug, hours]);
  res.json(result.rows);
});

// ============================================================
// ANALYTICS ENDPOINTS - Chat Data
// ============================================================

// Chatter stats for a broadcaster
app.get('/api/chatters/:slug', async (req, res) => {
  const { slug } = req.params;
  const { days = 7 } = req.query;

  const result = await pool.query(`
    SELECT 
      COUNT(DISTINCT sender_user_id) as unique_chatters,
      COUNT(*) as total_messages,
      COUNT(DISTINCT CASE WHEN is_emote_only THEN sender_user_id END) as emote_only_chatters,
      COUNT(CASE WHEN is_emote_only THEN 1 END) as emote_only_messages,
      ROUND(COUNT(DISTINCT CASE WHEN is_emote_only THEN sender_user_id END)::numeric / 
        NULLIF(COUNT(DISTINCT sender_user_id), 0) * 100, 1) as emote_only_pct
    FROM chat_messages
    WHERE broadcaster_slug = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
  `, [slug, days]);
  res.json(result.rows[0]);
});

// Cross-channel activity for a chatter
app.get('/api/chatter/:user_id/channels', async (req, res) => {
  const result = await pool.query(`
    SELECT broadcaster_slug, broadcaster_username,
      COUNT(*) as message_count,
      MIN(created_at) as first_seen, MAX(created_at) as last_seen
    FROM chat_messages WHERE sender_user_id = $1
    GROUP BY broadcaster_slug, broadcaster_username
    ORDER BY message_count DESC
  `, [req.params.user_id]);
  res.json(result.rows);
});

// Top chatters with cross-channel data
app.get('/api/chatters/:slug/top', async (req, res) => {
  const { slug } = req.params;
  const { limit = 50, days = 7 } = req.query;

  const result = await pool.query(`
    WITH bc AS (
      SELECT sender_user_id, sender_username,
        COUNT(*) as messages_here,
        COUNT(CASE WHEN is_emote_only THEN 1 END) as emote_messages
      FROM chat_messages
      WHERE broadcaster_slug = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY sender_user_id, sender_username
    ),
    cc AS (
      SELECT sender_user_id, COUNT(DISTINCT broadcaster_slug) as channels_active
      FROM chat_messages
      WHERE sender_user_id IN (SELECT sender_user_id FROM bc)
      GROUP BY sender_user_id
    )
    SELECT bc.*, cc.channels_active
    FROM bc JOIN cc ON bc.sender_user_id = cc.sender_user_id
    ORDER BY bc.messages_here DESC LIMIT $3
  `, [slug, days, limit]);
  res.json(result.rows);
});

// Bot detection summary
app.get('/api/bot-detection/:slug', async (req, res) => {
  const { slug } = req.params;
  const { days = 7 } = req.query;

  const result = await pool.query(`
    WITH stats AS (
      SELECT 
        COUNT(DISTINCT sender_user_id) as unique_chatters,
        COUNT(*) as total_messages,
        COUNT(DISTINCT CASE WHEN is_emote_only THEN sender_user_id END) as emote_only_chatters
    FROM chat_messages
    WHERE broadcaster_slug = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
    ),
    single AS (
      SELECT COUNT(*) as single_channel_chatters FROM (
        SELECT cm.sender_user_id FROM chat_messages cm
        WHERE cm.broadcaster_slug = $1 AND cm.created_at >= NOW() - INTERVAL '1 day' * $2
        GROUP BY cm.sender_user_id
        HAVING (SELECT COUNT(DISTINCT broadcaster_slug) FROM chat_messages WHERE sender_user_id = cm.sender_user_id) = 1
      ) t
    ),
    velocity AS (
      SELECT DATE_TRUNC('minute', created_at) as minute, COUNT(*) as mpm
      FROM chat_messages
      WHERE broadcaster_slug = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY 1
    )
    SELECT s.*, sg.single_channel_chatters,
      ROUND(sg.single_channel_chatters::numeric / NULLIF(s.unique_chatters, 0) * 100, 1) as single_channel_pct,
      (SELECT ROUND(AVG(mpm), 1) FROM velocity) as avg_msgs_per_minute,
      (SELECT ROUND(STDDEV(mpm), 1) FROM velocity) as stddev_msgs_per_minute
    FROM stats s, single sg
  `, [slug, days]);
  res.json(result.rows[0]);
});

// ============================================================
// HEALTH & STATUS
// ============================================================
app.get('/', async (req, res) => {
  try {
    const viewerCount = await pool.query('SELECT COUNT(*) as n FROM viewer_snapshots');
    const chatCount = await pool.query('SELECT COUNT(*) as n FROM chat_messages');
    const lastPoll = await pool.query('SELECT MAX(captured_at) as t FROM viewer_snapshots');
    
    res.json({
      status: 'ok',
      service: 'kick-monitor',
      version: '2.0.0',
      polling: {
        interval_minutes: POLL_INTERVAL_MS / 60000,
        category_id: CATEGORY_ID,
        total_viewer_snapshots: parseInt(viewerCount.rows[0].n),
        last_poll: lastPoll.rows[0].t
      },
      chat: {
        total_messages: parseInt(chatCount.rows[0].n)
      }
    });
  } catch (err) {
    res.json({ status: 'ok', service: 'kick-monitor', version: '2.0.0', db: 'not ready' });
  }
});

// ============================================================
// DB INIT
// ============================================================
async function initDb() {
  console.log('Initializing database tables...');
  await pool.query(`
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
  console.log('✅ Database tables ready');
}

// ============================================================
// START
// ============================================================
app.listen(PORT, async () => {
  console.log(`Kick Monitor running on port ${PORT}`);
  try {
    await initDb();
  } catch (err) {
    console.error('DB init failed:', err.message);
  }
  startPolling();
});
