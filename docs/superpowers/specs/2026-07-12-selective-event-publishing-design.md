# Selective event publishing + header publish button

Date: 2026-07-12
Status: approved design

## Goal

When publishing anonymously, the user can uncheck individual events they do not
want on the public page. The choice is stored on the event itself in the
regular data file, visible in the events list, and respected on every future
push. Additionally, a publish/update button appears in the page header, left of
"Download my data".

## 1. The `private` flag on events

Event objects gain an optional boolean `private`. Absent (or anything other
than `true`) means the event is published; `private: true` means it is excluded
from the published copy.

- Stored in `state` (localStorage `tumorTracker.data.v1`), so it is carried by
  backups and restored on import with no extra machinery.
- `loadState` normalization (app.js `normalize`, ~line 134) preserves the flag:
  copy `private: true` through when present.
- No `SCHEMA_VERSION` bump: the field is optional and additive. Older builds
  importing a newer backup silently drop the flag, which degrades safely
  (events become published-by-default and the user re-reviews in the dialog).
- The flag only affects publishing. Private events still render on the user's
  own charts and in the events list exactly as before.

## 2. Publish dialog: events become a checklist

In `publishPreviewHtml`, the Events section changes from a plain `<ul>` to a
list of labelled checkboxes, one per event (date + label), checked when
`!e.private`. Everything else in the preview stays read-only.

- Unchecking marks the event as excluded from this and future publishes.
- On **confirm**, before pushing: set `private: true`/delete the flag on each
  `state.events` entry according to its checkbox, `saveState()`, then push.
- On **cancel**, nothing is written — checkbox fiddling is discarded.
- Events added after a publish default to checked (no flag).

## 3. Publish payload filters private events

`pushPublish` deep-copies state, then:

```js
body.data.events = body.data.events
  .filter(function (e) { return e.private !== true; })
  .map(function (e) { delete e.private; return e; });
```

The `map` strip is defensive; the filter already removes every flagged event.
The Worker's whitelist sanitizer (src/worker.js, event fields `id`, `date`,
`label`, `tumorId`) is a second server-side layer that would drop the flag
even if the client forgot.

Consequence (intended): unchecking an event that is already public removes it
from the public copy on the next push.

## 4. "Update published data" opens the dialog

`#btn-publish-update` no longer pushes immediately. It opens the same publish
dialog with:

- current checkbox states from each event's `private` flag,
- consent checkbox reset and required as today,
- confirm button labelled **Update** instead of **Publish**.

The dialog's submit handler branches on whether a publish token exists: with a
token it follows today's update path (including the token-mismatch hint and
fresh-token handling); without one it follows the first-publish path. The
`publishBusy` guard and error toasts are unchanged.

## 5. Events list shows the preference

In `renderEvents`, events with `private: true` get a small muted chip
("not published") next to the label, so the preference is visible at any time.
The chip is display-only; changing it happens in the publish dialog. Style: a
small `.event-private-chip` consistent with existing muted hint text.

## 6. Header publish button

A new button `#btn-publish-top` in `.masthead-actions`, placed left of
`#btn-export` ("Download my data"):

- Label: "Publish anonymously…" before first publish, "Update published data"
  once a publish token exists.
- Clicking it opens the same publish dialog as the corresponding lower-section
  button (identical behavior, shared open-dialog function).
- Visibility mirrors the lower section: hidden in viewer/explore modes
  (`VIEW`), hidden when there is no data; disabled with the same tooltip when
  `canPublish()` is false (needs one tumor with two measurements).
- The lower "Share anonymously" section stays as-is (status line, public-page
  link, Unpublish).
- `renderPublish` updates both the section and the header button.

## Out of scope

- Excluding measurements, notes, or medications (events only).
- Editing the `private` flag from the event add/edit form.
- Any server/API changes — the Worker already sanitizes event fields.

## Testing

Manual verification (app has no test harness):

1. Add events, open publish dialog, uncheck one, publish → public page `/p/CODE`
   lacks that event; events list shows the "not published" chip.
2. Reload → chip persists; reopen dialog → checkbox still unchecked.
3. Re-check the event, Update → event appears on the public page again.
4. Download backup → JSON contains `"private": true` on the flagged event;
   clear data, import backup → flag restored.
5. Update button opens dialog, confirm labelled "Update", push works with
   existing token.
6. Header button: shows "Publish anonymously…" when unpublished, disabled
   without two measurements, switches to "Update published data" after
   publishing, hidden on `/p/CODE` and `/explore`.
