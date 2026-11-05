---
'@namzu/cli': minor
---

New `decision.points` setting: the places the CLI may ask your decision model a yes/no question beside its own rule, each `off`, `shadow` or `on`. Every point is off unless you name it, because a question carries text of the conversation to the decision service. In `shadow` the model is asked and its answer is only written to `<NAMZU_HOME>/decision/points.jsonl` (sizes and probabilities, never text) beside what the rule decided; in `on` a confident answer decides. The first point, `notify-worthy`, weighs whether a finished reply is worth a chime, so a short reply that asks you something can ring and a long one that ends in "done" can stay quiet. A stop, a failure and an approval always sound.
