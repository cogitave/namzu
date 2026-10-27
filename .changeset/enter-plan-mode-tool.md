---
"@namzu/cli": minor
---

The model can now propose planning before a change that is not small. A new deferred tool, `enter_plan_mode`, asks "Enter plan mode?" and switches the session to plan mode only after you say yes; under Auto mode it switches without asking, and in a headless or scheduled run it never switches. Nothing needs changing; to keep the model from proposing it, deny the tool in your permission rules.
