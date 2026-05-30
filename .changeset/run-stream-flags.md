---
'@namzu/cli': minor
---

run-stream gains `--model`, `--instance`, and `--skills <a,b,c>` flags so a host
UI can drive which model answers, attribute the run to a named instance, and
load specific skills' bodies into the turn (via the same extra-system channel
the TUI's `/skill` uses). Adds a `skills-json` command that prints discovered
skills as `{name, description, source}[]` for a host's skill picker.
