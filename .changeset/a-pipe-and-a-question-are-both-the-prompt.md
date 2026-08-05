---
'@namzu/cli': patch
---

`namzu run` stops discarding piped input when a prompt is also given

```
cat notes.txt | namzu run "summarise this"
```

sent the model three words. The file was read by nothing: piped input was
consulted only when there was no prompt argument at all. The run succeeded, exit
0, and the answer was about nothing — a pipe and a question are the ordinary way
to ask about a document, and taking only one of the two is the worst available
reading of that command.

Piped input is now used in both cases. With no prompt argument it IS the prompt,
as before. Alongside one it is appended as the material the question is about,
fenced so the model can tell the request from the content:

```
summarise this

<stdin>
…the file…
</stdin>
```

`namzu run -` reads the prompt from stdin explicitly. Previously `-` was sent to
the model as a one-character question.

**On waiting.** Whether anything is being piped in cannot be answered without
reading: a real pipe, an inherited-but-idle pipe and a test runner's stdin are
indistinguishable to `fstat` on Windows — all three report neither FIFO nor
file. So when the prompt came from an argument, the read waits up to 250ms for
the first byte and then gives up; once a byte arrives it reads to end-of-input
with no deadline, so a slow or large producer is never truncated. Without the
bound, `namzu run "hello"` would hang forever in any context where stdin is open
and silent, which is the ordinary state of a CI step. When there is no prompt
argument the wait is unbounded, exactly as before — that path is a caller who
has already said the prompt is coming.
