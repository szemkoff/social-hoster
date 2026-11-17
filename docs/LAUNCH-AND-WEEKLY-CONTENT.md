# Launch Social Hoster and stack a week of content

This guide covers launching your own Social Hoster instance, connecting accounts,
queuing a week of posts across channels, and running a daily Instagram Trial Reel.

## 1. Launch

You need Node 22 (local) or Docker (server). The app stores everything in SQLite,
so give it a persistent `/data` volume.

### Local (try it on your laptop)

```bash
git clone https://github.com/szemkoff/social-hoster && cd social-hoster
npm ci
cp .env.example .env.local
# In .env.local set at least:
#   DISABLE_AUTH=true                 # local only — skips login
#   DATABASE_URL=./data/social-poster.db
#   AUTH_SECRET=<random 32+ chars>
#   ZERNIO_API_KEY=<key>              # easiest way to post to IG/FB/LinkedIn/TikTok/X
npm run dev                            # http://localhost:3000/dashboard
```

Social platforms must be able to fetch your media, so local runs are for setup and
testing. Use a server for real posting.

### Server (Docker on any VPS)

```bash
git clone https://github.com/szemkoff/social-hoster && cd social-hoster
cp .env.example .env    # fill in values below
docker build -t social-hoster .
docker run -d --name social-hoster --restart unless-stopped \
  --env-file .env -e NODE_ENV=production -e DATABASE_URL=/data/social-poster.db \
  -p 3000:3000 -v $(pwd)/data:/data social-hoster
curl -fsS http://localhost:3000/api/health
```

Put it behind HTTPS (Caddy, Traefik, Coolify, or a Cloudflare tunnel) on your own domain.

Production `.env` minimum:

| Var | Value |
|---|---|
| `DISABLE_AUTH` | `false` (required in production) |
| `AUTH_SECRET` | random 32+ char string |
| `AUTH_EMAIL` | your login email |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project for login (Supabase Cloud free tier works) |
| `APP_URL` | `https://your-domain` (single origin) |
| `ZERNIO_API_KEY` | Zernio key, if you post through Zernio |
| `META_APP_ID` / `META_APP_SECRET` etc. | only if you connect platforms natively instead of via Zernio |
| `R2_*` / `CLOUDFLARE_*` | optional, for hosting uploaded media publicly |
| `DUE_POST_WORKER_ENABLED` | leave unset (on). Set `false` only on extra replicas |

The pipeline and `docker-compose.yml` now use this fork's image, `ghcr.io/szemkoff/social-hoster:main`.
Each push to `main` builds that image. The Coolify deploy step only runs once the repo
variable `COOLIFY_UUID` is set.

### No server yet: recommended setup (VPS + Coolify)

The app needs a long-running container with a persistent disk, because it uses SQLite and a
cron worker that runs every minute. Serverless hosts won't work.

1. **Rent a VPS.** Ubuntu 24.04 LTS with 2 vCPU, 4 GB RAM, and 40 GB or more of disk. Video
   rendering uses Chromium and ffmpeg, so 4 GB is the practical minimum. Use an x86 (amd64)
   plan, since the image is built for amd64. Good options are Hetzner CX23/CX33,
   DigitalOcean, or Vultr.
2. **Point a domain at it.** Add a DNS `A` record such as `social.azureyachtgroup.com` that
   points to the server's IP.
3. **Install Coolify** over SSH as root:
   `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`
   Then open `http://<server-ip>:8000` and create the admin account right away. The first
   account is only accepted for about 10 minutes.
4. **Allow Coolify to pull the private image.** In Coolify, go to Servers, then
   Docker registries, and add `ghcr.io` with user `szemkoff` and a GitHub PAT that has the
   `read:packages` scope. Alternatively, make the package public on GitHub.
5. **Create the app.** Choose New Resource, then Docker Image, and enter
   `ghcr.io/szemkoff/social-hoster:main`. Then configure:
   - port: `3000`
   - domain: `https://social.azureyachtgroup.com`
   - persistent storage: mount at `/data`
   - health check: `/api/health`
   - environment variables: everything in the table above
6. **Create a Supabase project** (the free tier works) for login. Copy its URL and anon key
   into the environment variables.
