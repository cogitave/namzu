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

## Related

- [Mutate every test](mutation-check-every-test.md) — its "read the run, not
  the summary line" section is this rule applied to a test suite.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — a filter that cannot surface a failure turns a real check into that.
