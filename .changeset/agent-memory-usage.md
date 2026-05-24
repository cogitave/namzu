---
'@namzu/cli': minor
---

**The agent can curate its own memory, and the status bar shows token/cost.**

namzu now exposes a `remember` tool to the model: when it learns a durable fact (a stable preference, a project fact, a decision) it can save it to `~/.namzu/MEMORY.md` itself — which is injected into every future session. Just tell namzu "remember that I deploy on Fridays" and it persists it with no prompt (it's a safe self-write to your own memory file, exempt from the permission prompt).

The status bar now reports the current turn's token usage (and cost when the model is priced), e.g. `74.1k tok · $0.05`, so you can see what the agent — especially during long autonomous runs — is consuming.
