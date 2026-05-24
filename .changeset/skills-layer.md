---
'@namzu/cli': minor
---

**Skills (M5 core) — load SKILL.md capability docs on demand.**

namzu now discovers agentskills.io-style skills from `~/.namzu/skills/<name>/SKILL.md` (user) and `<cwd>/skills/<name>/SKILL.md` (project, which shadows user on name clash). Each SKILL.md is YAML frontmatter (`name`, `description`) + a markdown body.

- `/skills` — list available skills, marking which are active.
- `/skill <name>` — activate a skill for the session; its body is injected into the agent's system prompt (alongside memory) on subsequent turns, so its guidance shapes the agent's behavior.

Missing skill dirs are fine (empty list). Verified live: a project skill that says "end every reply with BANANAS" made namzu do exactly that. `namzu skills` CLI subcommands, skill chains, and registry fetch are follow-ups.
