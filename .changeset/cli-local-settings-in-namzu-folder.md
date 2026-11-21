---
'@namzu/cli': minor
---

A project's local settings now live in `.namzu/settings.local.json` instead of `namzu.config.local.json` at the top of the folder, and `.namzu/settings.json` is read as a second shared project file beside `namzu.config.json`.

What you see: a "don't ask again" answer and `/permissions add` are saved to `.namzu/settings.local.json`. The first session in a trusted folder moves an existing `namzu.config.local.json` there: it copies the bytes, reads them back, and only then removes the old file. Nothing to do; the saved answers keep working. The old file stays (and is still read, under the new one) when git tracks it, when it is not valid JSON, or when both files hold different settings; the session start says why in one sentence. The global git ignore line is now `**/.namzu/settings.local.json*` (the old `**/namzu.config.local.json` line stays), written after `/permissions add` and `remove` too, and at session start when a local file exists.

An answer is no longer saved in three cases, and the answer says so: the folder is not trusted (its local file was never read there), git tracks the local file, or the rule looks like it holds a password or a token (for example `curl -u user:pass`, `mysql -p<password>`, an `Authorization:` header). It holds for the conversation only. `/permissions add` refuses the last two.

`.namzu/settings.json` takes the same keys and limits as `namzu.config.json`; where both set a key, `.namzu/settings.json` wins, and both files' rules and hooks apply. `namzu doctor` and `/status` say when both files of a layer are there so you can keep one. A scheduled job pins `.namzu/settings.json` once it holds hooks, servers, plugins or permissions; a job confirmed before that is not stopped. `namzu state` names an old `namzu.config.local.json` while it is there, and its JSON report gains `legacyLocalConfig`. The Desktop commit preview leaves Namzu's local settings files out (`skippedLocalSettings`) and refuses a commit that names one.
