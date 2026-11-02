---
"@namzu/sdk": minor
---

A session log can now carry records from a newer release. A record whose `type` this version does not know is read, hash-verified and skipped by the message fold when its writer set `ignorable: true`; the same record without the flag is still refused, as before. Nothing changes for existing logs. New export: `IgnorableRecordSchema`.
