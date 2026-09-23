---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A generic tool result view may now set `outcome: 'cancelled'` for a call the person declined on the tool's own screen. `save_skill` and the `schedule` tool's `create`, `resume` and `delete` use it (the `schedule` tool also sets `data.cancelled` on those results), and the TUI shows the row as `○ … Cancelled — nothing was saved` instead of `✗ … failed: Error: The operator cancelled`. The model still receives the same refusal text.
