---
'@namzu/cli': minor
---

Offer reasoning effort for the second external engine. Its model rows now carry the effort levels the engine reports (none for a model without support), so the Desktop and terminal effort controls appear. A turn that asks for a different level restarts the engine on the same session between turns with `--effort`; a level the model does not offer is refused before anything is sent. Nothing to change for callers who select no effort: the engine keeps its own default.
