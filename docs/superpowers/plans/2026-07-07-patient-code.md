# Patient Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text patient name in the header with an auto-generated, locked-in 6-character alphanumeric code; ask for the patient name only in a new Save-PNG dialog and keep it out of the JSON data file forever.

**Architecture:** Single-page vanilla-JS app (`app.js` IIFE, `index.html`, `style.css`), all state in `localStorage` under `tumorTracker.v1`. The code becomes `state.code` (validated in `normalize()`, generated in `load()`/`save()`); the patient name moves to a *separate* localStorage key so it can never appear in `JSON.stringify(state)` exports. Spec: `docs/superpowers/specs/2026-07-07-patient-code-design.md`.

**Tech Stack:** Vanilla ES5-style JS (no build step, no test framework — verification is manual via a local static server and browser). Native `<dialog>` element for the PNG dialog.

## Global Constraints

- Code alphabet: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0/O`, `1/I/L`); validation regex `/^[A-HJKMNP-Z2-9]{6}$/`.
- Patient-name localStorage key: `tumorTracker.patientName` (never inside `state`).
- Dialog note copy, verbatim: "Optional — the name is only used to generate the image. It is never stored in your data file."
- Code style: match existing file — `var`, ES5 functions, 2-space indent, section banner comments like `// ---------------- x ----------------`.
- Verification: serve the app with `python3 -m http.server 8787` from the repo root and drive `http://localhost:8787/` with the Playwright browser tools (or manually). No test harness exists; do not add one.

---

### Task 1: `state.code` — schema, generation, migration

**Files:**
- Modify: `app.js` (state section, roughly lines 21–98; sample state ~line 122; patient-name listener ~line 1073)

**Interfaces:**
- Produces: `state.code` (string or `null`), `hasData(s)` helper, `genCode()` helper, constant `PATIENT_NAME_KEY = 'tumorTracker.patientName'`. Task 2 reads `state.code`; Task 3 reads `state.code` and `PATIENT_NAME_KEY`.

- [ ] **Step 1: Add constants and helpers, replace `patient` with `code` in `blankState()`**

In `app.js`, below `var DEFAULT_DIAGNOSIS = 'NF2';`, add:

```js
  // Anonymous 6-character dataset ID. Generated once when real data first
  // exists, then locked in — nothing in the UI can change it. The alphabet
  // skips easily-confused characters (0/O, 1/I/L) so the code stays readable
  // on printed charts.
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;

  // The patient name never lives in `state`, so it can never end up in a
  // JSON export. It is remembered only to prefill the Save-PNG dialog.
  var PATIENT_NAME_KEY = 'tumorTracker.patientName';
```

Change `blankState()` from:

```js
  function blankState() {
    return { schemaVersion: SCHEMA_VERSION, diagnosis: DEFAULT_DIAGNOSIS, patient: '', tumors: [], drugs: [], events: [] };
  }
```

to:

```js
  function blankState() {
    return { schemaVersion: SCHEMA_VERSION, diagnosis: DEFAULT_DIAGNOSIS, code: null, tumors: [], drugs: [], events: [] };
  }
```

In the `// ---------------- small helpers ----------------` section (near `uid()`), add:

```js
  function hasData(s) { return !!(s.tumors.length || s.drugs.length || s.events.length); }

  function genCode() {
    var buf = new Uint32Array(6);
    crypto.getRandomValues(buf);
    var s = '';
    for (var i = 0; i < 6; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    return s;
  }
```

- [ ] **Step 2: `normalize()` — accept `code`, drop `patient`**

Replace this line in `normalize()`:

```js
    if (typeof data.patient === 'string') out.patient = data.patient.trim().slice(0, 80);
```

with:

```js
    if (typeof data.code === 'string' && CODE_RE.test(data.code)) out.code = data.code;
```

(A `patient` field in any incoming JSON is now silently ignored — imports of old backups drop the name, per spec.)

- [ ] **Step 3: `load()` — migrate stored name, generate code for existing data**

Replace the whole `load()` function with:

