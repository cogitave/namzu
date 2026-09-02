---
title: Never filter a verification down to something that can read green
description: Piping a check through a line filter can discard the diagnostic while keeping a summary line, so the check runs, its answer is invisible, and what you see reads as success.
type: Convention
status: stable
tags: [convention, verification, tooling]
generated: { by: human:bahadirarda, at: 2026-08-04T00:00:00Z }
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

## And again, five days later, to someone who had read it

Running the gate by hand, `node tools/check-docs-okf.mjs | Select-Object -First 1`
printed `EXIT: -1` for a gate that had passed: the truncating pipe closed the
stream and killed the process, so the exit code described the pipe rather than
the check. It happened while writing up a report about not having run all the
gates, in the session that ratified this rule.

That is the instance worth keeping, because it says what the first four cannot.
The failure is not ignorance of the rule — the author had read it, written about
it, and cited it the same day. **The failure is the reflex to trim output**,
which fires while attention is on the thing being checked rather than on the
checking. Knowing the rule does not disarm the reflex; only refusing to put a
filter between yourself and a verdict does.

Note also which direction it failed in. A filter that manufactures a green is
the danger this rule was written for; this one manufactured a red, and a red
gets investigated. The same reflex produces both, and only one of them announces
itself.

## It recurred, in a shape the rule did not spell out

2026-08-07. An agent ran `node tools/check-docs-okf.mjs 2>&1 | tail -4; echo $?`
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
node tools/check-docs-okf.mjs > /dev/null 2>&1; echo $?   # the gate's own status
node tools/check-docs-okf.mjs | tail -4; echo $?          # tail's status, always 0
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
node tools/check-docs-okf.mjs > /dev/null 2>&1; echo $?   # the gate's own status
node tools/check-docs-okf.mjs | tail -4; echo $?          # tail's status, always 0
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

## The door where nothing is read at all

Every incident above has someone reading the wrong thing. This one has nobody
reading anything, and it did the most damage.

A one-line correction to a changeset was applied by a script that read the file
from the API, edited the text, and wrote it back. The read expression contained a
parse error. The error printed. **The script kept going**, built the new content
out of nothing, and the write succeeded — truncating another agent's changeset to
a single paragraph and taking its frontmatter, and with it every version
declaration in the pull request, out of the file. The write reported success
because it did exactly what it was told.

The shell in use does not stop on an error by default. So a step that failed and
a step that succeeded look identical to the step after them, and a script is a
gate only if something in it refuses to continue. Nothing here refused.

This is the rule's limit case. The others say *read the verdict*; this one says
**there has to be a verdict at all**. A sequence of commands where failure does
not stop the sequence is not a check that was misread — it is a check that was
never taken.

Three things follow, and the third is the one that saved it:

1. **Make failure stop the sequence**, explicitly, in any shell that does not do
   it for you. One step per command is better than a clever one-liner precisely
   because the boundary between steps is where the stopping happens.
2. **Never write a file from data you have not seen.** Build the new content,
   look at it, then write. Here the intended content had a frontmatter block; one
   glance would have ended it.
3. **Verify against the store you wrote to.** The file was read back from the
   remote and compared byte-for-byte against what was intended, which is how the
   damage was found within a minute rather than at the next release. Reading back
   what you just wrote is cheap and it is the only check that cannot be satisfied
   by the write's own report.

Recorded because the blast radius was somebody else's work, on a branch that was
already green.

## Why this page has no `resource:`

It pointed at the CI workflow, and the workflow is not what this rule is about.
A change there cannot make the rule false: the rule is about the habit of
putting something between yourself and a verdict, and it would be exactly as
true if this repository had no CI at all.

What the pointer actually did was demand a re-read of the rule every time an
unrelated line of the workflow moved — which is the dynamic the gate's own
guidance warns about, a churning sentinel that trains everyone to wave the
failure through. It fired on a change to which matrix leg carries the gates,
and there was nothing to re-establish.

So the key is gone rather than re-dated. `resource:` should name code whose
change could make the document **wrong**, not code the document happens to be
about; and an absent key honestly reads as "no code can invalidate this",
which is the true statement here. Same reasoning as
[alternation-unmounts-state](alternation-unmounts-state.md), which reached it
first.

## Related

- [Mutate every test](mutation-check-every-test.md) — its "read the run, not
  the summary line" section is this rule applied to a test suite.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — a filter that cannot surface a failure turns a real check into that.
