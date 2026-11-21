---
'@namzu/sdk': patch
---

`read`, `edit` and `write` no longer treat a notebook whose file leads with a
UTF-8 byte order mark as invalid JSON. JSON does not allow the mark, so a
notebook saved that way was read as corrupt and refused as one that never
opened; a mark at the very start of the file is now dropped before the body is
parsed. A mark anywhere else in the text is untouched, and a body that is not
JSON is still refused.
