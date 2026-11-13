# StageLink Backend — Free Hosting Guide

## Your stack needs

| Service | Used for |
|---|---|
| NestJS API (Node) | REST API on port 4000 |
| BullMQ Worker (Node) | Background jobs |
| PostgreSQL 17 | Main database |
| Redis 7 | Queue + rate limiting |
| S3-compatible storage | Media uploads |
| SMTP | Email (verification, recovery) |

---

## Best free option: Railway

Railway is the only platform that can run **all services for free** (\$5/month free credit, no credit card required) with Docker support and native PostgreSQL + Redis add-ons. Your project already has a `Dockerfile` — Railway can deploy it directly.

> [!IMPORTANT]
> \$5/month credit covers a small always-on API + worker + Postgres + Redis comfortably for a student/portfolio project.

### Step-by-step: Deploy to Railway

#### 1. Sign up & create project
- Go to [railway.app](https://railway.app) → sign up with GitHub (free, no card needed)
- New Project → **Deploy from GitHub repo** → select your repo

#### 2. Add PostgreSQL and Redis
In your Railway project dashboard:
- **+ New** → **Database** → **Add PostgreSQL**
- **+ New** → **Database** → **Add Redis**

Railway auto-injects `DATABASE_URL` and `REDIS_URL` as env vars.

#### 3. Add the API service
- **+ New** → **GitHub Repo** → pick your repo
- Set **Root Directory**: leave blank (uses repo root)
- Set **Dockerfile Path**: `backend/Dockerfile`

#### 4. Set environment variables

In the API service **Variables** tab, add:

```
NODE_ENV=production
AUTH_JWT_SECRET=<generate a strong random secret>
AUTH_MAIL_KEY=<generate a 32-byte hex key>
PAYOUT_DATA_KEY=<generate a 32-byte hex key>
WEB_ORIGIN=https://your-app.vercel.app

# PostgreSQL — copy from Railway's Postgres service variables
DATABASE_URL=${{Postgres.DATABASE_URL}}

# Redis — copy from Railway's Redis service variables
REDIS_URL=${{Redis.REDIS_URL}}

# Media — use Cloudflare R2 (free S3-compatible, see below)
MEDIA_DRIVER=aws
S3_BUCKET=stagelink-media
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<r2-access-key>
AWS_SECRET_ACCESS_KEY=<r2-secret-key>

# SMTP — use Resend free tier (see below)
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_FROM=noreply@yourdomain.com
SMTP_USER=resend
SMTP_PASS=<resend-api-key>
```

#### 5. Run migrations before the API starts
- In the API service → **Settings** → **Deploy** → **Start Command**:
  ```
  node dist/api/src/main.js
  ```
- Add a **Pre-deploy command** (or separate Railway service for migrate):
  ```
  npm run db:migrate
  ```

Alternatively, add a one-off **Migrate service** in Railway:
- Same Dockerfile, same env vars
- Start Command: `npm run db:migrate`
- Set **Restart Policy**: Never (run once)

#### 6. Add the Worker service
- **+ New** → **GitHub Repo** → same repo
- Same Dockerfile, same env vars
- **Start Command**: `node dist/worker/src/main.js`

#### 7. Get your public API URL
Railway gives each service a public URL like `https://stagelink-api-production.up.railway.app`.

---

## Free supporting services

### S3 Media — Cloudflare R2 (Free)
- [dash.cloudflare.com](https://dash.cloudflare.com) → R2 → Create bucket `stagelink-media`
- Free: 10 GB storage, 1M Class-A ops/month, 10M Class-B ops/month
- Get API token → use as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- Set `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com`

### SMTP Email — Resend (Free)
- [resend.com](https://resend.com) → free tier: 3,000 emails/month
- Get API key → use as `SMTP_PASS=re_xxxxx`, `SMTP_USER=resend`
- `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`

---

## Connect to Vercel

Once Railway gives you a public URL:

1. In your Vercel project → **Settings** → **Environment Variables**:
   ```
   NEXT_PUBLIC_API_URL=https://stagelink-api-production.up.railway.app
   ```
2. In Railway API service env vars:
   ```
   WEB_ORIGIN=https://your-app.vercel.app
   ```
3. Redeploy both.

---

## Alternatives (fully free but with trade-offs)

| Platform | Trade-off |
|---|---|
| **Render** | Free web services **sleep after 15 min** of inactivity (cold start ~30s). Free Postgres expires after 90 days. No free Redis — need Upstash. |
| **Fly.io** | Free allowance: 3 VMs × 256 MB RAM. Requires credit card to verify. Good for Docker. Need Upstash for Redis. |
| **Koyeb** | Free tier: 1 service, 512 MB RAM, 1 region. No managed Redis/Postgres — need external. |

**Railway is the best fit** for this project because it natively supports PostgreSQL, Redis, and Docker with the least configuration.
