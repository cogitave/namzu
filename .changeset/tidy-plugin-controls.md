---
"@namzu/cli": minor
"@namzu/sdk": patch
---

Add `/plugins` to inspect loaded plugins and enable or disable them for an idle session. The menu reports registered tools and skills, shows plugin scope and directory, and explains how to configure loading when it is off. Changes reset on restart or model switch; configuration and plugin files are retained. Active sends, compaction and durable resumes prevent plugin changes, and session cleanup waits for a pending change to settle.

Fix discovery when project and user plugin locations resolve to the same directory under an explicit application home. Load that directory once as user scope; project-only scope still excludes it. Distinct plugin directories remain discoverable even if their authority roots match.