```js
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankState();
      var data = JSON.parse(raw);
      var out = normalize(data) || blankState();
      var dirty = false;
      // One-time migration: the patient name moves out of the data file into
      // its own key, so JSON exports stay anonymous.
      if (data && typeof data.patient === 'string' && data.patient.trim()) {
        try { localStorage.setItem(PATIENT_NAME_KEY, data.patient.trim().slice(0, 80)); } catch (e2) {}
        dirty = true;
      }
      if (hasData(out) && !out.code) { out.code = genCode(); dirty = true; }
      if (dirty) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (e3) {}
      }
      return out;
    } catch (e) {
      console.warn('Could not read saved data:', e);
      return blankState();
    }
  }
```

(Persisting directly with `setItem` — not `save()` — because `state` is not assigned yet while `load()` runs.)

- [ ] **Step 4: `save()` — assign the code on first real save**

Replace `save()` with:

```js
  function save() {
    if (hasData(state) && !state.code) state.code = genCode();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save — browser storage may be full or blocked.');
    }
  }
```

- [ ] **Step 5: Remove `patient` from the sample state and delete the old input listener**

In `sampleState()`, delete the line:

```js
      patient: '',
```

Delete the whole `// ---------------- patient name ----------------` block near the bottom (comment plus the `$('#patient-name').addEventListener('change', ...)` handler) — the input it wires up disappears in Task 2. Because Task 2 hasn't run yet, also make `renderAll()` not touch the input: replace its first two lines

```js
    var patientInput = $('#patient-name');
    if (document.activeElement !== patientInput) patientInput.value = state.patient || '';
```

with a temporary no-op comment `// header patient-ID display is wired in Task 2` (Task 2 fills this in).

While here, simplify the existing duplicate has-data expression at the bottom of `renderAll()`:

```js
    var hasData = state.tumors.length || state.drugs.length || state.events.length;
```

becomes

```js
    var dataExists = hasData(state);
```

and update its three usages (`$('#btn-import').hidden`, `$('#btn-export').disabled`, `$('#btn-export-2').disabled`, `$('#clear-section').hidden`) to use `dataExists`. Do the same for the identical expression inside the import handler (`var hasData = state.tumors.length || ...` → `var dataExists = hasData(state);` plus its usage `if (hasData)` → `if (dataExists)`).

- [ ] **Step 6: Verify in the browser**

Run: `python3 -m http.server 8787` (repo root, background). Open `http://localhost:8787/`, then in the browser console / Playwright `browser_evaluate`:

1. `localStorage.clear(); location.reload()` — fresh visitor: no errors, demo chart renders.
2. Add a tumor + measurement via the UI, then run `JSON.parse(localStorage.getItem('tumorTracker.v1')).code` — expect a 6-char string matching `/^[A-HJKMNP-Z2-9]{6}$/`, and no `patient` key in the stored JSON.
3. Reload; run it again — same code (locked in).
4. Migration: `var d = JSON.parse(localStorage.getItem('tumorTracker.v1')); delete d.code; d.patient = 'Old Name'; localStorage.setItem('tumorTracker.v1', JSON.stringify(d)); location.reload()` — then expect `localStorage.getItem('tumorTracker.patientName') === 'Old Name'`, stored state has a fresh `code` and no `patient`.

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "Replace patient name in state with locked-in anonymous code"
```

---

### Task 2: Header shows the read-only Patient ID

**Files:**
- Modify: `index.html:27-31` (patient field)
- Modify: `style.css:158-172` (patient input styles)
- Modify: `app.js` (`renderAll()`)

**Interfaces:**
- Consumes: `state.code` from Task 1.
- Produces: `<span id="patient-code">` element; CSS classes `.patient-code-value` and its `.placeholder` modifier.

- [ ] **Step 1: Replace the input in `index.html`**

Replace:

```html
        <label class="patient-field">
          <span class="patient-label">Patient</span>
          <input id="patient-name" type="text" placeholder="add a name (optional)" maxlength="80"
                 autocomplete="off" title="Shown on saved chart images">
        </label>
```

with:

```html
        <span class="patient-field">
          <span class="patient-label">Patient ID</span>
          <span id="patient-code" class="patient-code-value"
                title="Anonymous code identifying this dataset — assigned once, never changes, and appears in backups and saved images"></span>
        </span>
