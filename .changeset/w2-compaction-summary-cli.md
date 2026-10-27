---
'@namzu/cli': major
---

`/compact` and every automatic compaction now have the small model write the summary, where before `/compact` without text made no model call and an automatic pass used a summary Namzu extracts by matching phrases. The small model is `smallModel`, else the cheapest text model of your provider; it reads the part being replaced and writes your requests in your own words, the current work and the next step. When no small model is set aside, it cannot be reached, its call fails or stalls, or it returns no summary, Namzu uses the extracted summary as before and the compaction goes on. The call is counted on the turn's token ledger (a `/compact` between turns, on the latest turn), so it spends tokens where nothing was spent before.

To keep the old behaviour, set `compaction: { modelSummary: false }` in `namzu.config.json` or `~/.namzu/config.yaml`. A conversation with no small model (the route falls back to your own model) is unchanged.
