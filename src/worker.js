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

// Gallery card data; stored as KV *metadata* (hard limit 1024 bytes — every
// field here is short and bounded, diagnosis is capped at 40 chars, and the
// sparkline is thinned, then dropped, until the whole summary fits).
const SPARK_POINTS = 24;

// Preview series for the gallery card: the first tumor (in stored order)
// whose first plottable key has at least two non-null values. Days are
// offsets from the series' first date; values are rounded to 2 decimals.
function sparkline(data) {
  for (const t of data.tumors) {
    for (const key of TYPES[t.type]) {
      const pts = t.measurements.filter((m) => m[key] !== null);
      if (pts.length < 2) continue;
      const first = Date.parse(pts[0].date);
      const d = pts.map((m) => Math.round((Date.parse(m.date) - first) / 86400000));
      const v = pts.map((m) => Math.round(m[key] * 100) / 100);
      return { d, v };
    }
  }
  return null;
}

// Evenly thin a spark to at most `max` points, always keeping first and last.
function thin(spark, max) {
  const n = spark.d.length;
  if (n <= max) return spark;
  const pick = [];
  for (let i = 0; i < max; i++) pick.push(Math.round((i * (n - 1)) / (max - 1)));
  return { d: pick.map((j) => spark.d[j]), v: pick.map((j) => spark.v[j]) };
}

const metaBytes = (obj) => new TextEncoder().encode(JSON.stringify(obj)).length;

function summarize(data, publishedAt, updatedAt) {
  const dates = [];
  let measurementCount = 0;
  for (const t of data.tumors) {
    measurementCount += t.measurements.length;
    for (const m of t.measurements) dates.push(m.date);
  }
  dates.sort();
  const summary = {
    code: data.code,
    diagnosis: data.diagnosis,
    tumorCount: data.tumors.length,
    measurementCount,
    drugCount: data.drugs.length,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    publishedAt,
    updatedAt,
  };
  let spark = sparkline(data);
  if (spark) spark = thin(spark, SPARK_POINTS);
  if (spark && metaBytes({ ...summary, spark }) > 1000) spark = thin(spark, 12);
  if (spark && metaBytes({ ...summary, spark }) > 1000) spark = null;
  if (spark) summary.spark = spark;
  return summary;
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid JSON.' }, 400);

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

// Soft per-IP limit on writes. KV is eventually consistent so this is
// best-effort, which is fine — it only needs to stop casual flooding.
async function allowWrite(env, ip) {
  const key = `rl:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const n = parseInt((await env.PUBLISHED.get(key)) || '0', 10);
  if (n >= 10) return false;
  await env.PUBLISHED.put(key, String(n + 1), { expirationTtl: 120 });
  return true;
}

async function handleList(env) {
  // Summaries live in metadata, so one list() call is the whole gallery.
  // KV returns at most 1000 keys per page; beyond that this needs cursor
  // paging — log-worthy, not plan-worthy, at this scale.
  const list = await env.PUBLISHED.list({ prefix: 'pub:' });
  const items = list.keys
    .map((k) => k.metadata)
    .filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return json({ items });
}

async function handleDelete(request, env, code) {
  const key = 'pub:' + code;
  const existing = await env.PUBLISHED.get(key, 'json');
  if (!existing) return json({ ok: true }); // idempotent

  const adminGiven = request.headers.get('X-Admin-Key');
  const isAdmin = !!(adminGiven && env.ADMIN_KEY &&
    (await sha256hex(adminGiven)) === (await sha256hex(env.ADMIN_KEY)));
  if (!isAdmin) {
    let body = {};
    try { body = await request.json(); } catch {}
    const given = typeof body.token === 'string' ? body.token : '';
    if (!TOKEN_RE.test(given) || (await sha256hex(given)) !== existing.tokenHash) {
      return json({ error: 'The update token does not match.' }, 403);
    }
  }
  await env.PUBLISHED.delete(key);
  return json({ ok: true });
}

// Rebuild every published entry's card metadata from its stored dataset —
// lets summary-shape changes (new fields, spark format) roll out without
// anyone republishing. Values are re-put unchanged; timestamps carry over.
async function handleResummarize(request, env) {
  const given = request.headers.get('X-Admin-Key');
  const isAdmin = !!(given && env.ADMIN_KEY &&
    (await sha256hex(given)) === (await sha256hex(env.ADMIN_KEY)));
  if (!isAdmin) return json({ error: 'Forbidden.' }, 403);
  const list = await env.PUBLISHED.list({ prefix: 'pub:' });
  let updated = 0;
  for (const k of list.keys) {
    const entry = await env.PUBLISHED.getWithMetadata(k.name, 'json');
    if (!entry.value || !entry.value.data) continue;
    const now = new Date().toISOString();
    const summary = summarize(
      entry.value.data,
      entry.metadata?.publishedAt || now,
      entry.metadata?.updatedAt || now,
    );
    await env.PUBLISHED.put(k.name, JSON.stringify(entry.value), { metadata: summary });
    updated++;
  }
  return json({ ok: true, updated });
}

// Serve index.html for a viewer route, stamped noindex. The app reads
// location.pathname to decide what to render. Viewer routes live one path
// segment deep (/p/CODE), so a <base> tag is injected here to pin relative
// asset URLs (style.css, app.js, vendor/*) to the site root — the tag can't
// live in index.html itself, or opening the file straight from disk (the
// documented local-only path) would resolve assets against file:///.
async function serveApp(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url.origin)));
  const html = (await res.text()).replace('<head>', '<head>\n<base href="/">');
  const out = new Response(html, res);
  out.headers.set('X-Robots-Tag', 'noindex');
  out.headers.delete('Content-Length');
  out.headers.delete('ETag');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const viewMatch = path.match(/^\/p\/([A-HJKMNP-Z2-9]{6})$/);
    if (viewMatch || path === '/explore') return serveApp(env, url);

    if (path.startsWith('/api/')) {
      const oneMatch = path.match(/^\/api\/published\/([A-HJKMNP-Z2-9]{6})$/);
      const isWrite = (path === '/api/publish' && request.method === 'POST') ||
                      (oneMatch && request.method === 'DELETE');
      if (isWrite) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!(await allowWrite(env, ip))) {
          return json({ error: 'Too many requests — try again in a minute.' }, 429);
        }
      }
      if (path === '/api/admin/resummarize' && request.method === 'POST') return handleResummarize(request, env);
      if (path === '/api/publish' && request.method === 'POST') return handlePublish(request, env);
      if (path === '/api/published' && request.method === 'GET') return handleList(env);
      if (oneMatch && request.method === 'GET') return handleGetOne(env, oneMatch[1]);
      if (oneMatch && request.method === 'DELETE') return handleDelete(request, env, oneMatch[1]);
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
