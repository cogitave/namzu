---
"@namzu/cli": minor
---

`namzu eval` takes `--repeat <n>` (run every case n times, 1 to 100) and `--seed <n>` (seed for the 95% intervals), and reaches suites that were written before either existed. It prints each suite's intervals and a whole-run summary, and `--out` now writes `schemaVersion: 2` with a `run` object and, per suite, the disclosure of what produced it. New `namzu eval compare <a.json> <b.json> [--json] [--seed <n>]` pairs two written reports by suite and case id and prints the paired difference with its interval, the flips with an exact test, one sentence that claims a winner only when the interval excludes zero, and what differs between the two runs, with a warning when more than one thing does. The exit codes of a run are unchanged. A bad `--repeat` or `--seed` is a usage error (exit 3). Nothing to change on your side.
