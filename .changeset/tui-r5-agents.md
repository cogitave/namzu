---
'@namzu/cli': patch
---

A background agent that asks for approval after its turn has ended no longer leaves the conversation stuck on `Working`. Once you answer, the composer is free again, the agent's end wakes the model as usual, and the launch turn closes with its `Worked for` line. Before, the screen stayed in the working state with no model request sent for the finished agent.

An agent that fails for a reason Namzu does not recognise now reads `This agent stopped because something went wrong. Message the agent to try again, or start the task again.` It no longer tells you to run with `--debug`; the raw detail still follows under `--debug`. Text that matched the old sentence must be updated.
