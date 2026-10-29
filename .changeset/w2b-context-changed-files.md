---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A file the model read whole, wrote or edited and that something else then changed on disk is now announced to the model before its next request, with the changed lines and their line numbers, so it works from the file as it is and no longer finds out through a refused edit. The refusal remains as a safety net. For SDK hosts, `FileReadTracker` gains the optional `fullBody`, `fullBodyPaths` and `recordFullBody`; `createFileReadTracker()` now keeps the body of up to 128 whole-file observations (none over 512 KiB), where it kept only hashes. A custom tracker without these methods is unaffected. Nothing to change to keep working.

Bound complete changed-file notes to 16,384 characters per request, including filenames, framing and separators. Defer notes that do not fit to later requests without losing them or changing the stale-write witness. Comparison reads stop at 2 MiB; larger files receive a content-free notice.
