---
"@namzu/cli": minor
---

Namzu now ships a `deep-research` skill. Ask it to compare options or survey a topic and it plans a few sub-questions, runs researchers in parallel, and writes one Markdown report where every claim cites a URL a researcher reported fetching in that run; the writer re-fetches the pages behind the most important claims and confirms the quotes, and claims that fail are dropped or marked unverified. A run costs several million tokens. It is offered only in sessions that have sub-agents and web search and fetch, so nothing changes elsewhere. Nothing breaks; to turn it off, add `deep-research` to `skills.disabled`.
