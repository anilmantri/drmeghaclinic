# Dr. Megha's Skin Scan Microservice

A Cloudflare Worker that powers the "AI Skin Scan" widget on the clinic website.
It keeps your Anthropic API key server-side, rate-limits requests, and forwards
qualified leads to your inbox.

## What it does

- `POST /api/scan` — receives 3 selfies (front, left profile, right profile, as
  base64 JPEGs), sends them together to Claude's vision API with a strict,
  non-diagnostic prompt, and returns one structured skin report. Images are
  processed in memory and **never stored**.
- `POST /api/lead` — receives name, phone, city, age (optional), and the report
  summary from a user who wants a callback. Saves it to a Cloudflare D1
  database (the source of truth) and also forwards it to Web3Forms so the
  clinic gets an immediate email, same as the main appointment form.
- `GET /api/leads` — admin-only endpoint (requires an `x-admin-key` header) that
  returns the saved leads as JSON, newest first, for the clinic staff to review.
- Basic per-IP rate limiting (5 requests/minute per endpoint) using a Cloudflare
  KV namespace, to control both cost and abuse from the ad traffic.

## Prerequisites

- A Cloudflare account (free tier works)
- Node.js installed locally
- Your Anthropic API key (from console.anthropic.com)
- Your existing Web3Forms access key (the one already in your site's appointment form)

## Setup

```bash
npm install -g wrangler
wrangler login

cd worker
```

### 1. Create the rate-limit KV namespace

```bash
wrangler kv:namespace create RATE_LIMIT
```

This prints an `id`. Paste it into `wrangler.toml` under `[[kv_namespaces]]`.

### 2. Create the leads database (D1)

```bash
wrangler d1 create drmegha-leads
```

This prints a `database_id`. Paste it into `wrangler.toml` under `[[d1_databases]]`.

Then create the `leads` table:

```bash
wrangler d1 execute drmegha-leads --remote --file=./schema.sql
```

### 3. Set your secrets (never committed to git, never in wrangler.toml)

```bash
wrangler secret put ANTHROPIC_API_KEY
# paste your key when prompted

wrangler secret put WEB3FORMS_KEY
# paste your existing Web3Forms access key

wrangler secret put ADMIN_KEY
# make up a strong random string — this protects GET /api/leads
```

### 4. Lock down CORS

In `wrangler.toml`, set `ALLOWED_ORIGIN` to your real site domain, e.g.:

```toml
[vars]
ALLOWED_ORIGIN = "https://drmegha.in"
```

### 5. Deploy

```bash
wrangler deploy
```

Wrangler will print your Worker URL, something like:

```
https://drmegha-skinscan.YOUR-SUBDOMAIN.workers.dev
```

### 6. Point the website at it

In `index.html`, find this line near the top of the `<script>` block:

```js
const SCAN_API_BASE = "https://drmegha-skinscan.YOUR-SUBDOMAIN.workers.dev";
```

Replace it with your actual deployed Worker URL, then redeploy the site to
Cloudflare Pages as usual.

## Viewing saved leads

Every submission is saved to D1. To check leads from your terminal:

```bash
wrangler d1 execute drmegha-leads --remote --command="SELECT * FROM leads ORDER BY created_at DESC LIMIT 20"
```

Or fetch them as JSON (useful for a future admin dashboard):

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" https://drmegha-skinscan.YOUR-SUBDOMAIN.workers.dev/api/leads
```

## Local testing

```bash
wrangler dev
```

This runs the Worker at `http://localhost:8787`, including a local D1
instance. Temporarily point `SCAN_API_BASE` at that URL and set
`ALLOWED_ORIGIN = "*"` in `wrangler.toml` while testing, then revert both
before deploying to production. Local D1 data doesn't carry over to
production — use `--remote` on `d1 execute` to hit the real database.

## Cost expectations

Each scan is one Claude API vision call (~1000 output tokens, one image input).
At typical Instagram-ad-driven volumes (tens to low hundreds of scans/day),
this stays well within a few dollars a month on the API side. Cloudflare
Workers' free tier covers 100,000 requests/day.

## Extending this later

- **Admin dashboard**: build a small password-protected page that calls
  `GET /api/leads` with your `x-admin-key` and renders a sortable table —
  much friendlier for clinic staff than the CLI.
- **Export to CRM**: add a scheduled Worker (cron trigger) that reads new D1
  rows periodically and pushes them into a CRM via webhook.
- **Swap in a dedicated skin-analysis API** (e.g. Haut.AI, Perfect Corp) later
  if you need more clinically consistent scoring than a general vision model —
  only `handleScan` needs to change; the frontend contract stays the same.
- **Store consent proof**: if you want an audit trail, add a `consented_at`
  column to `leads` and record it from the frontend at submit time.
