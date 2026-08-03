---
'@namzu/sdk': minor
---

A conversation with no turn boundary

Every other seam in this kernel is turn-based by construction: a run has iterations, an iteration sends a complete message list and reads a stream back, and a checkpoint is taken between two of them. That shape cannot describe a duplex session, where input keeps arriving while output is still being produced and "the turn" is not something either side can point at.

`BidiProvider` / `BidiSession` is a second contract rather than a widening of the first — bending `chatStream` to accept a live input channel would put a half-duplex assumption inside every consumer of the turn-based path in exchange for a duplex path that still would not fit. `startBidiRun` is the loop that runs tools against it.

Two properties matter here that the turn-based loop never needs. A tool must not block the stream: awaiting one inline would stall the very events an interruption arrives on, so calls start and are not awaited. And an interruption invalidates work in flight: a call still running when the human speaks over the model is abandoned rather than delivered, because a stale answer in a conversation that has moved on is worse than no answer.

Audio capture and playback are not here — the types carry audio, but the microphone belongs to the host. Neither is checkpoint/resume: a duplex session's state lives on the far side of a socket with no boundary to snapshot at, and checkpoints that cannot restore would be worse than none. The contract ships with a scripted driver, which is how the turn-based path is developed too.
