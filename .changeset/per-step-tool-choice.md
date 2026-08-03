---
'@namzu/sdk': minor
---

A step can force the model's tool use, and the force cannot outlive that step.

`PrepareStepResult.toolChoice` accepts `'required'`, `'none'`, or a named function. Until now the loop set `tool_choice` only internally, only to `'none'`, and only on the forced-final turn — so a caller could narrow *which* tools a step may reach for, but never make it actually call one. The clearest cost was structured output: the model answers in prose, the loop pays another full billed turn re-prompting, and after the retry limit the run dies — where one forced choice would have produced the object on the first turn.

**Why it lives on the step and not on the run config.** A forced choice that persists makes the model call a tool, read the result, and be forced again — an agent that cannot stop. Studying how a peer SDK handles this was the useful part: it puts `tool_choice` on persistent model settings and then needs three moving parts to undo it — a tool-use tracker, an opt-out flag, and a reset applied at two separate call sites — with the flag defaulting to on precisely because turning it off hangs the agent. Two other peer runtimes ship no forced choice at all.

Putting the knob on `prepareStep` removes that failure instead of managing it. The next step is prepared from scratch, so the force cannot carry forward: there is nothing to reset and no flag to get wrong. The loop still keeps the last word — the forced-final turn's `'none'` wins, so a run that must stop can still stop — and a choice is dropped when no tools are registered, because providers reject `tool_choice` sent without a tool list.

It costs more prompt cache than `activeTools` does: narrowing tools invalidates the tool prefix, moving `tool_choice` invalidates cached message blocks too. That trade is documented on the field so it is paid knowingly, at a phase boundary, rather than by habit.
