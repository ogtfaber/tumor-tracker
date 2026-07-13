# Site nav, publish confirmation, /explore cleanup, change tracking

**Date:** 2026-07-12
**Status:** Approved

Four small UX fixes. All client-side (`index.html`, `app.js`, `style.css`); no worker/API changes.

## 1. Site-wide navigation strip

A slim `<nav class="site-nav">` at the very top of the page, above the masthead.
Since `/`, `/explore`, and `/p/CODE` all serve the same `index.html`, one nav
element covers every page.

Links:

| Label | Href | Visible when |
|---|---|---|
| My tracker | `/` | always |
| Explore shared | `/explore` | always |
| My published page | `/p/<CODE>` | this browser holds a publish token AND a dataset code |

- The current page gets `aria-current="page"` and a highlighted style.
  On `/p/CODE`, "My published page" highlights only when the viewed code equals
  the browser's own published code.
- Viewer modes (`/explore`, `/p/CODE`) currently never touch localStorage.
  The nav performs a **read-only** peek at `tumorTracker.publishToken` and the
  stored dataset's `code` so "My published page" can appear on viewer pages
  too. Viewer modes still never write.
- The nav re-renders when publish state changes (publish, unpublish, import,
  clear) so the third link appears/disappears immediately on the tracker page.

## 2. Post-publish confirmation dialog

On a **successful** publish or update push, replace the current success toast
with a `<dialog id="publish-done-dialog">` (same pattern as the existing PNG
and publish dialogs):

- Text: confirms the data is now live, showing the dataset ID.
- **View my published page** — navigates to `/p/CODE` in the same tab.
- **Close** — dismisses the dialog.

Failures keep the existing error toast, unchanged.

## 3. /explore masthead cleanup

Hide only the "Patient ID" field on `/explore` via CSS
(`body.viewer-explore .patient-field { display: none; }`).
"Diagnosis" stays. Both fields remain on `/` and `/p/CODE`.

## 4. Change tracking + smart "Update published data" button

Three ISO-8601 timestamps move into `state` (persisted to localStorage,
included in JSON backups and in the published payload):

- `createdAt` — set once, when the dataset first gains real data (the same
  moment the Patient ID is generated). Existing datasets are backfilled on
  first load with the load time.
- `updatedAt` — bumped by `save()` on every data mutation.
- `publishedAt` — set on every successful publish/update push using the same
  client clock as `updatedAt` (NOT the server timestamp, so clock skew cannot
  fake or hide changes). Replaces the `tumorTracker.publishedAt` localStorage
  key (one-time migration: if the old key exists and state has none, adopt it,
  then delete the key). The secret publish token stays outside the file.

**Dirty check:** unpublished changes exist iff `updatedAt > publishedAt`
(string comparison on ISO timestamps).

When published and NOT dirty, both "Update published data" buttons (masthead
top button and publish section) are **visible but disabled**, with tooltip
"No changes since last publish". Any edit re-enables them.

Details:

- Setting `publishedAt` after a push must not itself count as a change
  (set `publishedAt` to a timestamp >= the `updatedAt` written during the
  pre-push save, e.g. assign both in the success handler).
- Importing a backup keeps the backup's timestamps, so restoring an
  already-published backup does not falsely show pending changes.
- `normalize()` accepts the three fields as optional ISO strings and drops
  invalid values.
- The published payload carries the timestamps like the rest of the file;
  they are non-identifying (the public page already shows a server-side
  "updated" date).

## Testing

Manual verification (repo has no test infrastructure):

- Nav renders on all three routes; "My published page" only when published;
  correct link highlighted on each route.
- Publish and update both show the confirmation dialog; "View my published
  page" lands on `/p/CODE`; failure path still toasts.
- `/explore` shows Diagnosis but no Patient ID.
- Fresh dataset gets `createdAt`/`updatedAt`; edits bump `updatedAt`;
  publish sets `publishedAt` and disables the update buttons; a subsequent
  edit re-enables them; export contains all three timestamps; re-import
  preserves them.
