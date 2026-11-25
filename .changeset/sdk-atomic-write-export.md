---
'@namzu/sdk': minor
---

Adds `atomicWriteFile` and `UnsafeWritePathError` to the public exports: the atomic file write the `write` and `edit` tools use, for a host that writes a file the same safe way. A new `refuseLinksBelow` option refuses to write through a symbolic link below a folder and keeps the path inside it; a new `mode` option sets the bits of a new file. Without them behaviour is unchanged: the write goes through a link and keeps it.
