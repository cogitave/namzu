---
"@namzu/cli": minor
---

A turn now answers the person at once when they write while a long tool call runs: the call keeps going, the model is told it is still running, and its result follows later. The model also hears about running work without asking: a note when a workflow run moves to its next phase (it rides with the next request and does not start a turn), and a check-in when a background command has printed nothing for two minutes (it starts a turn if the session is idle, and comes again after twice the silence, four times in all for one stretch of silence, and is withdrawn if the command prints or ends before the model reads it). The workflow instructions tell the model to read a run's state, not the launch receipt, when asked how it is going. Nothing is removed or renamed.
