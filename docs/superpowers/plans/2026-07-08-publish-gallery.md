# Anonymous Publishing & Public Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user explicitly publish their anonymous dataset (keyed by the existing 6-char patient code) to a Cloudflare Worker + KV backend, browsable at a public `/explore` gallery and read-only `/p/<CODE>` detail pages, with token-authorized updates and unpublish.

**Architecture:** The static site gains a Worker entry (`src/worker.js`, ES modules) that serves the existing assets and adds a small JSON API over one KV namespace (`PUBLISHED`). The client (`app.js` IIFE) gains a publish section with a preview-and-consent dialog, and a viewer mode driven by the URL path that renders fetched published data through the existing chart pipeline without touching localStorage. Spec: `docs/superpowers/specs/2026-07-08-publish-design.md`.

**Tech Stack:** Cloudflare Workers (ES modules, Web Crypto), Workers KV (summaries in KV *metadata* so the gallery list needs no N+1 reads), vanilla ES5-style JS in `app.js` (no build step, no test framework — Worker endpoints are verified with `curl`, UI manually/Playwright against `npx wrangler dev`).

## Global Constraints

- Patient-code regex (shared client/server): `/^[A-HJKMNP-Z2-9]{6}$/`.
- Publish token: 48 lowercase hex chars (24 random bytes); regex `/^[0-9a-f]{48}$/`. Server stores only its SHA-256 hex hash, never the token.
- localStorage keys (never inside `state`): `tumorTracker.publishToken`, `tumorTracker.publishedAt`.
- KV keys: published entry `pub:<CODE>` (value `{ tokenHash, data }`, metadata = gallery summary ≤ 1024 bytes); rate-limit counter `rl:<ip>:<minuteBucket>` with `expirationTtl: 120`.
- Server limits: request body ≤ 100 000 chars; ≥ 1 tumor with ≥ 2 measurements ("minimum substance"); 10 writes/IP/minute.
- All viewer/API responses carry `X-Robots-Tag: noindex`; viewer pages also inject `<meta name="robots" content="noindex">`.
- `app.js` code style: `var`, ES5 functions, promise `.then()` chains (no async/await), 2-space indent, section banner comments `// ---------------- x ----------------`. `src/worker.js` is a NEW file: modern ES modules JS is correct there.
- Verification server: `npx wrangler dev` (defaults to `http://localhost:8787`). Do not use `python3 -m http.server` for this feature — the API and route rewrites only exist under wrangler.
- No test harness exists; do not add one.

---

### Task 1: Worker skeleton — config, asset pass-through, viewer rewrites, noindex

**Files:**
- Create: `src/worker.js`
- Modify: `wrangler.jsonc`
- Modify: `.gitignore`
- Create: `.dev.vars` (local only, gitignored)

**Interfaces:**
- Produces: `wrangler.jsonc` bindings `ASSETS` (assets) and `PUBLISHED` (KV), secret `ADMIN_KEY`; Worker routes `GET /p/<CODE>` and `GET /explore` serving `index.html` with `X-Robots-Tag: noindex`; helpers `json()`, `CODE_RE`, `noindex()` used by Tasks 2–3. Task 2 extends the same `fetch` router.

- [ ] **Step 1: Update `wrangler.jsonc`**

Replace the whole file with:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "tumor-tracker",
  "main": "src/worker.js",
  "compatibility_date": "2026-07-07",
  "observability": {
    "enabled": true
  },
  "assets": {
    "directory": ".",
    "binding": "ASSETS"
  },
  "kv_namespaces": [
    { "binding": "PUBLISHED", "id": "local-dev-placeholder" }
  ],
  "compatibility_flags": [
    "nodejs_compat"
  ]
}
```

`wrangler dev` runs KV locally and never checks the `id`. Before a real deploy, run `npx wrangler kv namespace create PUBLISHED` and paste the returned id over `local-dev-placeholder` (do this in Task 7, not now, and only if logged in to Cloudflare).

Note the assets directory is the repo root, so `src/worker.js` itself would be a servable asset. Add to `.gitignore`'s sibling concern: create the file `.assetsignore` in the repo root containing:

```
.git
node_modules
src
docs
.dev.vars
wrangler.jsonc
```

(`.assetsignore` is Wrangler's ignore file for asset uploads — keeps server code and specs out of the public site.)

- [ ] **Step 2: Add `.dev.vars` and gitignore it**

Create `.dev.vars`:

```
ADMIN_KEY=dev-admin-key
```

Append to `.gitignore`:

```
.dev.vars
```

- [ ] **Step 3: Write `src/worker.js` (skeleton)**

```js
/* Tumor Tracker Worker — serves the static app and a small publish API.
   Published datasets live in the PUBLISHED KV namespace under `pub:<CODE>`;
   the gallery summary is stored as KV *metadata* so listing needs no reads. */

