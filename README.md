# Kick Monitor

All-in-one Kick casino streaming monitor. Polls viewer counts across the entire Slots & Casino category every 5 minutes, and receives real-time chat messages via webhooks.

**Two systems, one service:**
- **Viewer Polling** — Runs automatically on startup, no user auth needed. Uses app access token.
- **Chat Webhooks** — Requires one-time OAuth authorization. Kick pushes every chat message to this service.

## Quick Start (Railway)

### Step 1: Deploy to Railway (2 min)
1. Push this folder to a GitHub repo (or use Railway CLI)
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add a PostgreSQL plugin (click "New" → "Database" → "PostgreSQL")
4. Railway auto-sets `DATABASE_URL`

### Step 2: Set Environment Variables
In Railway dashboard → your service → Variables:

| Variable | Value |
|---|---|
| `KICK_CLIENT_ID` | `01KK9NBYPGNP83HYR3SQG64YEB` |
| `KICK_CLIENT_SECRET` | `2d12d917419057149835571dde9d3376b4fb749da8447eef7a1883efaf66feeb` |
| `KICK_APP_TOKEN` | `Y2IZMJZIMZETMDMYNY0ZNTU1LTQ4MDMTODA4MI0ZNTU3MWVIMTJIZDY1` |
| `BASE_URL` | Your Railway public URL (e.g. `https://kick-monitor-production.up.railway.app`) |
| `POLL_INTERVAL_MINUTES` | `5` (optional, default 5) |
| `CATEGORY_ID` | `28` (optional, default 28 = Slots & Casino) |

### Step 3: Initialize Database
```bash
railway run npm run setup-db
```

### Step 4: Viewer Polling Starts Automatically ✅
The moment the service starts, it begins polling every 5 minutes. No further action needed.

### Step 5: Enable Chat Monitoring (Optional)
1. Go to [kick.com/settings/developer](https://kick.com/settings/developer)
2. Edit your app settings:
   - **Webhook URL:** `https://your-app.up.railway.app/webhook`
   - **Redirect URI:** `https://your-app.up.railway.app/callback`
3. Visit `https://your-app.up.railway.app/auth` in your browser
4. Authorize the app (one-time, 30 seconds)
5. Subscribe to streamers: POST to `/api/subscribe` with broadcaster user IDs

## Migrating Existing Data
If you have viewer snapshots from the Tasklet agent's SQLite database:
```bash
railway run node migrate-from-tasklet.js viewer_snapshots_export.csv
```

## API Endpoints

### Viewer Data
| Endpoint | Description |
|---|---|
| `GET /api/viewers/:slug` | Avg/peak/min viewers for a channel (default: last 7 days) |
| `GET /api/viewers/:slug/history?hours=24` | Time series of viewer counts |
| `GET /api/viewers/category/overview?days=1` | All channels ranked by avg viewers |
| `GET /api/viewers/:slug/ramp-analysis?hours=24` | Detect suspicious viewer jumps (bot signal) |

### Chat Data
| Endpoint | Description |
|---|---|
| `GET /api/chatters/:slug?days=7` | Unique chatters, emote-only stats |
| `GET /api/chatters/:slug/top?limit=50&days=7` | Top chatters with cross-channel activity |
| `GET /api/chatter/:user_id/channels` | All channels a specific chatter participates in |
| `GET /api/bot-detection/:slug?days=7` | Bot detection summary (velocity, single-channel %) |

### Management
| Endpoint | Description |
|---|---|
| `GET /` | Health check + stats |
| `GET /auth` | Start Kick OAuth flow |
| `POST /api/subscribe` | Subscribe to chat events for broadcaster IDs |
| `GET /api/subscriptions` | List current webhook subscriptions |

## Connecting from Tasklet or Any Client

The PostgreSQL database is accessible via the connection string from Railway:
```
postgresql://user:pass@host:port/dbname
```

Find it in Railway dashboard → PostgreSQL plugin → Connect tab.

Any Tasklet agent, script, or SQL client can query the database directly.

## Cost
- **Kick API:** Free
- **Railway:** Free tier includes 500 hours/month + 1GB PostgreSQL
- **Scaling:** If you exceed free tier, Railway is ~$5/month
