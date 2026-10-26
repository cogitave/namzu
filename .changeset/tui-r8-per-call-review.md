---
'@namzu/cli': major
---

The terminal now asks about one tool call at a time instead of showing one prompt for a whole batch. Reads and other calls that are safe to run together each open their own prompt and start as soon as you answer; a call that changes something waits for the calls before it, then asks, then runs. Three things change for anyone who drives or scripts the terminal:

- There is one prompt per call, so a model response with three calls opens three prompts in turn. "Do you want to run these N tools?" and the "N more awaiting approval" line are gone; a dim `2 of 3` on the title row says where you are when two or more questions are open.
- A plain No (or Esc) now ends the turn: what is running is cancelled, calls that have not started are refused without being asked, and the model is not called again. Before, the model was told the call was declined and carried on. To refuse one call and let the agent carry on, press Tab on the No row, type the reason and press Enter; the reason reaches the model.
- Pressing "Yes, and don't ask again" or the accept-edits answer now re-checks every question still open and lets through the ones the new rule or mode covers, without showing them. A call that leaves the working directory, always needs a person or was too large to show in full is still asked.

A script that answered the batch prompt with a single key must now answer each call's prompt; the "don't ask again" answer passes a repeated command. Questions from other agents queue behind your own and say which agent is asking. A connector's tool is named by its server and tool (`slack · post`) in the prompt. Desktop, ACP and `namzu exec` are unchanged.
