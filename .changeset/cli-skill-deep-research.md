---
"@namzu/cli": minor
---

Namzu now ships a `deep-research` skill. Ask it to compare options or survey a topic and it plans a few sub-questions, runs researchers in parallel, and writes one Markdown report where every claim cites a page that was actually fetched in that run; claims without a source are dropped or marked unverified. It is offered only in sessions that have sub-agents and web search and fetch, so nothing changes elsewhere. Nothing breaks; to turn it off, add `deep-research` to `skills.disabled`.
