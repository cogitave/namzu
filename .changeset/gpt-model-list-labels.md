---
"@namzu/cli": patch
---

The Desktop model list writes a GPT display name such as "GPT-5.6-Sol" as "GPT-5.6 Sol", the way the Codex app does. Only names that start with "GPT-" and end in "-<Word>" change; model ids sent to providers, and every other family's labels, are unchanged. Nothing to do on upgrade.
