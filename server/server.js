/**
 * Dr. Megha's Aesthetic Clinic — Skin Scan Microservice (Render version)
 * Node/Express backend: handles multi-angle AI skin analysis + lead capture
 * for the Instagram-ad-driven "AI Skin Scan" widget on the clinic website.
 *
 * Endpoints:
 *   POST /api/scan   — { images: [{angle, data}, ...] }  -> structured skin report JSON
 *   POST /api/lead   — { name, phone, city, age?, ... }   -> saves lead to Postgres + forwards email
 *   GET  /api/leads  — (admin, requires x-admin-key)       -> list saved leads as JSON
 *   GET  /health     — plain 200 OK, for Render health checks
 *
 * Required environment variables (set in Render dashboard, see README.md):
 *   AI_PROVIDER            — "anthropic" | "gemini". Selects which vision API /api/scan uses.
 *                            Default: "anthropic" if unset or invalid.
 *   ANTHROPIC_API_KEY       — required when AI_PROVIDER=anthropic
 *   GEMINI_API_KEY          — required when AI_PROVIDER=gemini. Note: whether this key runs on
 *                            Gemini's free or paid tier is controlled by billing on the Google
 *                            Cloud project behind the key, not by this app — enable billing on
 *                            that project when you're ready for production traffic.
 *   DATABASE_URL            — Postgres connection string (Render provides this automatically
 *                             if you link a Render PostgreSQL database to this service)
 *   ALLOWED_ORIGIN          — e.g. "https://drmegha.in" — locks down CORS
 *   ADMIN_KEY               — shared secret to view saved leads via GET /api/leads
 *   WEB3FORMS_KEY           — optional, Web3Forms access key for lead email notifications
 *
 * Cost control: incoming images are resized to max 1024px and re-compressed
 * to JPEG @ 80% quality (via sharp) before being sent to the vision API.
 * This significantly cuts per-scan vision token cost with negligible impact
 * on analysis quality for this use case.
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const sharp = require('sharp');

const app = express();
app.use(express.json({ limit: '15mb' })); // 3 images * ~4-5mb base64 headroom

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.5-flash';
const ADMIN_KEY = process.env.ADMIN_KEY;
const WEB3FORMS_KEY = process.env.WEB3FORMS_KEY;

const VALID_PROVIDERS = new Set(['anthropic', 'gemini']);
const rawProvider = String(process.env.AI_PROVIDER || '').toLowerCase();
const AI_PROVIDER = VALID_PROVIDERS.has(rawProvider) ? rawProvider : 'anthropic';
if (process.env.AI_PROVIDER && !VALID_PROVIDERS.has(rawProvider)) {
  console.error(`AI_PROVIDER="${process.env.AI_PROVIDER}" is not valid (use "anthropic" or "gemini"). Falling back to "anthropic".`);
}

console.log(`AI provider: ${AI_PROVIDER === 'gemini' ? `Gemini (${GEMINI_MODEL})` : 'Anthropic'}`);

if (AI_PROVIDER === 'gemini' && !GEMINI_API_KEY) {
  console.error('AI_PROVIDER is "gemini" but GEMINI_API_KEY is not set. Set it in your environment variables.');
}
if (AI_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) {
  console.error('AI_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set. Set it in your environment variables.');
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // ~6MB raw base64 ceiling per image
const MAX_IMAGES = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

app.use(cors({ origin: ALLOWED_ORIGIN }));

// --- Database setup (Render PostgreSQL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT NOT NULL,
      age INTEGER,
      report_summary TEXT,
      suggested_focus_areas TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
  `);
}

// --- Simple in-memory per-IP rate limiter ---
// Note: this resets on deploy/restart and only tracks per-instance.
// Fine for a single Render instance; move to Redis/Postgres if you scale to multiple instances.
const rateBuckets = new Map(); // key -> { count, windowStart }

function checkRateLimit(bucket, ip) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

/**
 * Resizes and compresses a base64 image to cut Anthropic vision token cost.
 * Claude's per-image token cost scales with pixel count, so downscaling to
 * a sensible max dimension + moderate JPEG quality before sending it in
 * meaningfully reduces cost with negligible impact on analysis quality for
 * this use case (skin observations, not pixel-level diagnostics).
 * @param {string} base64Data - raw base64 image data (no data: prefix)
 * @returns {Promise<string>} compressed base64 JPEG data
 */
async function compressImage(base64Data) {
  const inputBuffer = Buffer.from(base64Data, 'base64');
  const outputBuffer = await sharp(inputBuffer)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return outputBuffer.toString('base64');
}

const SCAN_SYSTEM_PROMPT = `You are assisting a licensed dermatology clinic with an AI-generated indicative skin observation tool, used only for marketing/lead purposes -- never as a medical diagnosis.

You will be shown up to 3 selfies of the same person: front-facing, left profile, and right profile, each labeled. Use all provided angles together to form a fuller picture -- e.g. cheeks and jawline are often clearer in profile shots. Return ONLY valid JSON (no markdown fences, no preamble) matching exactly this schema:

{
  "capture_quality": { "lighting": "good | uneven | poor", "usable": true },
  "observations": [
    { "area": "forehead | cheeks | nose | chin | under_eyes | overall", "concern": "acne | pigmentation | redness | texture | pores | fine_lines | dark_circles | dullness", "severity": "mild | moderate | noticeable", "note": "1 short plain-language sentence" }
  ],
  "summary": "2-3 friendly, non-alarming sentences",
  "suggested_focus_areas": ["short phrase", "short phrase"],
  "disclaimer": "This is an AI-generated indicative assessment, not a medical diagnosis. Please consult Dr. Megha for a professional evaluation."
}

Rules:
- Never use clinical diagnosis terms (no "rosacea", "melasma", "eczema" etc) -- describe only visible traits like redness, pigmentation, texture, pores.
- If lighting is poor across the images, a face isn't clearly visible in one or more of them, or an image does not show a human face, set capture_quality.usable to false, keep observations empty, and explain in summary which angle(s) need a retake.
- Keep tone warm and encouraging, never alarming.
- Return 4-6 observations maximum for a usable set, drawing from whichever angle shows each concern most clearly.
- Output raw JSON only.`;

