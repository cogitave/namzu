---
"@namzu/cli": patch
---

Fix derived resume titles being stuck at `Conversation` when project instructions were saved before the first user prompt. Preserve explicitly named conversations, add selected-conversation previews on taller terminals, and offer an explicit continuation choice for saved active or paused goals without automatically starting work on resume.

Use project-scoped session listing in the disk-backed resume picker instead of scanning every project in the application home.
