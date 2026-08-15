---
'@namzu/sdk': patch
'@namzu/cli': patch
---

A default-level start is readable again, and a misplaced global flag says where
it goes.

`ManagedRegistry.register` logged at `info`, once per item, and a CLI run
registers dozens — every builtin tool, every agent, every task tool. Turning
the logger back on therefore replaced silence with twenty lines of
`Registered: read`, `Registered: write` ahead of anything an operator could act
on. Registration is the startup path working; it belongs at `debug`. The
overwrite case stays at `warn`, because a second registration under a live id
is news.

`namzu run "…" --verbose` was answered with "pass `--` before a prompt that
starts with a dash" — advice about a prompt beginning with `-`, which sends the
reader to the wrong half of their command line. `--verbose`, `--quiet`,
`--log-format` and `--format` are program options, accepted before the command
name, and the refusal now says exactly that and shows the position.

Both were found by running the CLI against a real provider. Every unit test in
these paths asserts against a logger stub or passes flags in the position that
already worked, so neither was visible to any of them.
