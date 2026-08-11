---
uid: cli.doctor
title: namzu doctor
description: What namzu doctor checks, what each status word means, and what its exit code tells a script — including the code that says a check could not answer rather than that everything is well.
type: reference
diataxis: reference
owner: bahadirarda
status: current
timestamp: 2026-08-09
lastReviewed: 2026-08-09
last_updated: 2026-08-11
related_packages: ["@namzu/cli", "@namzu/sdk"]
---

# `namzu doctor`

Health checks for the local namzu environment. It reads the machine and prints
what it found — the sandbox platform, whether the working directory and temp
directory are writable, which credential sources were scanned and what each
yielded, the configured provider chain member by member, and whether the
optional telemetry package is installed.

```bash
namzu doctor                          # human-readable report
namzu doctor --json                   # machine-readable DoctorReport
namzu doctor --category providers     # only these categories
```

## The five status words

A check reports one of five things, and the last two are separate on purpose.

| Status | Mark | Means |
| --- | --- | --- |
| `pass` | `✓` | The check looked and everything is as it should be. |
| `fail` | `✗` | The check looked and something is wrong. |
| `warn` | `!` | Usable, but less than you declared — a fallback with no credential, no credential found at all. |
| `skipped` | `⊘` | **There was nothing here to check.** An optional package is not installed; a registry has no auto-discovery to read; nothing is configured yet. An ordinary state of a healthy machine. |
| `inconclusive` | `?` | **The check did not answer.** It timed out, it was aborted, or the thing it reads threw. Nothing is known either way. |

`skipped` and `inconclusive` used to be one word, and collapsing them is what
made the exit code below wrong: an absent optional package and a check that
never returned were reported identically, so the report could not distinguish
"there is nothing to say about this" from "I failed to find out".

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every check answered, and none of them failed. Skipped and warned checks do not move this off `0`. |
| `1` | At least one check reported `fail`. |
| `2` | No checks were registered — namzu is not configured here, or a `--category` filter matched nothing. |
| `69` | At least one check **could not answer**. Nothing was established to have failed, and nothing can be concluded from the rest of the report either. |
| `70` | An internal CLI error (sysexits `EX_SOFTWARE`) — worth a bug report. |
| `78` | A config file is there and could not be read, so **no check ran**. Distinct from `2`: `2` says namzu is not configured here, `78` says its configuration cannot be established, and those are fixed by opposite actions. See [A config namzu cannot read stops the run](./headless.md#a-config-namzu-cannot-read-stops-the-run). |

`69` outranks `0` and is outranked by `1`. A definite failure is the actionable
fact and `1` claims no health, so reporting it loses nothing; conversely a run
where nothing failed but something went unanswered must not be reported as
healthy, because **a report that could not look tells you nothing about the part
it did look at.** That is the same argument the eval harness makes for its own
inconclusive code, and it is why the two are not folded together here.

The number differs from the one `namzu eval` uses for the same idea — `eval`
says `2` — and that is deliberate rather than an oversight: `doctor` had already
spent `2` on "no checks registered", and giving one number two meanings inside
one command is worse than giving one meaning two numbers across two.

`69` is sysexits `EX_UNAVAILABLE`, whose own definition ends "a catchall message
when something you wanted to do doesn't work, but you don't know why".

### In CI

```bash
namzu doctor || case $? in
  1)  echo "something is broken";      exit 1 ;;
  69) echo "the report is incomplete"; exit 1 ;;
  2)  echo "namzu is not set up here"; exit 1 ;;
esac
```

A pipeline that treats every non-zero code the same still behaves correctly;
what changes is that it now *notices* the incomplete run it used to pass.

## Options

| Option | Effect |
| --- | --- |
| `--json` | Emit the `DoctorReport` as JSON instead of the human report. |
| `--verbose` | List the failures again at the end, with their messages. |
| `--category <a,b,c>` | Run only these categories: `sandbox`, `providers`, `vault`, `telemetry`, `runtime`, `plugins`, `custom`. |
| `--per-check-timeout <ms>` | How long one check may take (default `5000`). A check that exceeds it is `inconclusive`. |
| `--wall-clock-timeout <ms>` | How long the whole run may take (default `10000`). Unfinished checks are `inconclusive`. |

Both timeouts produce `inconclusive`, and therefore `69` — which is the point of
having them: a diagnostic that hangs is no better than one that lies, and a
diagnostic that gives up quietly is worse than both.

## Registering your own checks

`vault.registered` and `providers.registered` are `skipped` on every machine.
Neither a `CredentialVault` nor a provider registry can be discovered from
outside the process that built it, so there is nothing for a built-in check to
enumerate. Register one that knows your wiring:

```ts
import { registerDoctorCheck } from '@namzu/cli'

registerDoctorCheck({
  id: 'vault.mine',
  category: 'vault',
  run: async () => {
    // Return `inconclusive` only when you could not find out.
    // "There was nothing to check" is `skipped`, and it exits 0.
    return { status: 'pass', message: 'vault reachable' }
  },
})
```
