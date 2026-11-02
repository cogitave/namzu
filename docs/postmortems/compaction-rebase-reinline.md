---
type: Postmortem
title: Compaction re-base copied the whole context
description: A provider-rejected-image repair made every compaction re-base copy the entire context into the log, growing one session to 53 MB until compaction and resume aborted the process.
resource: packages/sdk/src/manager/session/turn-recorder.ts
tags: [postmortem, compaction, session-log, resume]
status: stable
---

# Compaction re-base copied the whole context

## What happened

A long session became pathologically heavy: auto-compaction and resume used so
much memory and time that the process aborted. The session file had reached
53 MB, and 76% of it was the same context copied dozens of times.

## Mechanism

The turn recorder stores the live context as messages with ids, and a
compaction re-base records only what moved. When the live context differed from
the recorded view by more than an appended tail, the re-base fell back to
copying the whole context into the compaction record's summary, keeping
nothing by id, and then stripped every id. The most common trigger was the
repair that follows a provider rejecting an image: it rebuilds one middle
message as a fresh object.

With every id stripped, the next re-base saw an unordered context again and
copied the now larger context again. The log grew on every pass, and nothing
in the loop could make it stop.

## Why nothing caught it

Each re-base was individually correct: the folded conversation read back
unchanged. The defect was in the growth across re-bases, and no test ran more
than one repair. The 4 MiB cap on a single record bounded each copy but not the
sum, and a summary under the cap was written inline.

## What was changed

- A re-base keeps the longest in-order run of recorded messages by id and
  re-records only the messages that moved, under fresh ids, so the next pass is
  ordered. A test drives twenty middle-message repairs and asserts the log
  stays bounded and ids survive; it fails on the old code with about 160
  duplicated summary messages
  (`packages/sdk/src/manager/session/__tests__/repeated-rebases-do-not-grow-the-log.test.ts`).
- A compaction summary above `compactionSpillAboveBytes` (256 KiB by default,
  never above `spillAboveBytes`) is written beside the log through the spill
  store and read back transparently, so a summary that is large for any other
  reason cannot bloat the file either
  (`packages/sdk/src/store/session-log/__tests__/a-large-compaction-summary-spills.test.ts`).

## The lesson

A repeated operation whose output feeds its own next input needs a test that
repeats it. See [Failure classes](failure-classes.md#a-loop-that-feeds-on-its-own-output).