// --- Routes ---

app.get('/health', (req, res) => res.status(200).send('ok'));

app.post('/api/scan', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit('scan', ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const { images } = req.body || {};
  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Missing images' });
  }
  if (images.length > MAX_IMAGES) {
    return res.status(400).json({ error: `Too many images (max ${MAX_IMAGES})` });
  }

  const validAngles = new Set(['front', 'left', 'right']);
  const compressedImages = []; // [{ angle, data }]
  for (const img of images) {
    if (!img || typeof img.data !== 'string' || !validAngles.has(img.angle)) {
      return res.status(400).json({ error: 'Invalid image entry' });
    }
    if (img.data.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Image too large' });
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(img.data.slice(0, 100))) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    let compressedData;
    try {
      compressedData = await compressImage(img.data);
    } catch (err) {
      console.error('Image compression failed:', err);
      return res.status(400).json({ error: 'Could not process one of the images. Please retake and try again.' });
    }

    compressedImages.push({ angle: img.angle, data: compressedData });
  }

  try {
    const raw = AI_PROVIDER === 'gemini'
      ? await callGemini(compressedImages)
      : await callAnthropic(compressedImages);

    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      console.error('Failed to parse model output as JSON:', raw);
      return res.status(502).json({ error: 'Could not parse analysis. Please try again.' });
    }

    // Images are never persisted — processed in memory only, discarded after this response.
    return res.status(200).json(report);
  } catch (err) {
    console.error('Scan error:', err);
    return res.status(err.status || 500).json({ error: err.publicMessage || 'Internal server error' });
  }
});

/**
 * Calls Anthropic's vision API with the given angle-labeled images.
 * Used when AI_PROVIDER=anthropic.
 */
async function callAnthropic(compressedImages) {
  const content = [];
  for (const img of compressedImages) {
    content.push({ type: 'text', text: `Angle: ${img.angle}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data } });
  }
  content.push({ type: 'text', text: 'Analyze these photos per the schema, using all angles together.' });

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: SCAN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    console.error('Anthropic API error:', anthropicRes.status, errText);
    throw { status: 502, publicMessage: 'Analysis service is temporarily unavailable.' };
  }

  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return (textBlock?.text || '').trim().replace(/^```json|```$/g, '').trim();
}

/**
 * Calls Google's Gemini vision API with the given angle-labeled images.
 * Used when AI_PROVIDER=gemini — typically cheaper for iterating on the widget
 * without burning Anthropic credits. Swap GEMINI_MODEL at the top of this
 * file if you want a different Gemini model.
 */
async function callGemini(compressedImages) {
  const parts = [];
  for (const img of compressedImages) {
    parts.push({ text: `Angle: ${img.angle}` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: img.data } });
  }
  parts.push({ text: 'Analyze these photos per the schema, using all angles together.' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SCAN_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: 1200, temperature: 0.4 },
    }),
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    console.error('Gemini API error:', geminiRes.status, errText);
    throw { status: 502, publicMessage: 'Analysis service is temporarily unavailable.' };
  }

  const data = await geminiRes.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text.trim().replace(/^```json|```$/g, '').trim();
}

app.post('/api/lead', async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit('lead', ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const { name, phone, city, age, report_summary, suggested_focus_areas, source } = req.body || {};

  if (!name || !phone || !city || typeof name !== 'string' || typeof phone !== 'string' || typeof city !== 'string') {
    return res.status(400).json({ error: 'Name, phone, and city are required' });
  }
  if (name.length > 200 || phone.length > 50 || city.length > 100) {
    return res.status(400).json({ error: 'Invalid input length' });
  }
  const ageNum = age ? parseInt(age, 10) : null;
  if (age && (isNaN(ageNum) || ageNum < 1 || ageNum > 120)) {
    return res.status(400).json({ error: 'Invalid age' });
  }

  const focusAreasStr = Array.isArray(suggested_focus_areas) ? suggested_focus_areas.join(', ') : '';

  try {
    await pool.query(
      `INSERT INTO leads (name, phone, city, age, report_summary, suggested_focus_areas, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [name, phone, city, ageNum, report_summary || '', focusAreasStr, source || 'skin_scan_widget']
    );
  } catch (err) {
    console.error('Postgres insert failed:', err);
    return res.status(500).json({ error: 'Could not save your details. Please try again.' });
  }

  if (WEB3FORMS_KEY) {
    try {
      await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key: WEB3FORMS_KEY,
          subject: "New AI Skin Scan Lead — Dr. Megha's Aesthetic Clinic",
          name,
          phone,
          city,
          age: ageNum || 'Not provided',
          report_summary: report_summary || '',
          suggested_focus_areas: focusAreasStr,
          source: source || 'skin_scan_widget',
        }),
      });
    } catch (err) {
      console.error('Web3Forms forward failed:', err);
      // Best-effort only — DB save above is what matters.
    }
  }

  return res.status(200).json({ success: true });
});

app.get('/api/leads', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, city, age, report_summary, suggested_focus_areas, source, created_at
       FROM leads ORDER BY created_at DESC LIMIT 500`
    );
    return res.status(200).json({ leads: rows });
  } catch (err) {
    console.error('Postgres query failed:', err);
    return res.status(500).json({ error: 'Could not fetch leads' });
  }
});

// --- Startup ---
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Skin scan service listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
