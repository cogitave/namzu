---
'@namzu/cli': major
---

**`run-stream --session <key>` no longer answers against a history you did not
ask for, and no longer ends on a bare `done` when it failed to save the turn.**

Two bare `catch` blocks at opposite ends of the same command, both of which
produced an ordinary success.

## What breaks

**A conversation that cannot be opened now stops the run.** Given `--session`,
if the store cannot be reached — an unwritable `.namzu`, a corrupt map file —
`run-stream` emits an `error` event and runs nothing. It used to fall through to
the stateless path, which takes prior turns from **stdin**, so a caller who named
a conversation got a turn composed against a different history, or none, and
`exit 0`.

*If you relied on that fallback:* drop `--session`. That asks for the stateless
run explicitly, which is the only way the command can tell the two apart.

It is a refusal rather than a warning-and-continue because the command cannot say
what was lost. A key is created on first use, so a fresh key legitimately has no
prior turns — and the failure is precisely what stopped it finding out which case
it was in. "Could not look" is not "there was nothing there."

## Also

**A turn that could not be saved now says so**, as a `notice` on the event
stream, naming the reason and the consequence: `history` for that session will
not include the turn and the next turn will not have it as context. The run still
succeeds and still exits 0 — the reply is complete and a host treating this as a
failed turn would be wrong. It was previously swallowed, which made a later
`namzu history` look broken with nothing connecting it to a write minutes
earlier.

`notice` is an existing event kind on this stream, already used for the config
notices a few lines above the same handler.
