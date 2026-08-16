---
'@namzu/sdk': minor
---

An opt-in `run_code` tool that dispatches a model-authored program through the run's own `ToolRegistry`.

Twenty tool calls to filter a list is twenty model turns, each at full context size with the whole conversation resent. The same work is one loop. That is the entire argument for this tool, and it only holds if the loop cannot reach further than the twenty calls could have.

**The program's reach is the run's reach.** Every capability it can call is a tool already in the registry, already narrowed by the turn's `allowedTools`, already going through the dispatch a model-issued call goes through — the permission gate, the approval policy, the audit record. There is no second path, because a second path is a second place for the gate to be forgotten and the one that forgot it would be the one a model reached through a program.

The program's own `tools` list is **intersected** with what the turn allows, computed host-side rather than trusted from the input: that list is model-authored, and a program that named every tool it wished for would otherwise widen its own grant. It is also a ceiling — a program that declared two tools and reached for a third is refused, because it has done something its author did not describe. Withheld names are reported back with what the turn does allow, so the model can correct itself in the same turn.

Declared **not** read-only and **destructive**, whatever a given program does: its effects are the union of the tools it calls, which is not knowable from the input, and `readOnly: true` would let a read-only preset auto-approve a program whose whole purpose is calling something else.

Output is posted as it is printed rather than batched until the program finishes — a program that printed its progress and then hung has told the model where it got to, and a buffer that only ships on completion loses exactly the output a timeout most needs to explain itself.

`ToolContext.dispatchTool` is the channel, and is available to every tool rather than only this one. That is stated rather than quietly true: tools are host-installed code, so the boundary this protects is the *model's* reach, and that stays bounded where it has always been.

Not in the default builtin set. A run that does not need model-authored control flow should not have a way to execute model-authored text.
