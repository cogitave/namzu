---
'@namzu/cli': minor
---

a compaction says so, instead of discarding context in silence

Compaction deletes messages irrecoverably at 70% of the context window. The
kernel measures the loss and puts both outcomes on the wire specifically so a
host can show it; this one dropped them at `default: return null`, one function
from the screen. So the first time anyone learned compaction existed was when
the agent had forgotten something they were relying on — which reads as the
model being stupid rather than the harness discarding context.

Everything else fixed recently was *the run quietly not doing what the operator
said*. This is the same class with the opposite sign: *the run quietly doing
something they did not ask for*.

A compaction now appears in the transcript, on stderr for `namzu run`, and as an
NDJSON event for a host:

```
⌫ context compacted — 42 messages replaced by 9, ~120k → ~38k tokens
```

**Only what is checkable.** Compaction summarises, so it cannot enumerate what
was lost — the loss is fidelity, not a set of removable items, and "removed the
file contents from turns 3-8" is a claim that cannot be substantiated and is
worse than silence the first time it is subtly wrong. An estimated token count
says it is estimated, because quoting an estimate as a measurement is that same
lie in miniature.

**A compaction that declines says which of three things happened**, because they
want different responses and "compaction failed" would put the reader back where
the silence did: a reducer that threw may work next pass and carries its own
error; a reducer that shed nothing is reporting a fact, not an error, and will
answer identically every time; a reducer that split a tool call from its result
is a bug with no user action at all. Every case states that the history is
unchanged, which the kernel guarantees by installing a reduction whole or not at
all.

The notice goes in the transcript rather than a status indicator, because an
indicator is present while nothing is happening and gone afterwards — someone
reading back could not tell whether the gap they were looking at was compacted.
