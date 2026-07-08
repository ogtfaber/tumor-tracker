# Medication Notes Textarea Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the medication form's one-line Note input with a multi-line "Notes" textarea (with a visible hint) for recording side effects and experience, and render the full note below each medication row.

**Architecture:** Pure front-end change in a vanilla-JS static app (no build step, no test framework). Three files change: `index.html` (form field + hint), `style.css` (textarea/hint/note-block styles), `app.js` (list rendering). The data model is untouched — the `note` field on drug records stays a string-or-null; only its length cap grows from 60 to 500.

**Tech Stack:** Vanilla JS (IIFE in `app.js`), plain HTML/CSS. App is served statically (e.g. `python3 -m http.server`). Verification is manual in the browser per the spec.

**Spec:** `docs/superpowers/specs/2026-07-07-medication-notes-textarea-design.md`

## Global Constraints

- No schema change: drug `note` stays `string | null`; empty input saves as `null`.
- Textarea: `id="drug-note"`, `name="note"`, `rows="3"`, `maxlength="500"`.
- Label copy: `Notes` (with the existing `optional` marker).
- Placeholder copy: `Side effects, how you're tolerating it…`
- Hint copy (verbatim): `Comment on your experience with this medication — side effects, how you're tolerating it, or anything else worth remembering.`
- Hint is linked to the textarea with `aria-describedby`.
- Note text in the list is HTML-escaped with the existing `esc()` helper and preserves line breaks via `white-space: pre-wrap`.
- Do not touch: chart rendering, PNG export, patient-code logic, tumor measurement notes (`.note-input`).

---

### Task 1: Form — textarea with hint, styled

**Files:**
- Modify: `index.html:122-125` (the Note field in the `#add-drug` form)
- Modify: `style.css:278-293` (extend input rules to textarea), `style.css` after `.section-hint` block (~line 225: add `.field-hint`), `style.css:295-296` (add `.field.full`)

**Interfaces:**
- Consumes: existing form CSS (`.field`, `.add-form`), existing submit/edit handlers in `app.js` which read/write `$('#drug-note').value` — these keep working unchanged because the element keeps `id="drug-note"` and `name="note"`.
- Produces: a `<textarea id="drug-note">` element; Task 3's verification relies on it accepting multi-line input up to 500 chars.

- [ ] **Step 1: Replace the Note input with a textarea + hint in `index.html`**

Replace lines 122–125:

```html
      <div class="field">
        <label for="drug-note">Note <span class="optional">optional</span></label>
        <input id="drug-note" name="note" type="text" placeholder="e.g. reduced" maxlength="60">
      </div>
```

with:

```html
      <div class="field full">
        <label for="drug-note">Notes <span class="optional">optional</span></label>
        <textarea id="drug-note" name="note" rows="3" maxlength="500"
          placeholder="Side effects, how you're tolerating it…"
          aria-describedby="drug-note-hint"></textarea>
        <p id="drug-note-hint" class="field-hint">Comment on your experience with this medication — side effects, how you're tolerating it, or anything else worth remembering.</p>
      </div>
```

The `full` class makes the field span its own row inside the flex `add-form` (the other fields stay side-by-side above it).

- [ ] **Step 2: Style the textarea, the full-width field, and the hint in `style.css`**

In the block at lines 278–293, add `textarea` to the three shared rules so it picks up the exact input look:

```css
input[type="text"], input[type="date"], input[type="number"], select, textarea {
  font: 400 .9rem var(--font-body);
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--baseline);
  border-radius: 7px;
  padding: .48rem .6rem;
  width: 100%;
  transition: border-color .15s, box-shadow .15s;
}
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
input::placeholder, textarea::placeholder { color: var(--ink-3); }
textarea { resize: vertical; }
```

(The first three rules exist — only the selector lists change. The `textarea { resize: vertical; }` line is new.)

Next to `.field.grow` (line 296), add:

```css
.field.full { flex: 1 1 100%; }
```

After the `.section-hint` rule (ends ~line 225), add:

```css
.field-hint {
  margin: 0;
  color: var(--ink-3);
  font-size: .78rem;
  max-width: 60ch;
}
```

- [ ] **Step 3: Verify in the browser**

Run: `python3 -m http.server 8321` from the repo root, open `http://localhost:8321`.

Expected:
- The Medications form shows the four original fields on one line and a full-width **Notes** textarea (3 rows) below them, with the hint text under it, matching the muted section-hint style.
- The textarea matches the other inputs visually (border, radius, focus ring) and only resizes vertically.
- Typing multiple lines works; typing stops at 500 characters.
- Submitting a medication with a note still works (note handling in `app.js` is unchanged).

- [ ] **Step 4: Commit**

```bash
git add index.html style.css
git commit -m "Medication form: multi-line Notes textarea with experience/side-effects hint"
```

