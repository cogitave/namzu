---
'@namzu/sdk': patch
---

A live-session registry record that carries a field this build does not know is now read instead of dropped, so a session started by a newer build stays visible to `list_sessions` in an older one. Writing a record is still strict.
