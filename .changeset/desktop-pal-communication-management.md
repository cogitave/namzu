---
"@namzu/cli": minor
---

Desktop hosts expose six additive Pal communication methods for known peer consent, inbox delivery metadata, and activity subscription listing, creation and disabling. Reads and writes use the authenticated Pal workspace and captured application home, exact revisions, and original source conversations. The first communication request pins the physical home for that host connection; replacing it requires reconnecting even when copied IDs and revisions match. Incoming permission is read-only; reverse and wake grants remain separate explicit actions.

These management methods do not invoke a model, start a computer, dispatch messages or run a CLI subprocess. Snapshots omit message bodies, host paths and cursors; source labels include explicit user names, while derived prompt titles remain `New conversation`. Unreadable records reject with redacted errors rather than erasing known rows. Partial subscription setup remains disabled and unknown writes are not automatically retried.
