---
'@namzu/cli': patch
---

`/resume` now stops the turn it interrupts, and that turn is saved where it belongs

Selecting a conversation from the `/resume` picker while the agent was working
left the old turn running. Three things followed, and the last one outlived the
process:

- its tool rows and reply text kept appending into the resumed transcript, so
  one conversation's output arrived in the middle of another;
- a follow-up you had queued for the old conversation was sent to the new one
  the moment the screen went idle;
- when it finished, it wrote its messages into the **resumed** conversation's
  stored history. `namzu` then showed you a turn you never had there, and fed it
  to the model as context on the next one.

Selecting a conversation now interrupts the running turn first, the same way
`Esc` does. The interrupted turn is not discarded: it finishes reading its own
events, its reply so far is written to the conversation it was started in, and
the transcript says so — a tool call already dispatched is not undone, and the
line says that too. Cancelling the picker still changes nothing, and a
conversation that cannot be read now leaves the running turn alone rather than
stopping it on the way to a failure.

No API changed. If you script against `namzu`'s stored history, note that
records written by this defect are already on disk and this release does not
rewrite them.
