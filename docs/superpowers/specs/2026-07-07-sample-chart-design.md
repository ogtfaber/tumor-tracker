# Example chart for fresh users — design

Approved 2026-07-07.

## Goal

A brand-new visitor (nothing saved yet) should immediately see what the app
produces: a real chart with medication shading and an event line — without any
fake data touching their saved state.

## Behavior

- **When it shows:** only while saved state is completely blank — no tumors, no
  medications, no events. Adding anything real removes it. The patient name
  alone does not count as data.
- **Persistence:** never. The sample lives in a constant in `app.js`; nothing
  sample-related is ever written to localStorage.
- **What it shows:** one chart rendered by the real chart pipeline from an
  in-memory sample state:
  - Tumor "Left vestibular schwannoma (example)", type `xy` (two diameters).
  - ~7 quarterly measurements over ~2 years, dated relative to today so the
    chart never looks stale: slow growth, then stabilizing/shrinking after
    treatment.
  - Medication "Everolimus" in two dose periods (10, then 5) to demonstrate
    dose-ordered band shading.
  - Event "Gamma Knife radiosurgery" to demonstrate the vertical event line.
- **Clearly a sample:** the chart card carries an "Example" badge next to the
  title and has no "Save PNG" button. The existing "Start your timeline"
  empty-state card stays visible below it and gains one sentence noting the
  chart above is an example that disappears once they add their own tumor.

## Implementation shape

- `sampleState()` builds the sample object with dates computed relative to
  today.
- `viewState()` returns the sample when real state is blank, otherwise `state`.
- Chart-side functions (`renderCharts`, `renderLegend`, `timeDomain`,
  `drugShadeMap`, `drugColorMap`, `statLine` via its caller) read from
  `viewState()`.
- Editable sections (`renderTumors`, `renderDrugs`, `renderEvents`, forms,
  export/import) keep reading real `state`, so they stay empty and ready for
  input.
- Demo chart cards skip the PNG-export button, so `exportChartPng` (which looks
  tumors up in real state) is unreachable in demo mode.

## Out of scope

- No interactive/editable demo data, no "load sample" button, no banner state.
