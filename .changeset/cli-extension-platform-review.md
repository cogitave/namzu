---
'@namzu/cli': minor
---

Extensions: a service licence cannot be extended by editing its cache file, and the background runner starts reliably at sign-in on macOS and Windows.

A stored licence answer is verified against the publisher's key every time it is read; the status and the lifetime come from the signed bytes, so a hand-edited `license.json` changes nothing and one whose signature does not verify counts as no licence. The extension's `license-answer.json` now holds `claims` only: the signed `envelope` is no longer passed on, because it carries the activation id. An extension that read `envelope` from that file must read `claims` instead (no package could be installed before this release, so nothing in the field does).

The runner lock identifies its owner by the process start time on macOS and Windows as well as Linux, and a lock written before the last boot is stale, so a reused process number no longer stops the sign-in runner from starting. Two runners starting together can no longer both take the same stale lock. An extension turned off in the runner and on again starts again, and a removal waits for the runner to stop the extension before its files are deleted.
