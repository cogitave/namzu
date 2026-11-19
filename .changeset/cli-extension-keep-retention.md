---
'@namzu/cli': minor
---

A data kind in an extension manifest may now set `retentionDays` to `"keep"` (kept until the organisation deletes it) besides a number of days 1 to 365, and may carry a localised `title` and `example` for the What is collected page. Moving a data kind from days to `"keep"` asks the person again; nothing changes for a manifest that does not use them. `namzu extension validate` now also warns, without refusing, about a display name that starts with Namzu.