---

### Task 2: List — render the full note below the row

**Files:**
- Modify: `app.js:867-876` (row template inside `renderDrugs()`)
- Modify: `style.css` next to `.data-row .row-note` (~line 563: add `.row-note-block`)

**Interfaces:**
- Consumes: `esc()` helper (already in `app.js`), drug records with `note: string | null`.
- Produces: `.row-note-block` div inside `.data-row`; nothing downstream depends on it.

- [ ] **Step 1: Move the note out of `row-main` into a block below the row line**

In `renderDrugs()` (`app.js:867-876`), the current template is:

```js
      return '<div class="data-row' + (d.id === editingDrugId ? ' editing' : '') + '">' +
        '<span class="swatch" style="background:' + withAlpha(s.color, s.alpha + 0.1) + '"></span>' +
        '<span class="row-main">' + esc(d.name) +
          (d.dose ? '<span class="row-dose">' + d.dose + '</span>' : '') +
          (d.note ? '<span class="row-note">' + esc(d.note) + '</span>' : '') + '</span>' +
        '<span class="row-dates">' + fmtDate(d.start) + ' — ' +
          (d.end ? fmtDate(d.end) : '<span class="ongoing">ongoing</span>') + '</span>' +
        '<button type="button" class="icon-btn edit-btn" data-edit-drug="' + d.id + '" title="Edit" aria-label="Edit medication">✎</button>' +
        '<button type="button" class="icon-btn" data-del-drug="' + d.id + '" title="Delete" aria-label="Delete medication">✕</button>' +
      '</div>';
```

Replace it with (note span removed from `row-main`, note block appended last so it wraps to a full-width second line inside the flex row):

```js
      return '<div class="data-row' + (d.id === editingDrugId ? ' editing' : '') + '">' +
        '<span class="swatch" style="background:' + withAlpha(s.color, s.alpha + 0.1) + '"></span>' +
        '<span class="row-main">' + esc(d.name) +
          (d.dose ? '<span class="row-dose">' + d.dose + '</span>' : '') + '</span>' +
        '<span class="row-dates">' + fmtDate(d.start) + ' — ' +
          (d.end ? fmtDate(d.end) : '<span class="ongoing">ongoing</span>') + '</span>' +
        '<button type="button" class="icon-btn edit-btn" data-edit-drug="' + d.id + '" title="Edit" aria-label="Edit medication">✎</button>' +
        '<button type="button" class="icon-btn" data-del-drug="' + d.id + '" title="Delete" aria-label="Delete medication">✕</button>' +
        (d.note ? '<div class="row-note-block">' + esc(d.note) + '</div>' : '') +
      '</div>';
```

- [ ] **Step 2: Style the note block in `style.css`**

Below the `.data-row .row-note` rule (~line 563), add:

```css
.data-row .row-note-block {
  flex: 1 1 100%;
  margin: -.15rem 0 .1rem calc(15px + .9rem); /* aligns under row-main, past the swatch */
  color: var(--ink-3);
  font-size: .84rem;
  white-space: pre-wrap;
}
```

(Leave the existing `.row-note` rule in place — event rows still use it at `app.js:974`.)

- [ ] **Step 3: Verify in the browser**

With the server from Task 1 still running, reload `http://localhost:8321`.

Expected:
- Add a medication with a two-line note → the note appears in full below the name/dates line, muted, line break preserved, aligned under the medication name.
- A medication without a note shows no empty block (row looks exactly as before).
- A note containing `<b>hi</b>` renders as literal text, not bold (escaping works).

- [ ] **Step 4: Commit**

```bash
git add app.js style.css
git commit -m "Medication list: show full note as a block below the row"
```

---

### Task 3: End-to-end verification (spec test list)

**Files:**
- None modified — verification only.

**Interfaces:**
- Consumes: the running app with Tasks 1–2 applied.
- Produces: confirmation that the spec's Testing section passes.

- [ ] **Step 1: Run the spec's manual test list**

With the server running, at `http://localhost:8321`:

1. Add a medication with a multi-line note → note shows in the list with line breaks, below the name/dates line.
2. Click ✎ on it → textarea is prefilled including line breaks; edit a word, Save changes → list updates, line breaks preserved.
3. Add a medication with no note → no note block rendered.
4. Click Export (JSON download), then Clear all data, then Import the file → the multi-line note round-trips intact.
5. In DevTools console, simulate old data with a short note: verify a drug whose note is a plain short string (e.g. added before this change) renders and edits normally — the sample/demo data path (`app.js` seed) also exercises `note: null`.

Expected: all five pass with no console errors.

- [ ] **Step 2: Commit any fixes found (only if a step failed and required a change)**

```bash
git add -A
git commit -m "Fix issues found in medication-notes verification"
```
