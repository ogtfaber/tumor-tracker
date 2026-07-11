/* Tumor Tracker Worker — serves the static app and a small publish API.
   Published datasets live in the PUBLISHED KV namespace under `pub:<CODE>`;
   the gallery summary is stored as KV *metadata* so listing needs no reads. */

const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;
const MAX_BODY = 100_000;
const TYPES = { x: ['x'], xy: ['x', 'y'], vol: ['v'] };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s);
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function genToken() {
  const buf = crypto.getRandomValues(new Uint8Array(24));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Server-side twin of the client's normalize(): rebuild the dataset from
// scratch so only known fields with valid shapes are ever stored. Returns
// null when the input is not recognizably a tracker dataset.
function validateDataset(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { schemaVersion: 1, diagnosis: 'NF2', code: null, tumors: [], drugs: [], events: [] };
  const diagnosis = str(raw.diagnosis, 40);
  if (diagnosis) out.diagnosis = diagnosis;
  if (typeof raw.code === 'string' && CODE_RE.test(raw.code)) out.code = raw.code;
  for (const t of Array.isArray(raw.tumors) ? raw.tumors : []) {
    const name = t && str(t.name, 80);
    const keys = t && TYPES[t.type];
    if (!name || !keys) continue;
    const tumor = { id: str(t.id, 40) || crypto.randomUUID(), name, type: t.type, measurements: [] };
    for (const m of Array.isArray(t.measurements) ? t.measurements : []) {
      if (!m || !isDate(m.date)) continue;
      const rec = { id: str(m.id, 40) || crypto.randomUUID(), date: m.date, note: str(m.note, 500) };
      for (const k of keys) rec[k] = isNum(m[k]) ? m[k] : null;
      if (keys.some((k) => rec[k] !== null)) tumor.measurements.push(rec);
    }
    tumor.measurements.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    out.tumors.push(tumor);
    if (out.tumors.length >= 50) break;
  }
  for (const d of Array.isArray(raw.drugs) ? raw.drugs : []) {
    const name = d && str(d.name, 60);
    if (!name || !isDate(d.start)) continue;
    out.drugs.push({
      id: str(d.id, 40) || crypto.randomUUID(), name, start: d.start,
      end: isDate(d.end) ? d.end : null,
      dose: isNum(d.dose) && d.dose > 0 ? d.dose : null,
      note: str(d.note, 500),
    });
    if (out.drugs.length >= 200) break;
  }
  for (const e of Array.isArray(raw.events) ? raw.events : []) {
    const label = e && str(e.label, 80);
    if (!label || !isDate(e.date)) continue;
    const tumorId = typeof e.tumorId === 'string' && out.tumors.some((t) => t.id === e.tumorId) ? e.tumorId : null;
    out.events.push({ id: str(e.id, 40) || crypto.randomUUID(), date: e.date, label, tumorId });
    if (out.events.length >= 200) break;
  }
  return out;
}

// Gallery card data; stored as KV metadata (hard limit 1024 bytes — every
// field here is short and bounded, diagnosis is capped at 40 chars).
function summarize(data, publishedAt, updatedAt) {
  const dates = [];
  let measurementCount = 0;
  for (const t of data.tumors) {
    measurementCount += t.measurements.length;
    for (const m of t.measurements) dates.push(m.date);
  }
  dates.sort();
  return {
    code: data.code,
    diagnosis: data.diagnosis,
    tumorCount: data.tumors.length,
    measurementCount,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    publishedAt,
    updatedAt,
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

async function handlePublish(request, env) {
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Dataset too large to publish (100 KB limit).' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON.' }, 400); }

  const code = typeof body.code === 'string' ? body.code : '';
  if (!CODE_RE.test(code)) return json({ error: 'Invalid patient code.' }, 400);
  const clean = validateDataset(body.data);
  if (!clean) return json({ error: 'That does not look like a Tumor Tracker dataset.' }, 400);
  if (clean.code !== code) return json({ error: 'The dataset code does not match the publish code.' }, 400);
  if (!clean.tumors.some((t) => t.measurements.length >= 2)) {
    return json({ error: 'Publishing needs at least one tumor with two or more measurements.' }, 400);
  }

  const key = 'pub:' + code;
  const existing = await env.PUBLISHED.getWithMetadata(key, 'json');
  const now = new Date().toISOString();
  let token = null;
  let tokenHash;
  let publishedAt = now;

  if (existing.value) {
    const given = typeof body.token === 'string' ? body.token : '';
    if (!TOKEN_RE.test(given) || (await sha256hex(given)) !== existing.value.tokenHash) {
      return json({ error: 'This ID is already published and the update token does not match.' }, 403);
    }
    tokenHash = existing.value.tokenHash;
    publishedAt = existing.metadata?.publishedAt || now;
  } else {
    token = genToken();
    tokenHash = await sha256hex(token);
  }

  const summary = summarize(clean, publishedAt, now);
  await env.PUBLISHED.put(key, JSON.stringify({ tokenHash, data: clean }), { metadata: summary });
  return json(token ? { ok: true, token, summary } : { ok: true, summary });
}

async function handleGetOne(env, code) {
  const entry = await env.PUBLISHED.getWithMetadata('pub:' + code, 'json');
  if (!entry.value) return json({ error: 'Not published.' }, 404);
  return json({ data: entry.value.data, summary: entry.metadata || null });
}

// Serve index.html for a viewer route, stamped noindex. The app reads
// location.pathname to decide what to render.
async function serveApp(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url.origin)));
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const viewMatch = path.match(/^\/p\/([A-HJKMNP-Z2-9]{6})$/);
    if (viewMatch || path === '/explore') return serveApp(env, url);

    if (path === '/api/publish' && request.method === 'POST') return handlePublish(request, env);

    const oneMatch = path.match(/^\/api\/published\/([A-HJKMNP-Z2-9]{6})$/);
    if (oneMatch && request.method === 'GET') return handleGetOne(env, oneMatch[1]);

    if (path.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