```

- [ ] **Step 2: Swap the input styles in `style.css`**

Replace the three rules `.patient-field input { ... }`, `.patient-field input::placeholder { ... }`, and `.patient-field input:focus { ... }` (lines 158–172) with:

```css
.patient-code-value {
  font: 600 .95rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: .12em;
  color: var(--ink);
  padding-bottom: .15rem;
}
.patient-code-value.placeholder {
  font: italic 500 1rem var(--font-display);
  letter-spacing: normal;
  color: var(--ink-3);
}
```

- [ ] **Step 3: Render the code in `app.js`**

In `renderAll()`, replace the temporary comment from Task 1 Step 5 with:

```js
    var codeEl = $('#patient-code');
    codeEl.textContent = state.code || 'assigned on first entry';
    codeEl.classList.toggle('placeholder', !state.code);
```

- [ ] **Step 4: Verify in the browser**

Reload `http://localhost:8787/`:
1. With data present: header shows "PATIENT ID" label and the 6-char code in monospace.
2. `localStorage.clear(); location.reload()` — header shows italic muted "assigned on first entry"; adding a first tumor + measurement flips it to a code without reloading.

- [ ] **Step 5: Commit**

```bash
git add index.html style.css app.js
git commit -m "Show read-only anonymous Patient ID in the header"
```

---

### Task 3: Save-PNG dialog; name + code on the image

**Files:**
- Modify: `index.html` (add `<dialog>` before `</body>` scripts)
- Modify: `style.css` (dialog styles, after the `.masthead-actions` rule area or at the end of the file)
- Modify: `app.js` (`exportChartPng()` ~line 512, the `#charts` click handler ~line 604)

**Interfaces:**
- Consumes: `state.code`, `PATIENT_NAME_KEY` from Task 1.
- Produces: `exportChartPng(card, patient)` — second parameter is the (possibly empty) name string.

- [ ] **Step 1: Add the dialog markup to `index.html`**

Immediately before the first `<script>` tag at the bottom of `<body>`, add:

```html
<dialog id="png-dialog">
  <form id="png-form" method="dialog">
    <h3>Save chart as image</h3>
    <label class="dialog-label" for="png-patient-name">Patient name</label>
    <input id="png-patient-name" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Jane Doe">
    <p class="dialog-note">Optional — the name is only used to generate the image. It is never stored in your data file.</p>
    <div class="dialog-actions">
      <button type="button" id="png-cancel" class="btn btn-ghost">Cancel</button>
      <button type="submit" class="btn">Download PNG</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 2: Style the dialog in `style.css`**

Add at the end of the file:

```css
/* ---------------- Save-PNG dialog ---------------- */

#png-dialog {
  border: 1px solid var(--hairline);
  border-radius: 10px;
  background: var(--surface);
  color: var(--ink);
  padding: 1.4rem 1.6rem;
  width: min(26rem, 90vw);
  box-shadow: 0 12px 40px rgba(0, 0, 0, .25);
}
#png-dialog::backdrop { background: rgba(0, 0, 0, .35); }
#png-dialog h3 {
  margin: 0 0 1rem;
  font-family: var(--font-display);
  font-size: 1.15rem;
}
.dialog-label {
  display: block;
  font-size: .68rem;
  font-weight: 600;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: .3rem;
}
#png-patient-name {
  width: 100%;
  font: 500 1rem var(--font-body);
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  padding: .45rem .6rem;
}
#png-patient-name:focus { outline: none; border-color: var(--ink-2); }
.dialog-note {
  font-size: .8rem;
  color: var(--ink-3);
  margin: .5rem 0 1.1rem;
  line-height: 1.4;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: .5rem;
}
```

(If `--font-body`/`--surface` etc. names differ, use whatever the existing `:root` variables are — check the top of `style.css`.)

- [ ] **Step 3: Wire the dialog and pass the name into `exportChartPng`**

In `app.js`, replace the existing `#charts` click handler:

```js
  $('#charts').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-save-png]');
    if (!btn) return;
    exportChartPng(btn.closest('.chart-card'));
  });
```

