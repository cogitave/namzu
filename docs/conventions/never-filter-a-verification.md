---
uid: namzu.conventions.never-filter-a-verification
title: Never filter a verification down to something that can read green
description: Piping a check through a line filter can discard the diagnostic while keeping a summary line, so the check runs, its answer is invisible, and what you see reads as success.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-04T00:00:00Z
lastReviewed: 2026-08-07
resource: .github/workflows/ci.yml
tags: [convention, verification, tooling]
---

# Never filter a verification down to something that can read green

Piping a check through a line filter to keep the output short can discard the
diagnostic while keeping a summary line — so the check runs, its answer is
invisible, and what you see reads as success. A filter that can produce a
confident green is worse than not running the check at all: not running it
leaves you uncertain, and this leaves you wrong.

Read the verdict the tool prints — its count of errors — not the lines your
filter chose to keep. If the output is genuinely too long, filter on the
verdict, never on a guess at what the diagnostic will look like.

## The incidents, all in one day

- A CLI change went red in CI on a lint rule. The author had run the linter
  before committing, through a chain ending in a two-line tail and a search for
  the test summary. The chain kept the summary and dropped the diagnostic.
- A release failure was diagnosed as an expired publish credential on the
  strength of a `404 Not Found - PUT` line surfaced by a filter matching
  "error" and "404". The first error line, eliminated by that filter, was
  `IDENTITY_TOKEN_READ_ERROR: error retrieving identity token` — a provenance
  failure on the runner. The credential was fine. The owner said so, which is
  the only reason the log was re-read.
- The same session had already adopted this rule from the first incident, in
  writing, and broke it in the next command.

## It recurred, in a shape the rule did not spell out

2026-08-07. An agent ran `node tools/check-docs.mjs 2>&1 | tail -4; echo $?`
and read `0`. The gate had found a problem and exited `1`. The zero belonged to
`tail`.

This is the same failure through a different door. The earlier incidents lost
the **diagnostic** to a filter; this one lost the **exit code**, because in a
pipeline `$?` is the last command's status and a filter always succeeds. The
output even printed the problem — it was the verdict that got replaced.

So the rule's "read the verdict the tool prints" needs its companion: when the
verdict you are reading is an exit code, the pipeline has already thrown it
away. Run the check unpiped, or capture its status before anything else touches
it:

```sh
node tools/check-docs.mjs > /dev/null 2>&1; echo $?   # the gate's own status
node tools/check-docs.mjs | tail -4; echo $?          # tail's status, always 0
```

Caught the same day by an agent that had read this page that morning, which is
the second time this file records someone adopting the rule and then breaking
it. That is not irony, it is the measurement: the habit is easy to hold in
principle and hard to hold in the next command.

It then happened to a third person, on a different tool, the same day: a live
run of the CLI was measured through `| tail -3` and reported `exit 0` for a
command that exits `77`, which nearly went in as "the trust gate is broken".

Three people, three tools, one shape — **the thing that reports success is not
the thing you ran.**

## The variant that hides best

A filter eating the diagnostic leaves a gap you might notice. `$?` after a
pipeline leaves nothing to notice: it is a number, confidently about the wrong
process. It has now bitten twice, and it is the least visible of the three.

```sh
node tools/check-docs.mjs > /dev/null 2>&1; echo $?   # the gate's own status
node tools/check-docs.mjs | tail -4; echo $?          # tail's status, always 0
```

## An exit code you did not read the cause of is not evidence

The same rule pointed at a tool rather than a filter. Two from one session:

- A mutation reported `exit 1` and was recorded as the test failing. It was
  `vitest is not recognized` — a bad invocation. **A false kill reads exactly
  like a real one.**
- A mutation applied with `sed` inserted a literal newline, broke the file, and
  vitest reported `no tests`. Also `exit 1`, also not the assertion firing.

Both were caught by re-running through the real command and reading *why* it
failed. A mutation that "passes" tells you nothing until you have seen the
assertion in the failure output.

## Related

- [Mutate every test](mutation-check-every-test.md) — its "read the run, not
  the summary line" section is this rule applied to a test suite.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — a filter that cannot surface a failure turns a real check into that.
