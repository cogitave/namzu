---
'@namzu/sdk': minor
---

`prettySink` renders the boot sequence as a readout instead of a wall of
timestamps.

Three changes, each answering a specific half of "the logs tell me nothing
when the project starts":

- **`+Nms` instead of an absolute ISO clock.** Elapsed since the previous
  record on that sink, so the column reads as which phase was slow. The
  state is per sink instance, so two sinks in one process — a file and a
  terminal — each measure their own stream.
- **A fixed-width scope column, coloured by a stable hash of the label.** A
  dozen module initialisations read as structure rather than scroll, and the
  colour is the same in every process on every machine: the hash is FNV-1a
  over the label with a pinned eight-colour palette, touching no process
  state.
- **A template per boot event**, so `info` shows the two attributes that
  matter rather than all of them as JSON. The map is total over
  `BootEventName`, so adding an event without deciding how it reads is a
  compile error.

Warnings and refusals are marked with a glyph in a fixed column rather than
a `[WARN]` label, so they are findable by eye.

Colour is emitted only when the stream reports `isTTY`; a redirected log
contains no escape bytes at all. Records from outside the boot vocabulary
keep the previous line format. Nothing here mutates a record, and
`jsonLinesSink` produces identical bytes whether or not the renderer is
installed.
