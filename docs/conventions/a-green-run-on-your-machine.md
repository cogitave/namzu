---
uid: namzu.conventions.a-green-run-on-your-machine
title: A green run on your machine is not a green run
description: Three CI failures in one session, none reproducible locally, none about the change. What differed was never configured — what happened to be built already, which binary a name resolves to, what the job installs. Reproduce the condition before diagnosing it.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-17T00:00:00Z
lastReviewed: 2026-08-17
tags: [convention, ci, verification]
---

# A green run on your machine is not a green run

Your working tree carries state nobody wrote down: build output from an hour
ago, a `/bin/sh` that is one shell rather than another, packages installed
because a previous task needed them. CI checks out clean and has none of it.

So a local pass is evidence about **your machine plus your change**, and the
two are not separable by looking harder. Three failures in one session were
each invisible locally, each fully deterministic, and none of them was about
the change that surfaced them.

## Already built

`pnpm typecheck` is `tsc --build`, which builds project references in the
order they are declared. `packages/cli` imported `@namzu/telemetry` and
declared no reference to it. Locally that resolves, because `dist/` has been
there since the last build; on a clean checkout it is `TS2307: Cannot find
module`.

Fixing it turned up the same defect one step subtler. `packages/cli` also
imports `@namzu/files` with no reference, and passes — because the ROOT
tsconfig happens to list `./packages/files` before `./packages/cli`, and
`./packages/telemetry` after it. Moving `files` to the end of that list
reproduces the identical error. **Ordering was doing work that a declaration
should do**, and nothing said so.

## Which binary the name resolves to

A process-table test asked whether a held process was still alive with
`execSync('pgrep -f "<token>"')`. `execSync` goes through `/bin/sh -c`, which
puts the token in that shell's own argv, and `pgrep -f` matches full command
lines while excluding only its own pid.

Whether the probe sees itself therefore depends on the shell: one that
exec-replaces itself with a lone simple command leaves nothing behind, one
that runs it as a child does not. `/bin/sh` is `bash` on the machine where it
was written and `dash` on `ubuntu-latest`. In CI the probe matched itself
unconditionally, and three tests reported a process-kill failure on a kill
that had worked perfectly.

Demonstrated rather than deduced: pointing `execSync` at a shell that runs its
command as a child returns exactly one phantom match for a token nothing
holds, and `spawnSync('pgrep', ['-af', token])` — argv straight through, no
shell — returns none.

## What the job installed

A gate that compiles documentation against built packages mapped every
publishable package's types, and skipped any whose `dist` was missing. The
Docs job builds one package. So the specifiers for the others went unmapped
and surfaced as `TS2307` on the reader's import line — **a wrong diagnosis of
a right complaint, pointed at the documentation** instead of at the build.

Locally everything was built, so it passed.

## The rule

**Reproduce the condition before you diagnose the symptom.** Every one of
these is deterministic once the condition is there, and each took minutes to
reproduce and would have taken an afternoon to reason about:

- `tsc --build --clean`, delete the `.tsbuildinfo` files and the `dist/`
  directories, then run the check.
- Force the other tier, shell or platform with a shim on `PATH` rather than
  arguing from the source. A fake `unshare` that exits 1 selects the fallback
  isolation tier; a `/bin/sh` that runs its argument as a child instead of
  exec-ing it selects the other shell behaviour.
- Move a directory aside and read the message the tool prints. That is also
  how you find out whether the message blames the right thing.

**Declare what you depend on.** A reference, not an ordering. A mapped
specifier, not a leftover `dist/`. `spawnSync` with argv, not a string a shell
will re-parse.

**Absent and unbuilt are different answers.** A check that treats "not built
yet" as "does not exist" produces a confident, wrong error somewhere else
entirely. Refuse, name the packages, and print the command that fixes it.

## The tell

You are in this failure when the local run is green, the CI run is red, and
the diff explains neither. Do not reach for "flaky" — two of the three above
had already been written off that way, and one of them was a real
process-tree bug hiding behind the label.

## Related

- [A fixture unlike production tests a system that does not ship](./fixture-must-match-production.md)
  — the same gap where the author *did* write the configuration. Here nobody
  wrote it; it accumulated.
- [Verify claims, including your own](./verify-claims-including-your-own.md) —
  "it passes locally" is a claim about a machine, and says so.
- [A gate must say where it looks, and derive it](./a-gate-must-say-where-it-looks.md)
  — the unbuilt-sibling case is this rule and that one meeting.
