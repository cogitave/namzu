---
'@namzu/cli': minor
---

The agent can hand you a finished file with `present_file`. A file it wrote inside your own folder is already there, so it says where; it uses `present_file` for a file that lives only in the scratch folder or that you should open now. The terminal shows one row, `Shared report.pdf · /tmp/out/report.pdf`. The tool is deferred like the other tools outside the always-sent list; nothing you configure changes.

A deny or review rule written under `read` (for example `read(.env)`) now also applies to `present_file`: a file you denied for reading is not handed over.
