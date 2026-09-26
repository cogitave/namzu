---
'@namzu/cli': minor
---

Add `namzu skills --audit` to check which file skills the model can actually load. It exits with status 1 for an invalid enabled skill, reports the SDK loader's reason, and can estimate manifest overflow with `--context-window <tokens>`.
