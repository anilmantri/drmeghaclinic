/**
 * Dr. Megha's Aesthetic Clinic — Skin Scan Microservice
 * Cloudflare Worker: handles multi-angle AI skin analysis + lead capture for
 * the Instagram-ad-driven "AI Skin Scan" widget on the clinic website.
 *
 * Endpoints:
 *   POST /api/scan   — { images: [{angle, data}, ...] }  -> structured skin report JSON
 *   POST /api/lead   — { name, phone, city, age?, ... }   -> saves lead to D1 + forwards email
 *   GET  /api/leads  — (admin, requires x-admin-key)       -> list saved leads as JSON
 *
 * Required secrets (set via `wrangler secret put <NAME>`):
 *   ANTHROPIC_API_KEY   — Anthropic API key, server-side only, never exposed to browser
 *   WEB3FORMS_KEY       — Web3Forms access key for lead notifications (optional)
 *   ADMIN_KEY           — shared secret to view saved leads via GET /api/leads
 *
 * Required bindings (see wrangler.toml):
 *   RATE_LIMIT (KV)     — used for simple per-IP rate limiting
 *   DB (D1)             — stores leads (name, phone, city, age, report summary, timestamp)
 *
 * Required var (see wrangler.toml):
 *   ALLOWED_ORIGIN       — e.g. "https://drmegha.in" — locks down CORS
 */

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

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // ~6MB raw base64 ceiling per image
const MAX_IMAGES = 3;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 5; // per IP per window, on /api/scan

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin, env) });
    }

    try {
      if (url.pathname === '/api/scan' && request.method === 'POST') {
        return await handleScan(request, env, origin);
      }
      if (url.pathname === '/api/lead' && request.method === 'POST') {
        return await handleLead(request, env, origin);
      }
      if (url.pathname === '/api/leads' && request.method === 'GET') {
        return await handleListLeads(request, env, origin);
      }
      return jsonResponse({ error: 'Not found' }, 404, origin, env);
    } catch (err) {
      console.error('Unhandled error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500, origin, env);
    }
  },
};

function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN;
  const allowOrigin = allowed === '*' || origin === allowed ? origin || '*' : allowed;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

async function checkRateLimit(env, ip, bucket) {
  const key = `rl:${bucket}:${ip}`;
  const current = await env.RATE_LIMIT.get(key);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= RATE_LIMIT_MAX_REQUESTS) return false;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return true;
}

async function handleScan(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const allowed = await checkRateLimit(env, ip, 'scan');
  if (!allowed) {
    return jsonResponse({ error: 'Too many requests. Please wait a minute and try again.' }, 429, origin, env);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, origin, env);
  }

  const { images } = payload || {};
  if (!Array.isArray(images) || images.length === 0) {
    return jsonResponse({ error: 'Missing images' }, 400, origin, env);
  }
  if (images.length > MAX_IMAGES) {
    return jsonResponse({ error: `Too many images (max ${MAX_IMAGES})` }, 400, origin, env);
  }

  const validAngles = new Set(['front', 'left', 'right']);
  const content = [];
  for (const img of images) {
    if (!img || typeof img.data !== 'string' || !validAngles.has(img.angle)) {
      return jsonResponse({ error: 'Invalid image entry' }, 400, origin, env);
    }
    if (img.data.length > MAX_IMAGE_BYTES) {
      return jsonResponse({ error: 'Image too large' }, 413, origin, env);
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(img.data.slice(0, 100))) {
      return jsonResponse({ error: 'Invalid image data' }, 400, origin, env);
    }
    content.push({ type: 'text', text: `Angle: ${img.angle}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data } });
  }
  content.push({ type: 'text', text: 'Analyze these photos per the schema, using all angles together.' });

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
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
    return jsonResponse({ error: 'Analysis service is temporarily unavailable.' }, 502, origin, env);
  }

  const data = await anthropicRes.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  const raw = (textBlock?.text || '').trim().replace(/^```json|```$/g, '').trim();

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error('Failed to parse model output as JSON:', raw);
    return jsonResponse({ error: 'Could not parse analysis. Please try again.' }, 502, origin, env);
  }

  // Image is never persisted — processed in-memory only, discarded after this response.
  return jsonResponse(report, 200, origin, env);
}

async function handleLead(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  const allowed = await checkRateLimit(env, ip, 'lead');
  if (!allowed) {
    return jsonResponse({ error: 'Too many requests. Please wait a minute and try again.' }, 429, origin, env);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, origin, env);
  }

  const { name, phone, city, age, report_summary, suggested_focus_areas, source } = payload || {};

  if (!name || !phone || !city || typeof name !== 'string' || typeof phone !== 'string' || typeof city !== 'string') {
    return jsonResponse({ error: 'Name, phone, and city are required' }, 400, origin, env);
  }
  if (name.length > 200 || phone.length > 50 || city.length > 100) {
    return jsonResponse({ error: 'Invalid input length' }, 400, origin, env);
  }
  const ageNum = age ? parseInt(age, 10) : null;
  if (age && (isNaN(ageNum) || ageNum < 1 || ageNum > 120)) {
    return jsonResponse({ error: 'Invalid age' }, 400, origin, env);
  }

  const focusAreasStr = Array.isArray(suggested_focus_areas) ? suggested_focus_areas.join(', ') : '';
  const createdAt = new Date().toISOString();

  // Persist to D1 — this is the source of truth for the clinic's lead list.
  try {
    await env.DB.prepare(
      `INSERT INTO leads (name, phone, city, age, report_summary, suggested_focus_areas, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(name, phone, city, ageNum, report_summary || '', focusAreasStr, source || 'skin_scan_widget', createdAt)
      .run();
  } catch (err) {
    console.error('D1 insert failed:', err);
    return jsonResponse({ error: 'Could not save your details. Please try again.' }, 500, origin, env);
  }

  // Also forward to Web3Forms so the clinic gets an immediate email, same as
  // the main appointment form. This is best-effort — DB save above is what matters.
  if (env.WEB3FORMS_KEY) {
    try {
      await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_key: env.WEB3FORMS_KEY,
          subject: 'New AI Skin Scan Lead — Dr. Megha\'s Aesthetic Clinic',
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
    }
  }

  return jsonResponse({ success: true }, 200, origin, env);
}

async function handleListLeads(request, env, origin) {
  const adminKey = request.headers.get('x-admin-key');
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin, env);
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, phone, city, age, report_summary, suggested_focus_areas, source, created_at
       FROM leads ORDER BY created_at DESC LIMIT 500`
    ).all();
    return jsonResponse({ leads: results }, 200, origin, env);
  } catch (err) {
    console.error('D1 query failed:', err);
    return jsonResponse({ error: 'Could not fetch leads' }, 500, origin, env);
  }
}
