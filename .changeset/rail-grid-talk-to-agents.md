---
"@namzu/cli": minor
---

The agents rail, the workflow detail and talking to a sub-agent now follow the reference terminal. What changes for you:

- The rail has a blank row above it, its bullet sits under the footer line's first glyph, rows stop two cells short of the edge, and the pointer and bullets use no accent colour. While the rail has the keys its key line (`Enter to view · x to stop`, plus `ctrl+x ctrl+k to stop all agents` when several run) replaces the footer's mode line instead of being printed under the rows. A background agent that completes leaves the rail at once; a failed or stopped one stays 30 seconds. `ctrl+x ctrl+k` on the rail stops every running agent.
- A running background agent's description column becomes a live three-to-five-word label, refreshed at most every 30 seconds by one tool-less request to the agent's own model; it adds model usage, and falls back to the launch description. A message waiting for an agent shows as `N queued`.
- The workflow detail is a frameless dialog, side by side from 64 columns.
- Enter on an agent now views it on the main screen with the one composer live (`Message @<type>…`): typing sends to the agent, Esc or the `main` row goes back, and the separate message box is gone. A finished agent is resumed by a message; `send_message` does the same, and refuses an agent you stopped.
- Finished agents leave `› Message from @<type>` (collapsed) and `● Agent "<description>" finished · 1m 4s` in the conversation instead of the old `✓ name · time · tokens` row, and the launch receipt lists each agent by its description. Scripts that read the old rows must follow the new wording.
- The `Agent` tool's `description` parameter now asks for a short (3-5 word) description of the task.
