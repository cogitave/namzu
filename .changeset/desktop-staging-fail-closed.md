---
'@namzu/desktop': patch
---

The Windows installer is built with the Windows bindings for image shrinking and code analysis, and the build now fails when they are missing, or when the packed engine does not start, answer or load them on the Windows build machine, instead of shipping a broken installer. Nothing to change on your side.
