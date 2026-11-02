---
type: Guide
title: Failure classes
description: The recurring shapes of failure this repository has paid for, each with the question a reviewer asks, where an exception is decided, and the guardrail that holds it.
resource: AGENTS.md
tags: [postmortem, review, testing, ci]
status: draft
---

# Failure classes

A postmortem records one incident. A failure class records the shape it shares
with the next one, so a reviewer can ask the question before the incident
happens again. Each class has a rule, the judged condition a reviewer applies,
who may allow an exception, and the incident behind it. Add a class when a
second incident has the same shape; add a [postmortem](index.md) for every
incident.

## A loop that feeds on its own output

**Rule.** An operation that runs repeatedly, and whose result becomes part of
its next input, is tested by running it repeatedly.

**Judged condition.** Does the output of one pass change the size or shape of
the next pass's input? If so, the test runs at least a dozen passes and asserts
the stored size stays bounded.

**Exception.** None for stored data. A bounded loop with a hard iteration limit
may use a smaller count, with the limit named in the test.

**Incident.** [Compaction re-base copied the whole context](compaction-rebase-reinline.md).
**Guardrail.** `repeated-rebases-do-not-grow-the-log.test.ts`, and a spill
threshold for any single oversized record.

## An outcome decided by machine speed

**Rule.** A test never decides its result by racing real time.

**Judged condition.** Does the test pass or fail depending on whether a real
timer, poll or wall-clock deadline fires first? If so, replace it with fake
timers, or await the real event and let the framework's timeout catch a hang.

**Exception.** A test of real subprocess, socket or file-system work may raise
its own timeout, with a comment saying why. Nothing in it may depend on how
fast the host happens to be.

**Incident.** [Tests that raced real time](tests-racing-real-time.md).
**Guardrail.** The rule in `AGENTS.md`, and local runs under load with the CI
environment variables set.

## A check that reports success for a step it skipped

**Rule.** A gate that did not run is not a gate that passed.

**Judged condition.** Can the job conclude `success` while a gate was skipped,
guarded by a condition, or allowed to fail? If so, the record of success must
not be trusted by anything downstream.

**Exception.** A gate may be exempt only by name, with a reason, in the parity
check.

**Incident.** The reasoning is written into the CI gate description in
`AGENTS.md`: a skipped job is not a failure, so the record of a validated tree
is written only when every gate job succeeded.
**Guardrail.** `.github/scripts/check-workflow-gate-parity.mjs`.
