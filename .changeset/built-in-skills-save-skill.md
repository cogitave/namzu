---
'@namzu/cli': minor
---

The CLI ships three built-in skills and a way to make your own from the TUI.

- `skill-creator` (model and operator), `browser-automation` (model only, offered only when the `browser` tool is present) and `schedule-task` (offered where the `schedule` tool is: the TUI). Every session now carries the `skill` tool and lists `skill-creator` in its skills manifest. To go back to no built-ins, set `skills.builtin: false`; to drop one, name it in `skills.disabled`; a skill of the same name in `~/.namzu/skills`, `~/.agents/skills` or the project replaces it.
- `/skills new [what it should do]` starts an interview with the model, which drafts a `SKILL.md` and proposes it through the new `save_skill` tool. Nothing is written until you choose Save to user (`~/.namzu/skills`), Save to project (`./.namzu/skills`) or Cancel on a screen that shows the whole file with invisible characters revealed and names any skill it replaces. The screen asks in every permission mode, `auto` included; `plan` and `strict` refuse the tool. `save_skill` exists only in the interactive TUI, never in `exec`, `drain`, a scheduled run or a sub-agent. `/skills new` is now a subcommand, so a skill named `new` is activated from the `/skills` picker rather than by `/skills new`.
- The skill tiers are read again at the start of every turn, so a skill added while a session runs is offered from the next turn.
