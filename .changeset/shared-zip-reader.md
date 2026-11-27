---
'@namzu/cli': patch
---

Internal refactor: the zip reading and safety checks of extension packages moved into a shared module. No behaviour change; package refusals keep their codes and messages.
