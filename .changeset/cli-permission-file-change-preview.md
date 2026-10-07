---
"@namzu/cli": minor
---

`namzu acp` now attaches a file change preview to the permission request of an `edit` or `write` call: the path as the tool resolves it, the file's current body (`null` for a new file) and the body after the call, computed with the SDK's own apply code. Files over 1 MiB, binary files, paths outside the turn's directory and calls the tool would refuse get no preview. Clients that do not read the new `preview` field are unaffected.
