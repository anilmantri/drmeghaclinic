# Dr. Megha's Aesthetic Clinic — Website + AI Skin Scan

This repo has two parts:

- **`index.html`** — the clinic's static website, including the "AI Skin Scan"
  widget (multi-angle selfie capture → AI skin report → lead capture form).
- **`server/`** — the backend API the widget calls: analyzes photos with
  Claude's vision API and saves leads (name, phone, city, age, report) to a
  Postgres database.

This guide covers deploying both to **Render**.

> Previously deployed on Cloudflare Pages + Workers? That setup still works
> and lives in `worker/` if you'd rather use it. This README covers the
> Render path only — pick one hosting target, not both.

## Architecture on Render

| Piece | Render resource | Why |
|---|---|---|
| `index.html` | Static Site | Free, fast, no server needed for plain HTML/CSS/JS |
| `server/` | Web Service (Node) | Keeps your Anthropic API key server-side; handles scans + leads |
| Leads storage | PostgreSQL (Render managed) | Persistent database for patient leads |

## Option A — One-click deploy with the Blueprint (recommended)

This repo includes a `render.yaml` Blueprint that provisions all three
pieces (static site, web service, database) together.

1. Push this repo to GitHub (or GitLab).
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint**.
3. Select your repo. Render reads `render.yaml` and shows you a preview of
   what it will create: `drmegha-site` (static site), `drmegha-skinscan-api`
   (web service), and `drmegha-leads` (Postgres database).
4. Click **Apply**. Render provisions everything and links the database's
   connection string to the web service automatically.
5. Once deployed, go to `drmegha-skinscan-api` → **Environment** and set the
   secrets Render didn't fill in for you:
   - `ANTHROPIC_API_KEY` — your Anthropic API key
   - `ADMIN_KEY` — a strong random string you choose (protects `/api/leads`)
   - `WEB3FORMS_KEY` — optional, your existing Web3Forms key for email alerts
6. Note the URL Render gives `drmegha-skinscan-api`, e.g.
   `https://drmegha-skinscan-api.onrender.com`.
7. Open `index.html`, find this line near the top of the `<script>` block:
   ```js
   const SCAN_API_BASE = "https://drmegha-skinscan-api.onrender.com";
   ```
   Update it to match your actual service URL, commit, and push — Render
   auto-redeploys the static site.
8. Back in `drmegha-skinscan-api` → **Environment**, update `ALLOWED_ORIGIN`
   to your actual static site URL (e.g. `https://drmegha-site.onrender.com`,
   or your custom domain once attached) so CORS only allows your real site.

That's it — the widget is live.

## Option B — Manual setup (if you skip the Blueprint)

### 1. Create the database

- Render Dashboard → **New +** → **PostgreSQL**
- Name it `drmegha-leads`, pick the free plan, create it.
- Once ready, copy its **Internal Database URL** (you'll paste this into the
  web service's env vars — or just link them, see step 2).

### 2. Deploy the backend

- Render Dashboard → **New +** → **Web Service**
- Connect your repo, set **Root Directory** to `server`
- Build command: `npm install`
- Start command: `npm start`
- Add environment variables:
  - `ANTHROPIC_API_KEY` — your key
  - `DATABASE_URL` — paste the connection string from step 1, or use Render's
    "Add Database" shortcut in the web service's Environment tab to link it
  - `ALLOWED_ORIGIN` — your static site's URL (update after step 3)
  - `ADMIN_KEY` — a strong random string
  - `WEB3FORMS_KEY` — optional
- Deploy. The table is created automatically on first boot (`ensureSchema()`
  in `server.js`) — no manual migration step needed.

### 3. Deploy the frontend

- Render Dashboard → **New +** → **Static Site**
- Connect the same repo
- Build command: leave blank
- Publish directory: `.` (repo root, where `index.html` lives)
- Deploy. Render gives you a URL like `https://drmegha-site.onrender.com`.

### 4. Wire them together

- In `index.html`, set `SCAN_API_BASE` to your web service's URL (step 2),
  commit and push.
- In the web service's env vars, set `ALLOWED_ORIGIN` to your static site's
  URL (step 3).

## Local development

```bash
cd server
cp .env.example .env
# fill in .env with a local Postgres URL and your Anthropic key
npm install
npm start
```

Then temporarily point `SCAN_API_BASE` in `index.html` at `http://localhost:3000`
and open `index.html` directly in a browser (or serve it with any static
file server) to test end-to-end. Revert the URL before deploying.

## Viewing saved leads

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" https://drmegha-skinscan-api.onrender.com/api/leads
```

Returns the most recent 500 leads as JSON, newest first.

## Notes on Render's free tier

- Free web services **spin down after 15 minutes of inactivity** and take
  ~30-60 seconds to wake on the next request — the first scan after a quiet
  period will feel slow. Upgrade to a paid instance to avoid this once you're
  running real ad traffic.
- Free Postgres databases on Render **expire after 90 days** unless upgraded.
  Set a reminder, or move to a paid plan before that if you want to keep the
  lead history.
- The in-memory rate limiter in `server.js` only works correctly on a single
  instance. Free and Starter plans run one instance, so this is fine as-is;
  if you scale to multiple instances later, move rate limiting to Postgres
  or Redis.

## Switching between Gemini and Anthropic

The backend supports two vision providers, controlled by one environment
variable: `AI_PROVIDER`.

| `AI_PROVIDER` | Provider | Model | Requires |
|---|---|---|---|
| `gemini` | Google Gemini | `gemini-3.5-flash` | `GEMINI_API_KEY` |
| `anthropic` (default) | Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |

Both return the same JSON schema, so nothing else in the app changes when
you switch — just the env var and the matching API key.

**Free vs. paid Gemini** isn't a setting in this app — it's controlled by
whether billing is enabled on the Google Cloud project behind your
`GEMINI_API_KEY`. Without billing enabled, that key runs on the free tier
(low daily request limits, and Google's terms allow using free-tier content
to improve their products). Enable billing on that project in Google Cloud
Console when you're ready to move real patient traffic onto Gemini — this
removes the daily limits and stops your data from being used for training,
with no code changes needed here.

**Recommended path:**
1. Start with `AI_PROVIDER=gemini` and a free-tier `GEMINI_API_KEY` while you
   test the widget end-to-end (few requests, zero cost).
2. Once you're ready for production, either:
   - Enable billing on that same Google Cloud project (stays on `gemini`), or
   - Switch to `AI_PROVIDER=anthropic` with your Anthropic key.

Set `AI_PROVIDER` in your Render web service → **Environment**, then
redeploy. The server logs which provider is active on startup.

## Cost expectations

Each scan is one Claude API vision call, up to 3 image inputs. Every image is
resized to a max of 1024px and re-compressed to JPEG @ 80% quality server-side
before being sent to the API — this cuts vision token cost substantially with
no meaningful loss in analysis quality for skin-observation purposes. At
typical Instagram-ad-driven volumes (tens to low hundreds of scans/day), this
stays well within a few dollars a month on the API side. Render's free tier
covers light traffic; a paid Starter web service (~$7/month) removes the
spin-down delay once you're running real campaigns.

## Extending this later

- **Admin dashboard**: build a small password-protected page that calls
  `GET /api/leads` with your `x-admin-key` and renders a sortable table.
- **Multi-instance rate limiting**: swap the in-memory `Map` in `server.js`
  for a Redis-backed limiter if you move to multiple instances.
- **Swap in a dedicated skin-analysis API** later (e.g. Haut.AI, Perfect
  Corp) if you need more clinically consistent scoring than a general vision
  model — only the `/api/scan` handler needs to change.
