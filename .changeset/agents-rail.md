---
"@namzu/cli": patch
---

The agents rail under the message box is now a `main` row plus one row per agent that is running or finished in the last 30 seconds (type, description, time and spend), five at a time with `↓ N more`. Press ↓ in an empty composer to move into it: ↑/↓ select, Enter opens that agent's transcript (Esc comes back to the same row), `x` stops a running agent or clears a finished one, Esc returns to the composer. The old titled tree (workflow and phase lines, a latest-activity line per agent, the `↓ / ctrl+t` counter) is no longer drawn on the rail; `Ctrl+T` and `/agents` still open the full cockpit with all of it.
