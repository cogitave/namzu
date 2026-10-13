---
"@namzu/cli": patch
---

`namzu exec "<prompt>"` no longer adds its quarter-second wait for piped input to the start of the turn when stdin is a pipe nobody writes to (a CI step, a script, a host that spawned it and kept stdin open): the wait now runs alongside the rest of the startup, which took the request about 150 ms to 250 ms sooner in that case. The rule itself is unchanged: input that begins within a quarter second of `exec` first looking at stdin is read to its end and appended to the question, and `exec` without a prompt argument, or with `-`, still waits as long as the pipe takes. Because the rest of startup is now faster, a producer that waits close to a second before its first byte (for example a slow `curl | namzu exec "summarise"`) is no longer picked up by accident; start the producer first or pass the text as the prompt.
