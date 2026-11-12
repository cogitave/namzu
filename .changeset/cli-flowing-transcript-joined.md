---
'@namzu/cli': patch
---

The three terminal changes that arrived together (a reply drawn as it is written, painting only what changed, and the quieter rows and working region) now also hold when they meet. A window made shorter while a long reply is being written no longer prints a row of it twice: the rows the terminal pushed into scrollback are not written again. A compaction, which clears the screen and writes the conversation again, draws the conversation and the live region under the new painting instead of leaving the screen empty. The part of a reply still being written is kept short enough that it, the plan under the working line, the running calls and a queued message fit the window together. Nothing to do on your side.
