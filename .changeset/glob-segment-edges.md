---
'@namzu/sdk': patch
---

A glob pattern whose segment (the text between two slashes) is longer than 1,024 characters is now refused with `GlobTooComplexError` ("shorten it or split it across folders") instead of being compiled; a 200 KB segment used to take about 8 seconds of CPU. A real file name is at most 255 bytes, so no working pattern is affected. `[[:constructor:]]` and the other POSIX class names that `Object.prototype` also has are read as ordinary characters, like any unknown class name, instead of matching nothing. Nothing to change on your side; `MAX_GLOB_SEGMENT_LENGTH` is exported from the module if you need the limit. The over-length message now cuts its preview on a code point, so an emoji at the boundary is no longer split.
