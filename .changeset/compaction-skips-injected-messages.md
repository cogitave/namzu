---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Compaction no longer treats text the runtime put in the user role as something the operator asked for. Project instructions, step context and reminders are skipped when the summary's task and requirements are extracted, and are left out of the excerpt the summary check reads, so a compacted conversation no longer lists the project's rules as the user's requests. The project instructions are still kept whole, once, and re-read fresh on the next turn. The project instructions message now also says that project rules win over Namzu's default style and workflow, and never over safety or permission rules. Nothing to do on upgrade.
