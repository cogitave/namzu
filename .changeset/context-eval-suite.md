---
'@namzu/evals': patch
---

A second behaviour suite, covering what the loop does when the context runs out.

The gate could go red but guarded one thing: the tool loop. Compaction is the mechanism most likely to be changed by someone tuning a number — a threshold, a recent-window size, a reset fraction — and the most likely to break silently when they do, because a run that compacts too eagerly still finishes. It just costs more and paraphrases away more. That is the shape a unit test does not catch and a behaviour gate does.

Five cases across the structured pass, the sliding window, a host reducer that declines, a built-in reducer, and no compaction at all. Three scorers, each pinning an outcome rather than an internal: no tool result is left without its call (the provider rejects the next turn with a 400 otherwise), the leading system message survives, and the run settles rather than throwing.

Verified by breaking the kernel and watching the gate. Removing compaction's protection of the system floor is caught. Removing *only* the reducer's tool-pair safety is **not** caught, and that is correct: the dispatch refuses a reducer result that orphans a tool result, so the outcome is unchanged and there is nothing for an outcome-shaped gate to see. Removing both guards lands a broken history and the gate catches it. A behaviour gate should measure behaviour; a scorer that went looking for the internal would have reported a regression where there was none.
