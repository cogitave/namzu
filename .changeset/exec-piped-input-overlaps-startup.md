---
"@namzu/cli": patch
---

`namzu exec "<prompt>"` no longer adds its quarter-second wait for piped input to the start of the turn when stdin is a pipe nobody writes to (a CI step, a script, a host that spawned it and kept stdin open): the wait now runs alongside the rest of the startup, which took the request about 150 ms to 250 ms sooner in that case. The rule itself is unchanged: input that begins within a quarter second of `exec` first looking at stdin is read to its end and appended to the question, and `exec` without a prompt argument, or with `-`, still waits as long as the pipe takes. Only the quarter second is promised: a producer that is slower to write its first byte (for example a slow `curl | namzu exec "summarise"`) may or may not be picked up, depending on how busy the rest of startup is; put the text in the prompt if you depend on it.