const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;

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

    if (path.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 4: Verify with wrangler dev + curl**

Run in the background: `npx wrangler dev` (first run may install wrangler via npx; accept). Then:

1. `curl -s http://localhost:8787/ | head -3` — expect the `<!DOCTYPE html>` of `index.html`.
2. `curl -sI http://localhost:8787/p/K7F3QX | grep -i -e '^HTTP' -e robots` — expect `200` and `X-Robots-Tag: noindex`.
3. `curl -s http://localhost:8787/p/K7F3QX | head -3` — expect `index.html` content.
4. `curl -sI http://localhost:8787/explore | grep -i robots` — expect the noindex header.
5. `curl -s http://localhost:8787/api/nope` — expect `{"error":"Not found."}`.
6. `curl -sI http://localhost:8787/src/worker.js | head -1` — expect `404` (assetsignore working).

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc src/worker.js .gitignore .assetsignore
git commit -m "Add Worker entry serving assets plus noindex viewer routes"
```

---

### Task 2: Worker API — validation, publish (create + token-authorized update), fetch one

**Files:**
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `json()`, `CODE_RE`, router from Task 1.
- Produces: `POST /api/publish` body `{ code, token?, data }` → `{ ok, token?, summary }` (token only on first publish); `GET /api/published/<CODE>` → `{ data, summary }`; helpers `sha256hex(s)`, `genToken()`, `validateDataset(raw)` (returns clean dataset or `null`), `summarize(data, publishedAt, updatedAt)`. Task 3 reuses `sha256hex` and the KV shapes; Task 4's client calls these endpoints.

- [ ] **Step 1: Add crypto + validation helpers**

Insert below `CODE_RE` in `src/worker.js`:

```js
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
```

- [ ] **Step 2: Add the publish and fetch-one handlers**

Insert below `summarize`:

```js
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
```

- [ ] **Step 3: Route them**

Replace the `if (path.startsWith('/api/')) { ... }` block in `fetch` with:

```js
    if (path === '/api/publish' && request.method === 'POST') return handlePublish(request, env);

    const oneMatch = path.match(/^\/api\/published\/([A-HJKMNP-Z2-9]{6})$/);
    if (oneMatch && request.method === 'GET') return handleGetOne(env, oneMatch[1]);

    if (path.startsWith('/api/')) {
      return json({ error: 'Not found.' }, 404);
    }
```

- [ ] **Step 4: Verify with curl**

With `npx wrangler dev` running, from the repo root:

```bash
cat > /tmp/pub.json <<'EOF'
{"code":"K7F3QX","data":{"schemaVersion":1,"diagnosis":"NF2","code":"K7F3QX",
 "tumors":[{"id":"t1","name":"Left VS","type":"x","measurements":[
   {"id":"m1","date":"2025-01-10","x":14.2},{"id":"m2","date":"2025-06-10","x":15.1}]}],
 "drugs":[],"events":[]}}
EOF
curl -s -X POST http://localhost:8787/api/publish -d @/tmp/pub.json
```

1. Expect `{"ok":true,"token":"<48 hex>","summary":{...,"tumorCount":1,"measurementCount":2,...}}`. Save the token as `$TOK`.
2. Re-publish without token: same command again → expect `403` with the token-mismatch error.
3. Re-publish with token: edit `/tmp/pub.json` to add `"token":"$TOK"` (top level, next to `code`) and a third measurement → expect `{"ok":true,"summary":...}` with **no** `token` field and `measurementCount:3`, and `publishedAt` unchanged while `updatedAt` moved.
4. `curl -s http://localhost:8787/api/published/K7F3QX` → the stored data + summary; confirm the response contains **no** `tokenHash`.
5. `curl -s http://localhost:8787/api/published/AAAAAA` → `404 {"error":"Not published."}`.
6. Garbage: `curl -s -X POST http://localhost:8787/api/publish -d '{"code":"K7F3QX","data":{"tumors":"nope"}}'` → `400` (fails minimum substance).
7. Substance: publish with only one measurement → `400` with the two-measurements error.

- [ ] **Step 5: Commit**

```bash
git add src/worker.js
git commit -m "Publish API: validated create/update with hashed publish token"
```

---

### Task 3: Worker API — gallery list, delete (token or admin), rate limit

**Files:**
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `sha256hex`, `TOKEN_RE`, KV shapes from Task 2; `ADMIN_KEY` env secret from Task 1.
- Produces: `GET /api/published` → `{ items: [summary…] }` newest-updated first; `DELETE /api/published/<CODE>` body `{ token }` or header `X-Admin-Key` → `{ ok: true }`; `allowWrite(env, ip)` guard applied to publish and delete.

- [ ] **Step 1: Add list, delete, and rate-limit helpers**

Insert below `handleGetOne`:

```js
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
  const isAdmin = !!(adminGiven && env.ADMIN_KEY && adminGiven === env.ADMIN_KEY);
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
```

- [ ] **Step 2: Route + guard writes**

In `fetch`, replace the API routing block with:

```js
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
      if (path === '/api/publish' && request.method === 'POST') return handlePublish(request, env);
      if (path === '/api/published' && request.method === 'GET') return handleList(env);
      if (oneMatch && request.method === 'GET') return handleGetOne(env, oneMatch[1]);
      if (oneMatch && request.method === 'DELETE') return handleDelete(request, env, oneMatch[1]);
      return json({ error: 'Not found.' }, 404);
    }
```

(This replaces Task 2's separate route lines — publish and get-one move inside this block.)

- [ ] **Step 3: Verify with curl**

With `npx wrangler dev` running (state from Task 2 persists locally):

1. `curl -s http://localhost:8787/api/published` → `{"items":[{ "code":"K7F3QX", ... }]}`.
2. Publish a second dataset with another code (e.g. `M4P2WR`, reuse the Task 2 payload with both `code` fields changed) → list now has 2 items, most recently updated first.
3. Delete with wrong token: `curl -s -X DELETE http://localhost:8787/api/published/M4P2WR -d '{"token":"deadbeef"}'` → `403`.
4. Delete with its real token → `{"ok":true}`; repeat → still `{"ok":true}`; list back to 1 item; `GET /api/published/M4P2WR` → `404`.
5. Admin delete: `curl -s -X DELETE http://localhost:8787/api/published/K7F3QX -H 'X-Admin-Key: dev-admin-key'` → `{"ok":true}` (`.dev.vars` supplies the key). List → `{"items":[]}`.
6. Rate limit: `for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST http://localhost:8787/api/publish -d @/tmp/pub.json; done` → later requests return `429`.
7. Re-publish `K7F3QX` once more (fresh token — the old entry is gone) so client tasks have data; note the new token.

- [ ] **Step 4: Commit**

```bash
git add src/worker.js
git commit -m "Publish API: gallery list, token/admin delete, per-IP rate limit"
```

---

### Task 4: Client — publish section, preview + consent dialog, token lifecycle

**Files:**
- Modify: `index.html` (new section above `#clear-section`; new dialog next to `#png-dialog`)
- Modify: `style.css` (publish section + dialog styles, end of file)
- Modify: `app.js` (constants ~line 30; `exportData()` ~line 1065; import handler ~line 1082; `#btn-clear` handler ~line 1119; `renderAll()` ~line 308; new `// ---------------- publishing ----------------` section before `// ---------------- onboarding ----------------`)

**Interfaces:**
- Consumes: Worker endpoints from Tasks 2–3; existing `state`, `hasData()`, `esc()`, `fmtDate()`, `toast()`, `armTwoStep()`, `renderAll()`.
- Produces: constants `PUBLISH_TOKEN_KEY = 'tumorTracker.publishToken'`, `PUBLISHED_AT_KEY = 'tumorTracker.publishedAt'`, `TOKEN_RE`; helpers `getPublishToken()`, `setPublished(token, whenIso)`, `clearPublished()`, `renderPublish()` (called from `renderAll`). Task 5 relies on none of these directly but shares `renderAll`.

- [ ] **Step 1: Markup — section + dialog in `index.html`**

Insert immediately **above** the `<!-- ============ CLEAR DATA ============ -->` comment:

```html
  <!-- ============ PUBLISH ============ -->
  <section class="data-section" id="publish-section" aria-labelledby="publish-heading" hidden>
    <div class="section-head">
      <h2 id="publish-heading">Share anonymously</h2>
      <p class="section-hint">Put a copy of this dataset — identified only by its Patient ID —
        on the <a href="/explore">public gallery</a> so other patients can see a real course
        over time. Nothing syncs automatically: you choose when to push an update.</p>
    </div>
    <p id="publish-status" class="publish-status" hidden></p>
    <div class="publish-actions">
      <button id="btn-publish" class="btn btn-primary" type="button">Publish anonymously…</button>
      <button id="btn-publish-update" class="btn btn-primary" type="button" hidden
        title="Pushes the data as it is right now to the public page — check any new notes or labels for identifying details first.">Update published data</button>
      <a id="publish-link" class="linklike" target="_blank" rel="noopener" hidden>View public page</a>
      <button id="btn-unpublish" class="btn btn-danger" type="button" hidden>Unpublish</button>
    </div>
  </section>
```

Insert after the closing `</dialog>` of `#png-dialog`:

```html
<dialog id="publish-dialog">
  <form id="publish-form" method="dialog">
    <h3>Publish anonymously</h3>
    <p class="dialog-note">This publishes the data below to a page anyone can open, identified
      only by ID <strong id="publish-dialog-code"></strong>. Read your own words — tumor names,
      event labels, medication notes — and remove anything identifying (hospitals, doctors,
      places, dates of well-known events) before publishing.</p>
    <div id="publish-preview" class="publish-preview"></div>
    <label class="publish-consent">
      <input type="checkbox" id="publish-consent">
      <span>I understand this will be publicly visible to anyone on the internet.</span>
    </label>
    <div class="dialog-actions">
      <button type="button" id="publish-cancel" class="btn btn-ghost">Cancel</button>
      <button type="submit" id="publish-confirm" class="btn btn-primary" disabled>Publish</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 2: Styles in `style.css`**

Append at the end of the file:

```css
/* ---------------- Publish section & dialog ---------------- */

.publish-status {
  font-size: .85rem;
  color: var(--ink-2);
  margin: 0 0 .8rem;
}
.publish-actions {
  display: flex;
  align-items: center;
  gap: .8rem;
  flex-wrap: wrap;
}
#publish-dialog {
  border: 1px solid var(--hairline);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink);
  padding: 1.4rem 1.6rem;
  width: min(34rem, 92vw);
  box-shadow: 0 12px 40px rgba(0, 0, 0, .25);
}
#publish-dialog::backdrop { background: rgba(0, 0, 0, .35); }
#publish-dialog h3 {
  margin: 0 0 1rem;
  font-family: var(--font-display);
  font-size: 1.15rem;
}
.publish-preview {
  max-height: 40vh;
  overflow-y: auto;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  padding: .8rem 1rem;
  margin: .8rem 0;
  font-size: .85rem;
  line-height: 1.5;
}
.publish-preview h4 {
  margin: .8rem 0 .2rem;
  font-size: .68rem;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.publish-preview h4:first-child { margin-top: 0; }
.publish-preview ul { margin: 0; padding-left: 1.1rem; }
.publish-preview .preview-note { color: var(--ink-2); font-style: italic; }
.publish-consent {
  display: flex;
  gap: .5rem;
  align-items: flex-start;
  font-size: .85rem;
  margin: 0 0 1.1rem;
}
```

- [ ] **Step 3: Constants + helpers in `app.js`**

Below the `PATIENT_NAME_KEY` declaration (~line 30), add:

```js
  // Publishing: the secret update token lives outside `state` so a publish
  // payload can never contain it. It IS injected into JSON backups (and read
  // back on import) so a restored backup keeps the right to update.
  var PUBLISH_TOKEN_KEY = 'tumorTracker.publishToken';
  var PUBLISHED_AT_KEY = 'tumorTracker.publishedAt';
  var TOKEN_RE = /^[0-9a-f]{48}$/;
```

In `// ---------------- small helpers ----------------` (near `genCode`), add:

```js
  function getPublishToken() {
    try {
      var t = localStorage.getItem(PUBLISH_TOKEN_KEY);
      return t && TOKEN_RE.test(t) ? t : null;
    } catch (e) { return null; }
  }
  function setPublished(token, whenIso) {
    try {
      localStorage.setItem(PUBLISH_TOKEN_KEY, token);
      if (whenIso) localStorage.setItem(PUBLISHED_AT_KEY, whenIso);
    } catch (e) {}
  }
  function clearPublished() {
    try {
      localStorage.removeItem(PUBLISH_TOKEN_KEY);
      localStorage.removeItem(PUBLISHED_AT_KEY);
    } catch (e) {}
  }
```

- [ ] **Step 4: The publishing section in `app.js`**

Insert a new banner section immediately before `// ---------------- onboarding ----------------`:

```js
  // ---------------- publishing ----------------
  // Everything here is explicit user action; the app never publishes or
  // updates the public copy on its own.

  function apiFetch(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ').'));
        return data;
      });
    });
  }

  function canPublish() {
    return state.tumors.some(function (t) { return t.measurements.length >= 2; });
  }

  function renderPublish() {
    var dataExists = hasData(state);
    var token = getPublishToken();
    $('#publish-section').hidden = !dataExists;
    if (!dataExists) return;
    $('#btn-publish').hidden = !!token;
    $('#btn-publish').disabled = !canPublish();
    $('#btn-publish').title = canPublish() ? '' : 'Needs at least one tumor with two measurements.';
    $('#btn-publish-update').hidden = !token;
    $('#btn-unpublish').hidden = !token;
    var link = $('#publish-link');
    link.hidden = !token;
    if (token) link.href = '/p/' + state.code;
    var status = $('#publish-status');
    var at = null;
    try { at = localStorage.getItem(PUBLISHED_AT_KEY); } catch (e) {}
    status.hidden = !token;
    if (token) {
      status.textContent = 'Published as ' + state.code +
        (at ? ' · last pushed ' + new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
    }
  }

  // Everything free-text, grouped, so the user can screen it before it goes public.
  function publishPreviewHtml() {
    var html = '<h4>Diagnosis</h4><p>' + esc(state.diagnosis || DEFAULT_DIAGNOSIS) + '</p>';
    html += '<h4>Tumors &amp; measurement notes</h4><ul>';
    state.tumors.forEach(function (t) {
      html += '<li>' + esc(t.name) + ' — ' + t.measurements.length + ' measurement(s)';
      t.measurements.forEach(function (m) {
        if (m.note) html += '<br><span class="preview-note">' + esc(fmtDate(m.date) + ': ' + m.note) + '</span>';
      });
      html += '</li>';
    });
    html += '</ul>';
    if (state.drugs.length) {
      html += '<h4>Medications</h4><ul>';
      state.drugs.forEach(function (d) {
        html += '<li>' + esc(d.name) + (d.dose ? ' · ' + d.dose : '') +
          ' · ' + esc(fmtDate(d.start)) + ' – ' + (d.end ? esc(fmtDate(d.end)) : 'ongoing');
        if (d.note) html += '<br><span class="preview-note">' + esc(d.note) + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }
    if (state.events.length) {
      html += '<h4>Events</h4><ul>';
      state.events.forEach(function (e) {
        html += '<li>' + esc(fmtDate(e.date) + ': ' + e.label) + '</li>';
      });
      html += '</ul>';
    }
    return html;
  }

  function pushPublish(token) {
    var body = { code: state.code, data: JSON.parse(JSON.stringify(state)) };
    if (token) body.token = token;
    return apiFetch('POST', '/api/publish', body);
  }

  $('#btn-publish').addEventListener('click', function () {
    $('#publish-dialog-code').textContent = state.code || '';
    $('#publish-preview').innerHTML = publishPreviewHtml();
    $('#publish-consent').checked = false;
    $('#publish-confirm').disabled = true;
    $('#publish-dialog').showModal();
  });

  $('#publish-consent').addEventListener('change', function () {
    $('#publish-confirm').disabled = !this.checked;
  });
  $('#publish-cancel').addEventListener('click', function () { $('#publish-dialog').close(); });

  $('#publish-form').addEventListener('submit', function () {
    pushPublish(null).then(function (res) {
      if (res.token) setPublished(res.token, res.summary.updatedAt);
      renderPublish();
      toast('Published — thank you for sharing.');
    }).catch(function (err) {
      toast('Could not publish: ' + err.message);
    });
  });

  $('#btn-publish-update').addEventListener('click', function () {
    var token = getPublishToken();
    if (!token) return;
    pushPublish(token).then(function (res) {
      setPublished(token, res.summary.updatedAt);
      renderPublish();
      toast('Published copy updated.');
    }).catch(function (err) {
      // A 403 here means the stored token no longer matches the server's —
      // e.g. a backup restored without its token. Per spec, explain and point
      // at the removal path instead of offering a confusing publish-as-new.
      var hint = /token does not match/.test(err.message)
        ? ' This copy can no longer update the public page. To remove the public copy, contact the site owner (see the footer).'
        : '';
      toast('Could not update: ' + err.message + hint);
    });
  });

  $('#btn-unpublish').addEventListener('click', function () {
    if (!armTwoStep(this, 'Click again to remove from the public gallery')) return;
    var token = getPublishToken();
    if (!token) return;
    apiFetch('DELETE', '/api/published/' + state.code, { token: token }).then(function () {
      clearPublished();
      renderPublish();
      toast('Removed from the public gallery.');
    }).catch(function (err) {
      toast('Could not unpublish: ' + err.message);
    });
  });
```

In `renderAll()`, add one line after `$('#clear-section').hidden = !dataExists;`:

```js
    renderPublish();
```

- [ ] **Step 5: Token rides along in backups**

Replace the first line of `exportData()` (`var blob = new Blob([JSON.stringify(state, null, 2)], ...`) with:

```js
    // Backups carry the publish token (outside `state`) so a restored backup
    // can still update the published copy. The server strips it on publish.
    var out = state;
    var token = getPublishToken();
    if (token) {
      out = {};
      for (var k in state) { if (Object.prototype.hasOwnProperty.call(state, k)) out[k] = state[k]; }
      out.publishToken = token;
    }
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
```

In the import handler, change the parse lines from:

```js
      var incoming;
      try { incoming = normalize(JSON.parse(reader.result)); }
      catch (e) { incoming = null; }
```

to:

```js
      var parsed = null, incoming = null;
      try { parsed = JSON.parse(reader.result); incoming = normalize(parsed); }
      catch (e) {}
```

and after `state = incoming;` add:

```js
      // The imported dataset replaces everything — including publish rights.
      if (parsed && typeof parsed.publishToken === 'string' && TOKEN_RE.test(parsed.publishToken)) {
        setPublished(parsed.publishToken, null);
        try { localStorage.removeItem(PUBLISHED_AT_KEY); } catch (e2) {}
      } else {
        clearPublished();
      }
```

(`normalize()` never reads `publishToken`, so it can't leak into `state` — no change needed there.)

- [ ] **Step 6: Clear-all-data knows about the published copy**

In the `#btn-clear` handler, after the `if (!armTwoStep(...)) return;` line, add:

```js
    var pubToken = getPublishToken();
    if (pubToken && state.code) {
      var alsoUnpublish = window.confirm(
        'This data is also published publicly as ID ' + state.code + '.\n\n' +
        'Clearing this browser does NOT remove the public copy.\n\n' +
        'OK = also remove it from the public gallery\nCancel = leave it published'
      );
      if (alsoUnpublish) {
        apiFetch('DELETE', '/api/published/' + state.code, { token: pubToken })
          .then(function () { toast('Removed from the public gallery.'); })
          .catch(function () { toast('Could not reach the server to unpublish.'); });
      }
    }
    clearPublished();
```

- [ ] **Step 7: Verify in the browser**

`npx wrangler dev` running; open `http://localhost:8787/` (Playwright browser tools or manually):

1. Fresh (`localStorage.clear(); location.reload()`): publish section hidden (demo state).
2. Add a tumor + one measurement: section appears, "Publish anonymously…" disabled with the substance tooltip. Add a second measurement: enabled.
3. Click it: dialog shows the ID, all free text (add a drug with a note and an event first to see every group), Publish disabled until the checkbox is ticked.
4. Publish: toast; buttons flip to Update/Unpublish/View public page; status shows "Published as <CODE> · last pushed <today>". `localStorage.getItem('tumorTracker.publishToken')` is 48 hex chars.
5. `curl -s http://localhost:8787/api/published/<CODE>` returns the data; confirm no `publishToken` field inside.
6. Download my data: the JSON file contains `"publishToken"`. Then `localStorage.clear(); location.reload()`, Import that file: Update/Unpublish reappear; click Update → success toast (token survived the round-trip).
7. Unpublish (two clicks): toast; button flips back to Publish; the curl from step 5 now 404s.
8. Publish again, then Clear all data: confirm dialog mentions the public copy; choose OK → gallery entry gone (curl 404) and local data cleared.

- [ ] **Step 8: Commit**

```bash
git add index.html style.css app.js
git commit -m "Publish section: preview-and-consent dialog, token lifecycle, backup carry"
```

---

### Task 5: Client — read-only viewer mode at `/p/<CODE>`

**Files:**
- Modify: `index.html` (viewer banner element in the masthead)
- Modify: `style.css` (`body.viewer` rules, viewer banner)
- Modify: `app.js` (route detection near the top; `save()` guard; boot block at the bottom)

**Interfaces:**
- Consumes: `GET /api/published/<CODE>` (Task 2); Worker rewrite of `/p/<CODE>` → `index.html` (Task 1); `normalize()`, `blankState()`, `renderAll()`.
- Produces: `VIEW` (null, or `{ mode: 'patient', code }`, or `{ mode: 'explore' }`) — Task 6 extends the same boot switch; `body.viewer` class; `#viewer-note` element.

- [ ] **Step 1: Route detection + state guard in `app.js`**

Immediately **above** `// ---------------- state ----------------` (the `var state = load();` line must come after this), add:

```js
  // ---------------- public viewer routes ----------------
  // /p/CODE renders one published dataset read-only; /explore lists all of
  // them. In these modes localStorage is never read or written — `state`
  // holds the fetched copy and vanishes with the tab.
  var VIEW = (function () {
    var m = location.pathname.match(/^\/p\/([A-HJKMNP-Z2-9]{6})$/);
    if (m) return { mode: 'patient', code: m[1] };
    if (location.pathname === '/explore') return { mode: 'explore' };
    return null;
  })();
```

Change `var state = load();` to:

```js
  var state = VIEW ? blankState() : load();
```

(`blankState` and `load` are function declarations, so they hoist above this.)

Add a guard as the first line of `save()`:

```js
    if (VIEW) return; // viewer modes never persist anything
```

- [ ] **Step 2: Viewer banner in `index.html`**

Inside `.masthead-title`, directly under the `<p class="tagline">…</p>` line, add:

```html
      <p id="viewer-note" class="viewer-note" hidden></p>
```

- [ ] **Step 3: Viewer styles in `style.css`**

Append:

```css
/* ---------------- Public viewer mode ---------------- */

/* Read-only: every editing/data section, the import/export buttons, and the
   local-storage privacy note disappear. Charts and Save PNG remain. */
body.viewer .data-section,
body.viewer .masthead-actions,
body.viewer .privacy-note,
body.viewer #empty-state { display: none; }

.viewer-note {
  font-size: .85rem;
  color: var(--ink-2);
  margin: .4rem 0 0;
}
.viewer-note a { color: inherit; }
```

- [ ] **Step 4: Boot logic in `app.js`**

Replace the final `renderAll();` (bottom of the file, after `Chart.defaults.font.family = ...`) with:

```js
  function bootPatientView() {
    document.body.classList.add('viewer');
    var robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    document.title = 'Tumor Tracker — public view ' + VIEW.code;
    var note = $('#viewer-note');
    note.hidden = false;
    note.textContent = 'Loading published data…';
    apiFetch('GET', '/api/published/' + VIEW.code).then(function (res) {
      var incoming = normalize(res.data);
      if (!incoming) throw new Error('unreadable data');
      state = incoming;
      var updated = res.summary && res.summary.updatedAt
        ? new Date(res.summary.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
      note.innerHTML = 'Public view — read-only, shared anonymously' +
        (updated ? ' · updated ' + esc(updated) : '') +
        ' · <a href="/explore">all published datasets</a> · <a href="/">track your own</a>';
      renderAll();
    }).catch(function (err) {
      note.textContent = /404|Not published/.test(err.message)
        ? 'Nothing is published under ID ' + VIEW.code + ' (anymore).'
        : 'Could not load this published dataset — please try again later.';
    });
  }

  if (!VIEW) {
    renderAll();
  } else if (VIEW.mode === 'patient') {
    bootPatientView();
  } else {
    bootExploreView(); // Task 6
  }
```

Until Task 6 lands, add this stub directly above the `if (!VIEW)` block (Task 6 replaces it):

```js
  function bootExploreView() { document.body.classList.add('viewer'); }
```

- [ ] **Step 5: Verify in the browser**

With data published from Task 4 (republish if needed):

1. Open `http://localhost:8787/p/<CODE>` in a fresh browser profile / incognito (no localStorage): charts render exactly like the owner's, header shows the code, banner reads "Public view — read-only…" with both links.
2. No editing UI anywhere: no Tumors/Medications/Events/Share/Clear sections, no Import/Download buttons, no privacy note. **Save PNG is present** on each chart and works (dialog → PNG shows `ID <CODE>`).
3. `localStorage.getItem('tumorTracker.v1')` in that tab → `null` (viewer never persisted).
4. `document.querySelector('meta[name=robots]').content` → `"noindex"`.
5. `http://localhost:8787/p/AAAAAA` → friendly "Nothing is published under ID AAAAAA" message, no console errors.
6. Owner tab at `/` still fully editable (VIEW is null there).

- [ ] **Step 6: Commit**

```bash
git add index.html style.css app.js
git commit -m "Read-only public viewer mode at /p/CODE"
```

---

### Task 6: Client — `/explore` gallery

**Files:**
- Modify: `index.html` (gallery section)
- Modify: `style.css` (gallery cards)
- Modify: `app.js` (replace the `bootExploreView` stub)

**Interfaces:**
- Consumes: `GET /api/published` (Task 3); `VIEW` and boot switch (Task 5); `esc()`, `fmtDate()`, `apiFetch()`.
- Produces: `#explore-section` markup; final `bootExploreView()`.

- [ ] **Step 1: Gallery markup in `index.html`**

Insert directly **above** the `<!-- ============ CHARTS ============ -->` comment:

```html
  <!-- ============ EXPLORE (public gallery) ============ -->
  <section id="explore-section" aria-labelledby="explore-heading" hidden>
    <div class="section-head">
      <h2 id="explore-heading">Published datasets</h2>
      <p class="section-hint">Real measurement histories, shared anonymously by other patients.
        Patient-reported data from different scanners and readers — not medical advice.</p>
    </div>
    <div id="explore-list" class="explore-list"></div>
  </section>
```

- [ ] **Step 2: Gallery styles in `style.css`**

Append:

```css
/* ---------------- Explore gallery ---------------- */

body.viewer-explore #charts-section,
body.viewer-explore #overlay-legend { display: none; }

.explore-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1rem;
}
.explore-card {
  display: block;
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: 1rem 1.2rem;
  text-decoration: none;
  color: var(--ink);
  background: var(--surface);
}
.explore-card:hover { border-color: var(--ink-3); }
.explore-card .explore-code {
  font: 600 1rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .12em;
}
.explore-card .explore-diagnosis {
  font-size: .72rem;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-left: .5rem;
}
.explore-card p {
  margin: .5rem 0 0;
  font-size: .82rem;
  color: var(--ink-2);
  line-height: 1.45;
}
.explore-empty {
  color: var(--ink-2);
  font-size: .9rem;
}
```

- [ ] **Step 3: Replace the `bootExploreView` stub in `app.js`**

```js
  function bootExploreView() {
    document.body.classList.add('viewer', 'viewer-explore');
    var robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    document.title = 'Tumor Tracker — published datasets';
    var note = $('#viewer-note');
    note.hidden = false;
    note.innerHTML = 'Anonymously shared by patients using this tracker · <a href="/">track your own</a>';
    $('#explore-section').hidden = false;
    var host = $('#explore-list');
    host.innerHTML = '<p class="explore-empty">Loading…</p>';
    apiFetch('GET', '/api/published').then(function (res) {
      if (!res.items.length) {
        host.innerHTML = '<p class="explore-empty">Nothing has been published yet. ' +
          'Be the first — open <a href="/">your tracker</a> and choose “Publish anonymously”.</p>';
        return;
      }
      host.innerHTML = res.items.map(function (s) {
        var span = s.firstDate && s.lastDate ? fmtDate(s.firstDate) + ' – ' + fmtDate(s.lastDate) : '';
        return '<a class="explore-card" href="/p/' + esc(s.code) + '">' +
          '<span class="explore-code">' + esc(s.code) + '</span>' +
          '<span class="explore-diagnosis">' + esc(s.diagnosis || '') + '</span>' +
          '<p>' + s.tumorCount + ' tumor' + (s.tumorCount === 1 ? '' : 's') + ' · ' +
            s.measurementCount + ' measurement' + (s.measurementCount === 1 ? '' : 's') +
            (span ? '<br>' + esc(span) : '') +
            (s.updatedAt ? '<br>updated ' + esc(new Date(s.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })) : '') +
          '</p></a>';
      }).join('');
    }).catch(function () {
      host.innerHTML = '<p class="explore-empty">Could not load the gallery — please try again later.</p>';
    });
  }
```

(Note: explore mode never calls `renderAll()`, so the demo chart machinery stays untouched; `#charts-section` is hidden by the `viewer-explore` CSS anyway.)

- [ ] **Step 4: Verify in the browser**

1. `http://localhost:8787/explore` with ≥ 1 published dataset: cards show code, diagnosis, counts, date span, updated date; clicking a card lands on its `/p/<CODE>` page.
2. Publish a second dataset from an incognito window (different code) → explore shows 2 cards, most recently updated first.
3. Unpublish one → gallery drops to 1 card on reload.
4. Empty state: (dev-only KV) delete the rest via admin curl → friendly "Nothing has been published yet" message.
5. No editing sections, no charts section, noindex meta present, no console errors.

- [ ] **Step 5: Commit**

```bash
git add index.html style.css app.js
git commit -m "Public /explore gallery of published datasets"
```

---

### Task 7: Copy updates + full spec verification

**Files:**
- Modify: `README.md` (privacy model + running sections)
- Modify: `index.html` (privacy note wording)

- [ ] **Step 1: Update the privacy copy**

`index.html` privacy note — replace the sentence `Everything you enter is stored only in this browser, on this device. Nothing is sent anywhere.` with:

```
Everything you enter is stored only in this browser, on this device. Nothing is sent
anywhere unless you explicitly choose “Publish anonymously”.
```

`README.md` — in **Privacy model**, replace the first bullet with:

```markdown
- All data lives in the browser's `localStorage` on the user's device. Nothing
  is sent to a server unless the user explicitly publishes: **Publish
  anonymously** uploads a copy of the dataset (identified only by its patient
  code, never a name) to the public gallery at `/explore`. Updates are pushed
  manually and authorized by a secret token issued at first publish; the
  server stores only a hash of it. **Unpublish** deletes the public copy.
```

and in **Running it**, add after the existing bullets:

```markdown
The publish API and the public pages (`/explore`, `/p/<CODE>`) need the
Cloudflare Worker: run `npx wrangler dev` locally. Opening `index.html`
directly still works for purely local tracking. Deploying requires a real KV
namespace id in `wrangler.jsonc` (`npx wrangler kv namespace create
PUBLISHED`) and the admin secret (`npx wrangler secret put ADMIN_KEY`).
```

- [ ] **Step 2: Run the spec's test list end-to-end** (spec §Testing, items 1–7) against `npx wrangler dev`, in a clean profile:

1. Publish flow: demo state → section hidden; one measurement → button disabled; two → preview dialog lists diagnosis, tumor names, measurement notes, drugs with doses/notes, events; confirm-gated; entry appears on `/explore` and `/p/<CODE>`.
2. Update: local edit + "Update published data" → public page reflects it; a curl without the token gets 403.
3. Unpublish → gallery entry gone, `/p/<CODE>` shows the not-published message.
4. Backup round-trip carries `publishToken`; import → can still update.
5. Validation: >100 KB payload → 413; garbage → 400; 12 rapid publishes → 429.
6. Admin: `curl -X DELETE …/api/published/<CODE> -H 'X-Admin-Key: dev-admin-key'` works without the token.
7. Viewer: no editing UI, localStorage untouched, noindex meta + `X-Robots-Tag` header present on `/p/<CODE>`, `/explore`, and API responses.

- [ ] **Step 3: Commit (and any fixes found)**

```bash
git add -A
git commit -m "Update privacy copy for anonymous publishing; verification fixes"
```

(Fold fixes into this commit or separate ones as appropriate.)
