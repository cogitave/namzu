---
"@namzu/cli": minor
---

`/peers` and `namzu peers list` now print one counted list, `Namzu sessions (N):`, with a line per session shaped `[state]  ·  name  ·  started 7m ago` (this terminal, or the machine's name, in the last field). A session with no name of its own reads `(unnamed session)` instead of its folder's name; its folder, permission mode and role move to an indented second line, and the other machines go in a short `Machines` section. The old one-line forms (`ref  title  state  mode` in a shell, `name [ref] · state · mode` in the terminal) are gone, so a script that parses the text should read `--json`, which keeps every field and adds `folder`, `named` and `startedAt` to its rows. The model's `list_sessions` rows gain `started_at`.
