---
"@namzu/cli": minor
---

The `Agent` tool accepts an optional `phase_detail` string alongside `workflow`, `phase` and `phase_order` — display-only text for a phase, exactly like its neighbours: it creates no dependencies, barriers or serial execution. The first agent to declare a phase's detail sets it; a later sibling in the same phase cannot change it, so concurrent children with slightly different wording never make the pane flicker.

In the agent cockpit (Ctrl+T / `/agents`), a phase's detail is revealed beneath the phase list only while that phase carries the cursor — the other phases show none, and a phase with no detail renders exactly as it did before this change, with no reserved blank space. The text wraps to the pane width and is clipped to a fixed line budget, so the pane's height never depends on how long the detail is. The compact approval plan and its detailed pager (`permission-review.ts`) now surface the same text, so the plan an operator approves and the cockpit they inspect afterward agree.

Minor, not patch: this is new operator-visible capability. `SubagentActivity` and `AgentPhase` (the internal types that gained `phaseDetail`/`detail`) are not exported from `@namzu/cli`'s public entry, so no published type changed shape for a consumer.
