---
'@namzu/sdk': patch
---

`grep` now says why an empty result is not evidence that the text is absent: a
pattern written to match across a line break (`\n`, `\r`) is tested one line at
a time while `multiline` is off, so the result names the pattern and points at
`multiline: true` instead of only reporting no matches. A pattern written
`\\n`, which searches for a backslash and an `n`, is left alone.
