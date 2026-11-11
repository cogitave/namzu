---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A workflow script's phase titles now match ignoring case: `phase('scan')` and `agent(..., { phase: 'SCAN' })` join the declared `Scan` group, and the declared spelling is the one shown. `meta.phases` now refuses two titles that differ only by case, so a script that declared both `Scan` and `scan` stops parsing; remove one. A run resumed from an older journal reads it as before and groups its phases by the new rule. `meta.whenToUse` and `meta.phases[].model` are accepted and still do nothing; the docs now say so.

The workflow tool's text tells the model how to word a name, description, phases, agent labels and log lines, so reviews and rows read more evenly. A long workflow name in the closing line is now cut with an ellipsis at 48 cells instead of wrapping over several rows, and the `/workflows` list cuts at the same width. Control, direction and zero-width characters in names, titles, labels and log lines were already shown as `\u{....}` literals everywhere; that is now one helper and is pinned by tests.
