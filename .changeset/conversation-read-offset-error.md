---
"@namzu/sdk": minor
---

Adds `SessionEvidenceOffsetError`, thrown by a session text evidence source's `read` when the byte offset falls inside a multi-byte character (`code: 'inside_character'`) or beyond the text (`code: 'past_end'`), with `totalBytes` and the `scannedBytes` the failed read was charged. Both used to be plain `Error`s with the same messages, so a caller could not tell a bad position from an integrity or ownership refusal. The messages are unchanged and the class extends `Error`, so existing handlers keep working.
