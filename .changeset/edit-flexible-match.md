---
'@namzu/sdk': minor
---

Make `edit` recover a few `old_string` near-misses instead of failing, matching the reference terminal's resolver and order: a straight quote against the file's curly one (or the reverse), and a `\uXXXX` escape where the file holds the character (or a character where the file holds the escape). The matched span is a real substring of the file, so the uniqueness rule still applies and the same transformation is carried onto `new_string`. A whitespace or indentation difference is still not recovered — the error continues to tell the model to match those exactly. A deletion (empty `new_string`) now takes the matched line's trailing newline with it, so removing a whole line no longer leaves a blank one behind. The CRLF/LF reconciliation this kernel already did is unchanged.
