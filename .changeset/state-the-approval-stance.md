---
'@namzu/cli': patch
---

A session running under `strict`, `auto` or an unattended mode now tells the model once, in one sentence, that a call outside the allowed bounds is refused without a question, so it picks another route or reports what was blocked instead of asking for approval nobody will give. No setting changes; the other modes' prompts are byte-identical.