with:

```js
  // Save PNG asks for the patient name first. The name is remembered only
  // under PATIENT_NAME_KEY — outside `state` — so it never reaches a JSON
  // export; it exists purely to label the image.
  var pngCard = null; // chart card awaiting the dialog

  $('#charts').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-save-png]');
    if (!btn) return;
    pngCard = btn.closest('.chart-card');
    var input = $('#png-patient-name');
    try { input.value = localStorage.getItem(PATIENT_NAME_KEY) || ''; } catch (e) { input.value = ''; }
    $('#png-dialog').showModal();
  });

  $('#png-cancel').addEventListener('click', function () { $('#png-dialog').close(); });
  $('#png-dialog').addEventListener('close', function () { pngCard = null; });

  $('#png-form').addEventListener('submit', function () {
    var name = $('#png-patient-name').value.trim().slice(0, 80);
    try {
      if (name) localStorage.setItem(PATIENT_NAME_KEY, name);
      else localStorage.removeItem(PATIENT_NAME_KEY);
    } catch (e) {}
    if (pngCard) exportChartPng(pngCard, name);
  });
```

(`method="dialog"` closes the dialog after submit; the `submit` handler runs first, so `pngCard` is still set. Esc/Cancel just closes — no download, and a blank submit clears the remembered name.)

- [ ] **Step 4: Draw name + code on the export**

In `exportChartPng`, change the signature and the title block:

```js
  function exportChartPng(card, patient) {
```

Replace:

```js
    var patient = (state.patient || '').trim();
    var pad = 20, titleH = patient ? 52 : 34; // extra line under the title when a patient name is set
```

with:

```js
    patient = (patient || '').trim();
    // Second title line: "Jane Doe · ID K7F3QX" — or just the ID when no name
    // was given. Real data always has a code by the time a chart is exportable.
    var idLine = (patient ? patient + ' · ' : '') + 'ID ' + (state.code || '');
    var pad = 20, titleH = 52;
```

Replace:

```js
    if (patient) {
      ctx.fillStyle = cssVar('--ink-2');
      ctx.font = 'italic 500 12px ' + (cssVar('--font-body') || 'sans-serif');
      ctx.fillText(patient, pad, pad + 35);
    }
```

with:

```js
    ctx.fillStyle = cssVar('--ink-2');
    ctx.font = 'italic 500 12px ' + (cssVar('--font-body') || 'sans-serif');
    ctx.fillText(idLine, pad, pad + 35);
```

Leave the filename logic as is (`[slug(patient), slug(tumor.name)]` — a blank name simply drops out of the filename).

- [ ] **Step 5: Verify in the browser**

On `http://localhost:8787/` with real data:
1. Click **Save PNG** — dialog opens with the note text exactly as specced; input prefilled if a name was migrated in Task 1.
2. Cancel and Esc both close without downloading.
3. Enter "Jane Doe" → Download PNG: file downloads; open it — second line reads `Jane Doe · ID <code>`; reopen the dialog — "Jane Doe" is prefilled.
4. Clear the input → Download: PNG second line is `ID <code>` only; `localStorage.getItem('tumorTracker.patientName')` is `null`.
5. Export JSON (Download my data): file contains `"code"` and no name anywhere (`grep -i jane` the download).

- [ ] **Step 6: Commit**

```bash
git add index.html style.css app.js
git commit -m "Ask for patient name in a Save-PNG dialog; stamp name + ID on the image"
```

---

### Task 4: End-to-end verification against the spec

**Files:** none (verification only; fix regressions if found)

- [ ] **Step 1: Run the spec's manual test list** (spec §Testing, items 1–6) on `http://localhost:8787/`, including the two import cases: importing an old backup containing `"patient": "X"` (name dropped, code generated on save) and importing a backup containing a valid `"code"` (kept verbatim).
- [ ] **Step 2: Fresh-visitor sweep** — `localStorage.clear()`, reload: demo chart shows, header placeholder shows, no console errors.
- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "Fix issues found in patient-code verification"
```

(Skip the commit if nothing changed.)
