---
"@namzu/cli": patch
---

The first model request is smaller: `computer_use`, `browser`, `browser_act`, `list_pals` and `send_pal_message` are no longer sent while they cannot work (the provider cannot return images or the desktop host is unavailable, no browser engine can run, the owner has no Pals), and are sent again as soon as they can. About 1,150 tokens fewer in the terminal on a machine with none of those. Nothing a working tool does changes; a model that names a suspended tool is told it is suspended instead of receiving its own refusal text.
