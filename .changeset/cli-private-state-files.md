---
'@namzu/cli': patch
---

Namzu creates its home folder (`~/.namzu` or `NAMZU_HOME`) with mode 0700 when
it is the one creating it, and the `/restore` copies under `file-history/` and
the `logs/` folder of crash logs are owner-only too. A home that already exists
keeps its mode; the conversation index inside it is narrowed to 0600 on the
next start. A `/restore` still writes back each file's own mode.
