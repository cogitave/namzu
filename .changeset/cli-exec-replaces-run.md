---
"@namzu/cli": major
---

**`namzu run` and `namzu run-stream` are removed. Use `namzu exec`.**

| Before | After |
| --- | --- |
| `namzu run "<prompt>"` | `namzu exec "<prompt>"` (or `namzu e "<prompt>"`) |
| `namzu run-stream "<prompt>"` | `namzu exec --json "<prompt>"` |

`exec` takes every option the two old commands took, with the same meanings:
`--cwd`, `--provider`, `--model`, `--effort`, `--skills`, `--continue`/`-c`,
`--resume`, `--session`, `--gate`, `--gate-retries`, `--max-iterations`,
`--token-budget`, `--wait-for-provider`, `--permission-mode`, `--trust`,
`--yolo` and `--`. The default mode prints the reply exactly as `run` did and
keeps its exit codes (0, 1, 2, 64, 75, 77, and death by SIGTERM/SIGHUP/SIGINT).
`--json` writes the same NDJSON events, with the same kinds and fields, and
the same exit codes (0, 1, 75, 77) that `run-stream` did. Typing `run` or
`run-stream` now fails with commander's `unknown command` error, exit 64, and
a line naming the replacement. Update scripts, CI jobs and host UIs that spawn
either command.

**New: `--output-schema <file>` on `exec`.** It binds the final answer to a
JSON Schema through the provider's native structured output, in either mode.
Before, `--output-schema` was accepted only before the command, for the TUI,
and refused everywhere else; given before `exec` it is still refused, now with
a message that says to pass it after `exec`. A schema file that cannot be read
or represented exits 64 (in `--json` mode: an `error` event and exit 0).

**Also changed:**

- `namzu exec --session <id>` without `--json` is refused with exit 64. `run`
  accepted `--session` and ignored it, answering against no history; the
  default mode resumes with `--continue` or `--resume <id>`.
- `namzu resident` refuses `--json` and `--output-schema`, which it would
  otherwise have accepted and ignored.
- The `--log-format` help and the TUI's `--output-schema` help name `exec`.
