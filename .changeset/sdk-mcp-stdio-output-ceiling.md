---
"@namzu/sdk": patch
---

A stdio tool server can no longer grow the session with its output. The
transport held every stdout read and kept the part after the last newline as
the pending line, with nothing bounding that tail: a server that wrote one
very long line, or only ever wrote, grew the session's memory for as long as
it kept writing and reported nothing while it did. The pending line now has a
stated ceiling (8 MiB, generous enough for a frame carrying an inline image);
a line that passes it is dropped and reported once, and the bytes up to its
terminator are skipped rather than re-measured per read, so the frame after it
is still read. A teardown in that state still reaps the child. Each stderr
record the transport logs now carries the head of the read and its full
length, so a server that floods its error stream cannot put a whole read into
one log record.
