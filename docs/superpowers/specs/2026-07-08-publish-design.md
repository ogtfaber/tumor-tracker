# Anonymous publishing to a public gallery

**Date:** 2026-07-08
**Status:** Approved

## Goal

Let a user publish their (anonymous) dataset to a publicly accessible page so
others can browse real tumor histories. Republishing under the same patient
code replaces the previous version. Publishing is always an explicit, manual
act; the local-first privacy model stays the default and unpublished users are
completely unaffected.

## Decisions (from grilling session)

| Question | Decision |
|---|---|
| Backend | Cloudflare Worker + KV, added to the existing `wrangler.jsonc` deploy |
| Update auth | Secret publish token issued on first publish; code alone never authorizes writes |
| Privacy gate | First publish shows a preview of the exact public content + explicit consent |
| Removal | Self-service Unpublish (token-authorized) + admin secret for moderation takedowns |
| Public UX | `/explore` gallery of cards → read-only detail page per code (`/p/K7F3QX`) |
| Updates | Manual "Update published data" button; no auto-sync |
| Anti-abuse | Server-side schema validation, ~100 KB size cap, per-IP rate limit, minimum-substance rule; no CAPTCHA for now |
| Viewer implementation | Read-only mode inside the existing `index.html`/`app.js`, gated by one `isViewer` flag |
| Search engines | `noindex` on all public pages (gallery and detail) |

## Architecture

The Worker (new `src/worker.js`, `main` in `wrangler.jsonc`) serves the
existing static assets and adds:

- `POST /api/publish` — body: `{ code, token?, data }`.
  - First publish (no entry for `code`): server generates a random token,
    stores `{ dataJson, tokenHash, publishedAt, updatedAt }` in KV under
    `pub:<code>`, returns `{ token }`.
  - Update: token required; server compares hash; 403 on mismatch.
  - Validates before storing: payload ≤ ~100 KB, `code` matches
    `/^[A-HJKMNP-Z2-9]{6}$/`, body passes the same structural rules as
    `normalize()` (server keeps its own small validator), and contains at
    least one tumor with 2+ measurements (minimum substance).
  - Rate-limited per IP (a small KV counter or Cloudflare rate-limiting
    binding).
- `GET /api/published` — gallery listing: `[{ code, diagnosis, tumorCount,
  measurementCount, firstDate, lastDate, updatedAt }]`. Derived summary only,
  computed at publish time and stored alongside the blob (avoids N reads on
  list). Uses `kv.list({ prefix: 'pub:' })`; fine at this scale.
- `GET /api/published/:code` — the full published JSON (without token hash).
- `DELETE /api/published/:code` — requires the publish token **or** the admin
  secret (`ADMIN_KEY` Worker secret, sent as a header). Deletes the KV entry.
- `GET /p/:code` and `GET /explore` — serve `index.html` (SPA-style rewrite);
  the app reads the URL and enters viewer/gallery mode. All responses for
  these routes and the API include `X-Robots-Tag: noindex`.

Server stores only a SHA-256 hash of the token, never the token itself.

## Client: publishing (owner side)

- New "Publish" section in the app (near export/import):
  - Not yet published: **Publish anonymously…** button. Disabled in demo
    state (no code yet) and when the dataset fails the minimum-substance rule.
  - Published: shows status ("Published as K7F3QX · last pushed <date>"),
    **Update published data**, **Unpublish**, and a link to the public page.
- First publish opens a `<dialog>`:
  - Renders a readable preview of exactly what goes public — tumor names,
    every event label, every drug name + dose note — with a warning to check
    free text for identifying details (hospitals, doctors, names).
  - Explicit confirm ("I understand this will be publicly visible").
- On success the returned token is stored in localStorage
  (`tumorTracker.publishToken`) **and** included in the JSON export
  (`publishToken` field) so backups/device moves keep update rights.
  `normalize()` learns to carry it; it is stripped from the published copy
  server-side and never shown on public pages.
- "Update published data" re-sends with the stored token; a lighter inline
  reminder replaces the full preview.
- Unpublish: confirm dialog → `DELETE` → local publish state cleared (token
  kept in case of re-publish? No — server entry is gone; drop the token and
  treat a later publish as a first publish).
- Lost token (cleared storage without a backup): the app explains the
  published copy can no longer be updated and offers to contact the site
  owner for removal. (Admin can delete; user can then publish fresh.)
- **Clear all data** also warns when a published copy exists and offers to
  unpublish first.

## Client: public viewer

- `isViewer` flag set when the URL is `/p/<code>` or `/explore`.
- `/p/<code>`: fetches `/api/published/:code`, feeds it through `normalize()`
  into the in-memory state (localStorage untouched), renders the normal
  charts. All editing UI (forms, inline edits, delete buttons, import/export,
  publish section) hidden; header shows "Public view · ID K7F3QX · updated
  <date>" and a link back to the tracker/gallery. Save PNG stays available.
- `/explore`: fetches `/api/published`, renders cards (ID, diagnosis, tumor
  count, measurement count, date span, last updated) linking to `/p/<code>`.
  A short disclaimer: patient-reported data, not medical advice.
- `<meta name="robots" content="noindex">` added when in viewer mode (belt)
  in addition to the `X-Robots-Tag` header (braces).

## Config

- `wrangler.jsonc`: add `main: "src/worker.js"`, a KV namespace binding
  (`PUBLISHED`), and keep the assets binding (assets config gains
  `binding: "ASSETS"` so the Worker can pass static requests through).
- Secrets: `ADMIN_KEY` via `wrangler secret put`.

## Error handling

- Publish/update/unpublish failures surface via the existing `toast()`.
- 403 on update → explain the token no longer matches (e.g. data was
  unpublished and republished elsewhere) and offer publish-as-new? No —
  code is locked per dataset; offer the lost-token path instead.
- Gallery/detail fetch failures render a friendly error state, never a blank
  page.
- Detail page for an unknown/unpublished code → "Not published (anymore)."

## Out of scope (deliberately)

- Auto-sync of local edits to the published copy.
- CAPTCHA (revisit if abuse appears), approval queues, comments, reactions.
- Search-engine indexing, social previews.
- Cross-patient comparison/overlay views (possible later on top of the API).
- Mini-charts on gallery cards (v2 polish).

## Testing

1. Publish flow: demo state → button disabled; real data → preview dialog
   lists all free text; confirm → entry appears on `/explore` and `/p/<code>`.
2. Update: edit locally, push → public page reflects it; second browser
   without token gets 403 on update attempts.
3. Unpublish → gallery entry gone, `/p/<code>` shows not-published state.
4. Export/import round-trip carries `publishToken`; imported backup can
   update the published copy.
5. Validation: oversized/garbage/empty payloads rejected; rate limit kicks in
   on rapid publishes.
6. Admin: `DELETE` with `ADMIN_KEY` removes an entry without the token.
7. Viewer mode: no editing UI reachable, localStorage untouched after
   browsing, noindex header + meta present.
