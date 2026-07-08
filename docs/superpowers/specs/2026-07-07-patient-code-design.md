# Patient code replaces patient name

**Date:** 2026-07-07
**Status:** Approved

## Goal

The JSON data file must stay anonymous. Replace the free-text patient name in the
header with an auto-generated 6-character code that acts as the dataset's unique
identifier. The patient name is asked for only when downloading a PNG, is remembered
for next time, and never enters the JSON data file.

## The code

- `state.code`: a 6-character string of uppercase letters and digits, drawn from a
  set that excludes easily-confused characters — `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (no `0/O`, `1/I/L`). Example: `K7F3QX`.
- Generated with `crypto.getRandomValues`.
- **Locked in:** once set it is never regenerated and no UI can edit it.
  `normalize()` preserves any value matching `/^[A-HJ-NP-Z2-9]{6}$/` (the alphabet
  above) and discards anything else.

### When it is generated

- **On load:** if localStorage holds real data without a valid code, generate one
  and save immediately. (Covers data that predates this feature.)
- **On first save:** fresh users get a code the first time real data is persisted.
- **Demo/sample state:** lives only in memory and gets no code; the header shows a
  placeholder ("assigned on first entry"). The first real entry replaces the demo
  and gets a code via the on-save rule.
- **Import:** an imported file's valid code is kept as-is — it identifies that
  dataset. A file without a valid code gets a fresh one on the post-import save.

## Header UI

The "Patient" text input (`#patient-name`) is removed. In its place a read-only
"Patient ID" field, styled like the adjacent Diagnosis field, shows the code (or
the placeholder in demo state).

## JSON export / import

- The export contains `code` and never any name. `patient` is removed from the
  schema; `normalize()` no longer reads it into state.
- **One-time migration:** if *stored* state contains a non-empty `patient` value,
  it is moved to the saved PNG-dialog name (below) and deleted from state, so the
  current name survives — outside the data file. A `patient` field in an
  *imported* file is silently dropped (it never overwrites the local prefill).

## Save PNG dialog

- Clicking **Save PNG** opens a native `<dialog>` instead of downloading directly:
  - A "Patient name" text input, prefilled with the last-used name.
  - Helper note: *"Optional — the name is only used to generate the image. It is
    never stored in your data file."*
  - Buttons: **Download PNG** (proceeds, name may be blank) and **Cancel**.
- The name is persisted under a separate localStorage key
  (`tumorTrackerPatientName`), entirely outside `state`, so it cannot appear in
  the JSON export.
- The PNG title block shows the tumor name, then a second line:
  `Jane Doe · ID K7F3QX` — or just `ID K7F3QX` when the name is blank. (The
  second line is now always present, since real data always has a code.)

## Error handling

- Corrupt or foreign `code` values in imported/stored JSON are treated as absent
  and replaced by a fresh code.
- Dialog cancel: no download, no name saved.

## Testing

Manual verification via the running app:

1. Fresh visitor: demo chart shows placeholder ID; adding a first measurement
   assigns a code visible in the header.
2. Reload: code unchanged (locked in).
3. Export JSON: contains `code`, contains no name anywhere.
4. Save PNG: dialog appears with note; blank name → PNG shows `ID …` only;
   entered name → shown on PNG and prefilled on next open; name absent from a
   subsequent JSON export.
5. Import an old backup containing `patient`: name is silently dropped, code
   generated.
6. Import a backup containing a code: that code is kept.
