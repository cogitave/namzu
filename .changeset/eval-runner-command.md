---
'@namzu/cli': minor
---

`namzu eval` — the harness's signal can finally reach CI.

The eval surface was a library function and a string formatter: no command,
no CI step, and `formatReport` ending at `lines.join('\n')` with no file
write and no exit code. Its stated purpose is to give a behaviour change a
regression signal, and that signal could not reach a build without every
consumer hand-writing the runner and the report-to-exit-code mapping.

```bash
namzu eval --dir evals --out eval-report.json
namzu eval --tag fast
```

A suite is a `*.eval.js` file that default-exports a function returning an
`ExperimentReport` and may export a `tags` array. The `run` callback stays
caller-owned, so a suite owns everything about how its runs are
constructed.

| Exit | Meaning |
| --- | --- |
| `0` | Every case passed |
| `1` | At least one case failed — a regression to chase |
| `2` | At least one case was inconclusive — a broken harness to fix |
| `3` | No suite found, one could not load, or `--tag` matched nothing |

`2` is separate from `1` for the same reason `unavailable` is not zero: a
suite that could not judge tells you nothing about the cases it did judge,
and collapsing the two sends somebody hunting a behaviour change that never
happened. It is checked first. `3` rather than `0` for an empty discovery,
because a gate that finds nothing to run must not report green — and the
tag filter reports how many suites it skipped, since a filter that quietly
matched nothing looks exactly like a passing run.

Suite ids are path-derived and posix-separated so two commits' artifacts
describe the same suites and can be diffed; two files resolving to one id
is refused rather than resolved. The artifact is the whole report, because
a summary cannot say which scorer moved.

The CI workflow runs it with `continue-on-error` until the repo ships its
first suite — noted in the workflow so the flag is removed rather than
forgotten.
