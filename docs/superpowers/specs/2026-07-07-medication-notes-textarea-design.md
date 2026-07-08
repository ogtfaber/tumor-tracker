# Medication notes become a multi-line side-effects field

**Date:** 2026-07-07
**Status:** Approved

## Goal

Let users record free-text notes about side effects and their experience taking a
medication. The existing one-line `Note` field (60 chars, intended for dose context
like "reduced") is replaced by a single multi-line textarea that covers both dose
context and experience notes.

## Data model

No schema change. The `note` field on drug records stays a string or `null`.

- Allowed length grows from 60 to 500 characters (enforced via `maxlength` on the
  textarea; the value is trimmed on save, empty → `null`).
- Existing saved notes, JSON exports, and JSON imports keep working unchanged; the
  drug sanitizer in `loadState` (app.js, `note: typeof d.note === 'string' && d.note ? d.note : null`)
  already accepts any string, including multi-line.

## Form (index.html)

The `#drug-note` `<input type="text">` in the `#add-drug` form becomes a
`<textarea>`:

- `id="drug-note"`, `name="note"`, `rows="3"`, `maxlength="500"`.
- Label changes from **Note** to **Notes** (still marked optional).
- Placeholder: `Side effects, how you're tolerating it…`.

Edit mode is unchanged in behavior: clicking ✎ fills the textarea from `d.note`
(`$('#drug-note').value = d.note || ''`), Save writes back the trimmed value,
Cancel/`form.reset()` clears it.

## List display (app.js — renderDrugs)

The note moves out of the inline `row-note` span. Instead it renders as a small
muted text block below the medication's name/dose/dates line:

- Full text shown, no truncation.
- Line breaks preserved via `white-space: pre-wrap`.
- Content HTML-escaped with the existing `esc()` helper.

## CSS (style.css)

- Style the `#add-drug textarea` to match the existing text inputs (font, padding,
  border, background); `resize: vertical` only.
- New class for the note block in the list (e.g. `.row-note-block`): small muted
  type, `white-space: pre-wrap`, sits under the row's main line.

## Out of scope

- Chart rendering and tooltips (drug notes never appear there).
- PNG export (chart-only; unaffected).
- Patient-code logic.
- Tumor measurement notes (`.note-input` in the measurements table) — separate
  feature, untouched.

## Testing

Manual verification in the running app:

1. Add a medication with a multi-line note → note shows in the list with line
   breaks, below the name/dates line.
2. Edit that medication → textarea is prefilled including line breaks; saving
   preserves them.
3. Add a medication with no note → no empty note block is rendered.
4. Export JSON, clear data, import → multi-line note round-trips intact.
5. A pre-existing short note (old data) renders and edits normally.
