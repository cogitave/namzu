---
'@namzu/cli': patch
---

A background agent that asks for approval after its turn has ended no longer leaves the conversation stuck on `Working`. Once you answer, the composer is free again, the agent's end wakes the model as usual, and the launch turn closes with its `Worked for` line. Before, the screen stayed in the working state with no model request sent for the finished agent.
