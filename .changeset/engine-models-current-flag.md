---
"@namzu/cli": minor
---

The desktop model catalogue (`namzu/providers/models`) now carries an optional
`current: true` on a row when the execution engine itself says the model is current
rather than an older release: the Claude Code engine's alias rows (a model id that
names no version) and the Codex engine's default row. A client that ignores the field
is unaffected, and rows without it read as before. Nothing needs changing to keep the
old behaviour.
