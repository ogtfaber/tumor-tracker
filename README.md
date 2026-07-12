# NF2 Tumor Tracker

A private, static web page for NF2 patients to plot tumor measurements over
time, with medication periods and life events overlaid on every chart. The
diagnosis is stored in the data file, so support for other diseases can be
added later.

## Privacy model

- All data lives in the browser's `localStorage` on the user's device. Nothing
  is sent to a server unless the user explicitly publishes: **Publish
  anonymously** uploads a copy of the dataset (identified only by its patient
  code, never a name) to the public gallery at `/explore`. Updates are pushed
  manually and authorized by a secret token issued at first publish; the
  server stores only a hash of it. **Unpublish** deletes the public copy.
- **Download my data** exports everything as a readable `.json` file.
- **Import…** restores from such a file (backup, moving devices, or after the
  browser cleared its storage).

## What can be tracked

- **Tumors** — each with a name and one measurement type, chosen at creation:
  - single diameter (mm)
  - two diameters, x + y (mm) — plotted as two lines
  - volume (cm³)
- **Medications** (per person) — name, start date, optional end date (empty =
  ongoing), optional dose note. Periods with the same name share a color, so a
  dose change is just a new period.
- **Events** (per person) — dated moments (surgery, radiation, diagnosis),
  drawn as a thin vertical line on every chart.

All charts share the same time axis so tumors can be compared at a glance.
Above each chart a stat line shows the latest value and % change vs the
previous and first measurements.

## Running it

It's a fully static site with no build step:

- open `index.html` directly in a browser, or
- serve the folder with any static host / `python3 -m http.server`.

Web fonts load from Google Fonts when online and fall back to system fonts
offline. Charts are rendered with a locally vendored Chart.js
(`vendor/chart.umd.min.js`), the annotation plugin, and the date-fns adapter —
no CDN needed at runtime.

The publish API and the public pages (`/explore`, `/p/<CODE>`) need the
Cloudflare Worker: run `npx wrangler dev` locally. Opening `index.html`
directly still works for purely local tracking. Deploying requires a real KV
namespace id in `wrangler.jsonc` (`npx wrangler kv namespace create
PUBLISHED`) and the admin secret (`npx wrangler secret put ADMIN_KEY`).

## Data format

One JSON document (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "diagnosis": "NF2",
  "patient": "…",
  "tumors": [
    { "id": "…", "name": "Left vestibular schwannoma", "type": "vol",
      "measurements": [ { "id": "…", "date": "2024-03-18", "v": 2.9 } ] }
  ],
  "drugs": [
    { "id": "…", "name": "Everolimus", "start": "2023-05-01",
      "end": "2024-06-30", "note": "10 mg" }
  ],
  "events": [
    { "id": "…", "date": "2024-05-12", "label": "Gamma Knife radiosurgery" }
  ]
}
```

Measurement value keys by tumor type: `x` for single diameter, `x` + `y` for
two diameters, `v` for volume. Missing values are `null` (e.g. a scan that
reported only x for an x+y tumor).

This tool is for personal record-keeping, not medical advice.

## License

[MIT](LICENSE). The vendored libraries (Chart.js, chartjs-plugin-annotation,
and the date-fns adapter) are also MIT-licensed by their respective authors.
