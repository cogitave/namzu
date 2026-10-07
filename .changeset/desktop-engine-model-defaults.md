---
'@namzu/cli': minor
---

Codex model names in the Desktop model list now read like the Codex app ("GPT-5.6 Sol" instead of "GPT-5.6-Sol"), and each engine's model list marks that engine's own recommended default with an optional `default: true` flag on the row. Namzu provider lists no longer say "Namzu default" in a row's note; the flagged row replaces it. Model ids are unchanged, so saved selections keep working; clients that read the model list can ignore the new flag.
