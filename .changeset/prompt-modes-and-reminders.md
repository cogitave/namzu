---
'@namzu/cli': minor
---

Plan mode, the date and the permission mode no longer change the cached system prompt, so toggling plan mode, a new day or a Shift+Tab keeps the prompt cache warm. Plan mode's instructions now arrive only as the plan-mode reminder, the date and branch arrive as an environment reminder (with a short notice, that needs no announcement, when either changes), and `auto`, `accept-edits` and `bypass` are announced when they start and when they end. Queued operator messages and background-job notices are wrapped so they are labelled as what they are. Nothing to change in your setup; a prompt override that looked for plan-mode text in the system prompt should read the reminder instead.
