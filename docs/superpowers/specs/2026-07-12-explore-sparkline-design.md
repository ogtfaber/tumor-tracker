# Explore gallery: sparkline preview, medication count

## Goal
Give /explore cards more signal: a small sparkline of the first tumor with
plottable data and the number of medications tracked — without giving up the
gallery's zero-read design (one KV list() call, summaries in metadata).

## Summary metadata additions
- `drugCount` — `data.drugs.length`.
- `spark` — `{ d: [int day offsets from the series' first date], v: [values
  rounded to 2 decimals] }`, taken from the first tumor (stored order) whose
  first plottable key (x → x, xy → x then y, vol → v) has ≥ 2 non-null values,
  evenly thinned to ≤ 24 points. KV metadata is capped at 1024 bytes, so the
  summary guards its serialized size via UTF-8 byte count (> 1000 bytes → thin to 12 points →
  drop spark).

## Client
Cards render `spark` as an inline SVG polyline (2px, `--series-1`, no axes,
`aria-hidden`) — no Chart.js instance per card. Cards without `spark` /
`drugCount` (published before this change) render exactly as before.

## Future migrations
Published datasets (the KV *values*) are the source of truth; card summaries
are derived metadata. Entries published before a summary-shape change simply
lack the new fields until their owner republishes — cards must render
gracefully without them. If the gallery ever grows enough that waiting for
republishes is impractical, an admin resummarize endpoint can list all
`pub:*` keys and rewrite each key's metadata from its stored dataset —
no user involvement needed. Deliberately not built yet (one published
entry exists today).

## Testing
1. Publish a dataset with ≥ 2 measurements and 1 drug → summary has
   drugCount and spark; card shows line + "1 medication".
2. Entry with pre-change metadata (no spark/drugCount) → card renders
   without sparkline or medication count.
3. Dark mode: sparkline uses the dark-theme series hue.
