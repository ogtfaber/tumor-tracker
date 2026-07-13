---
name: verify
description: How to build, run, and drive tumor-tracker locally to verify changes end-to-end
---

# Verifying tumor-tracker

Vanilla JS single-page app + Cloudflare Worker. Three routes share `index.html`:
`/` (tracker), `/explore` (gallery), `/p/CODE` (read-only published view).

## Launch

```bash
npx wrangler dev --port 8899 --local
```

Local mode simulates the PUBLISHED KV namespace on disk — publishing/unpublishing
is safe, nothing reaches production. Wait for `curl -s http://localhost:8899/`
to return 200 (takes a few seconds).

Gotcha: the assets directory is the repo root (`"directory": "."`), so ANY file
written into the repo (screenshots, scratch files) triggers a wrangler reload
and can make an in-flight page load hang. Save browser screenshots to the
scratchpad, not the repo. The Playwright MCP also auto-writes snapshot files
to `.playwright-mcp/` on every action — reloads triggered mid-request can 503
an API call, or worse, drop only the RESPONSE of a publish that succeeded
server-side (client then has no token; clean stale entries with
`npx wrangler kv key delete --binding PUBLISHED "pub:CODE" --local`).

## Driving the app (Playwright MCP)

- All data lives in `localStorage` key `tumorTracker.v1`; publish token in
  `tumorTracker.publishToken`. Inspect state via browser_evaluate.
- New measurement rows commit on focus-out, not Enter — fill date + value,
  then click elsewhere (e.g. the page heading) to commit.
- Publish flow: add 1 tumor + 2 measurements (minimum to publish) → click
  `#btn-publish-top` → tick `#publish-consent` → `#publish-confirm`.
- Destructive buttons (unpublish, clear) are two-step: two clicks within 5s.
  Automated clicks that are seconds apart silently disarm — click twice fast.
  The DELETE round-trip can take >1.5s locally; poll before concluding failure.
- Viewer modes must never WRITE localStorage (check `localStorage.length`
  stays 0 on a fresh profile visiting `/p/CODE` or `/explore`).