7. **Turn on auto-deploy.** In Coolify, go to Keys & Tokens and create an API token. Then
   set it up in GitHub:
   - repo secret `COOLIFY_URL`, for example `http://<server-ip>:8000`
   - repo secret `COOLIFY_API_TOKEN`
   - repo variable `COOLIFY_UUID`, which is the app's UUID from its Coolify URL

   After that, every push to `main` deploys automatically.

Plain Docker alternative (no Coolify): copy `docker-compose.yml` and `.env` to the server,
run `docker login ghcr.io`, then `docker compose pull && docker compose up -d`. Put Caddy
in front for HTTPS.

## 2. Connect accounts and create an API key

1. Open `/dashboard` → Channels and connect Instagram (Business or Creator account required
   for Trial Reels), Facebook, LinkedIn, X, TikTok, and the rest.
2. Settings → API keys → create an App Access key with **Read & Write**.
3. On the machine where you run the planner:

```bash
export SOCIAL_HOSTER_URL=https://your-domain
export SOCIAL_HOSTER_API_KEY=sk_...
node scripts/content-week.mjs channels      # confirms the key works, lists channel ids
```

## 3. Stack one week of content

```bash
# 1. Generate a 7-day plan: one cross-channel post at 9:00 + one Trial Reel at 18:00 each day
node scripts/content-week.mjs template --start 2026-11-23 \
  --platforms instagram,facebook,linkedin,x --time 09:00 --reel-time 18:00 --out week.csv

# 2. Fill in captions and public media URLs (https, .jpg/.png for images, .mp4/.mov for reels)

# 3. Check it (resolves channels, catches missing media, placeholder URLs, past times)
node scripts/content-week.mjs validate week.csv

# 4. Queue it (use --draft to create drafts for review instead of scheduling)
node scripts/content-week.mjs push week.csv

# 5. See what's queued
node scripts/content-week.mjs queue --days 7
```

`push` writes `week.csv.ledger.json`, so running it again only adds new rows and never
double-queues. Times are interpreted in `America/New_York` unless you pass `--tz`.

### Plan columns

| Column | Meaning |
|---|---|
| `date`, `time` | Local date `YYYY-MM-DD` and 24h `HH:MM` |
| `platforms` | `instagram,facebook,linkedin,x`, channel names/handles/ids, or `all` |
| `type` | `image`, `video`, or `text` (inferred from media if blank) |
| `trial_reel` | blank, `manual`, or `auto` |
| `caption` | Main copy |
| `media` | Public URL(s), `|`-separated |
| `title` | Optional internal title |
| `first_comment` | Optional first comment |
| `x_caption`, `linkedin_caption`, `instagram_caption`, `facebook_caption`, `threads_caption`, `tiktok_caption` | Optional per-channel captions |

## 4. Daily Trial Reels

A Trial Reel is shown to non-followers first. Set `trial_reel` on a row with a video:

- `manual` — stays a trial until you tap "Share to followers" in the Instagram app.
- `auto` — Instagram shares it to followers automatically if it performs well (`SS_PERFORMANCE`).

The API equivalent is a per-platform override:

```json
{
  "content": "Trial reel caption",
  "contentType": "video",
  "intent": "schedule",
  "scheduledAt": "2026-11-23T23:00:00.000Z",
  "platformIds": ["<instagram channel id>"],
  "mediaUrls": ["https://cdn.example.com/reel.mp4"],
  "platformOverrides": { "instagram": { "format": "reel", "trialReel": "auto" } }
}
```

It works with both Zernio-connected (`trialParams`) and natively connected
(`trial_params`) Instagram accounts. Trial reels never set share-to-feed.

## 5. How scheduled posts go out

A due-post worker runs inside the app every 60 seconds. It claims each post whose
status is `scheduled` and whose time has passed, publishes it to every target through
the same pipeline as "Publish now", and records a pipeline run. Already-published
targets are never re-posted. If the workspace requires approval, an unapproved post is
moved back to draft instead of publishing.

## API reference added for planners

- `GET /api/platforms` — connected channels (no credentials returned)
- `GET /api/posts?status=scheduled&from=ISO&to=ISO&limit=100` — queued posts with targets
- `POST /api/posts` — accepts `platformOverrides.<type>.trialReel`
