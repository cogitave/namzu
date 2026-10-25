---
'@namzu/cli': major
---

Background agents no longer keep a turn open. In the terminal, `Agent` now runs in the background by default, and a turn ends as soon as the model has answered even though agents it started are still running.

What breaks:
- The `Agent` tool's `run_in_background` default is now `true` in the terminal (it stays `false` for headless runs: `-p`, ACP, scheduled runs). A prompt, skill or hook that relied on `Agent` waiting for the result must say `run_in_background: false`. The tool description the model reads changed with it.
- Esc no longer stops background agents. Only the model's reply is interrupted; stop agents with Ctrl+C on an idle composer, `ctrl+x ctrl+k`, or `x` on a rail row. The first Ctrl+C on an idle composer now stops running background agents instead of arming the exit reminder; press it again (with none left) to exit.
- Text typed while only background agents are running is a new message, no longer a correction to the running turn. The `Working (esc to interrupt)` spinner no longer runs for them; a dim `Waiting for N background agents to finish` line shows instead.
- A finished agent now leaves one row, `Agent "…" finished · 8s (ctrl+o to expand)`, instead of a `Message from @type` row plus a `finished` row. Anything matching the old two-row text must be updated.

New: every agent that ends while the conversation is idle wakes the model once, with all of them in one message; a batch the turn waits on shows a live `Running N agents…` group and writes `N agents finished`.

To keep the old behaviour in a script, set `run_in_background: false` in the call.
