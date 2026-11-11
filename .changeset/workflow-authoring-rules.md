---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A workflow script's phase titles now match ignoring case when no declared title matches exactly: `phase('scan')` and `agent(..., { phase: 'SCAN' })` join the declared `Scan` group, and the declared spelling is the one shown. A title that matches a declared one exactly always does, so a script that declares both `Scan` and `scan` still parses and keeps two phases. A run resumed from an older journal reads it as before and groups its phases by the new rule. `meta.whenToUse` and `meta.phases[].model` are accepted and still do nothing; the docs now say so.

The workflow tool's text tells the model how to word a name, description, phases, agent labels and log lines, so reviews and rows read more evenly. A long workflow name in the closing line is now cut with an ellipsis at 48 cells instead of wrapping over several rows, and the `/workflows` list cuts at the same width. Control characters, direction marks and overrides, the line and paragraph separators, the zero-width space, the word joiner, the invisible operators and the byte-order mark in names, titles, labels and log lines were already shown as `\u{....}` literals everywhere; that is now one helper and is pinned by tests. The two joiners U+200D and U+200C are kept as they are, because emoji sequences and some scripts need them.
