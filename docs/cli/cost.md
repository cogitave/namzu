---
type: Reference
title: Spend by day and model
description: What the conversations on this machine cost, by local day, model, project and kind of work, from what the kernel already recorded - the /cost days view, namzu cost and its JSON shape, how prices and gaps are shown, and the summary file it reads through.
resource: packages/cli/src/integrations/spend/report.ts
tags: [cli, cost, usage, sessions]
status: stable
generated: { by: process:claude-code, at: 2026-11-12T00:00:00Z }
---

# Spend by day and model

`/cost` in the terminal shows the latest reply. Two more forms show what the
conversations on this machine cost over a number of days, and where it went:

- `/cost days [n]` in the terminal;
- `namzu cost [--days <n>] [--json]` outside it.

Both print the same report. It covers the last `n` local days (30 by default,
1 to 3660), today included, and reads only what the kernel already wrote to the
session logs. Nothing is collected for it and nothing leaves the machine.

## What it shows

| Section | What it answers |
|---|---|
| Day | Spend on each local day. |
| Model | Spend on each model, with the route the record names beside it. |
| Project | Spend in each folder's conversations. |
| Kind of work | Your replies, sub-agents, compaction, other internal calls. |
| Largest conversations | The ten conversations that cost most in the window, each named by its folder and the last eight characters of its id (the start of an id is its creation time, the same for conversations made in the same minute). The JSON carries the whole id. |

Every row carries the same columns: tokens, fresh input, cache reads, cache
writes, output and the estimated cost. Cache reads and writes are shown apart
from fresh input, so a day that was mostly a warm cache does not read as a day
of large prompts.

**Days are the person's local days.** The zone is the one the machine reports
(`TZ` is honoured). A call is placed on the day it was recorded, so a reply
that ran across midnight is split across both days, and a turn that was paused
on one day and finished on another is split the same way. A day of 23 or 25
hours is one day. The window counts calendar days, not 24-hour spans.

**A model's name and route come from the record.** The model is the one the
turn asked for, changed by a later request or a fallback to another route; the
route is the one that served the turn.

## Honest numbers

- A price is the one the kernel put on the call when it was made, from the
  [model price catalogue](../sdk/model-prices.md). The view never prices a
  token again and never guesses a rate.
- A model with no known price shows its tokens and `price not known` in place of
  money. The total then says it is partial, gives the tokens left out and names
  the models. A total with some priced and some unpriced tokens is shown as
  `at least $X`, never as a plain amount.
- Money is always an estimate from list prices, and the page and the JSON say
  so. It is not a bill.
- A route is shown as `not billed (local)` only when the catalogue says it bills
  nothing per token (a local server). Whether a subscription or a free quota
  paid for a call is not in the record, so the view does not claim it. A
  conversation run through an outside engine is counted and noted: how that
  engine bills is not recorded either.

### Kinds of work, and what the record cannot say

A turn's log holds the turn's running usage after each model call and after
each compaction pass, and the settled total. The view takes the difference
between consecutive figures:

- a difference that ends at a compaction pass is **compaction**;
- a difference that ends at a model reply is a **reply**. An internal call made
  between two replies (a decision, a check) is counted with the next reply,
  because the record does not mark those apart;
- what the turn settled beyond its last figure is **other internal calls**;
- everything a sub-agent's own log holds is **sub-agents**, whatever it was for.

A turn that wrote no running figure at all is known only by its settlement, and
is counted as replies. The notes under the report repeat what applies to the
window.

**Input.** Drivers disagree on whether the prompt count already holds the cache
reads. The view separates fresh input using the route's rate card, and where no
card names the route and something was read from the cache it cannot, so that
input is shown with a star as "includes input the record does not separate from
cache reads" (`unsplitInputTokens` in JSON).

### Continued and forked conversations

A turn's running figure starts from zero, whichever turn it is. The second turn
in the same process, the first turn after a conversation was continued in
another process (`--continue`, `/resume`, `session/load`) and the first turn of
a fork each open their own recorder, so their figures hold that turn's calls and
nothing from the turns before it. Only a turn resumed after a pause restores
figures (`turn_resuming`, the same turn id and no new `turn_started`), and those
are the paused turn's own earlier figures. The view therefore measures every
turn from zero and never compares a turn with an earlier one: the total of a
conversation is the sum of what its turns settled, whatever their sizes and in
whatever order, and a turn that uses more than all before it is counted in full.

## Reconciliation

A conversation's cost is the sum of what its turns settled (an open turn counts
up to its last recorded figure). The report's total is the sum of that figure
for the conversations in the window, and every cut (days, models, projects,
kinds) adds up to the same total. A test asserts it on fixtures that include a
conversation that crosses midnight, one that used two models, one with
sub-agents, one that was compacted and one that was resumed on another day.

## `namzu cost`

```text
namzu cost [--days <n>] [--json]
```

| Option | Effect |
|---|---|
| `--days <n>` | Days to cover, today included. Default 30, at most 3660. |
| `--json` | Print the report as JSON. Without it, text; with the global `--format json` or `yaml`, the same object in that format. |

An argument it does not take prints the usage and exits 64. It reads the
conversations of every folder under `NAMZU_HOME`, not only the current one.

### JSON shape

`schemaVersion` is 1. A field is added, never renamed or removed, within a
version; a reader checks `schemaVersion` first.

```json
{
  "schemaVersion": 1,
  "kind": "spend",
  "estimate": true,
  "currency": "USD",
  "window": { "days": 30, "from": "2026-10-14", "to": "2026-11-12", "timeZone": "Europe/Istanbul" },
  "totals": {
    "tokens": 0, "freshInputTokens": 0, "unsplitInputTokens": 0,
    "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0,
    "estimatedCostUsd": 0, "unpricedTokens": 0,
    "partial": false, "unpricedModels": [], "conversations": 0
  },
  "days": [ { "date": "2026-11-12", "tokens": 0, "models": [ { "provider": "anthropic", "model": "claude-opus-5-5", "billing": "per-token", "priceKnown": true, "tokens": 0 } ] } ],
  "models": [],
  "projects": [ { "slug": "-work-project", "path": "/work/project", "tokens": 0 } ],
  "kinds": [ { "kind": "replies", "tokens": 0 } ],
  "topConversations": [ { "id": "00000000-0000-0000-0000-000000000000", "slug": "-work-project", "subagent": null, "tokens": 0 } ],
  "notes": []
}
```

Every row in `days`, `models`, `projects`, `kinds` and `topConversations` also
has the other figures of `totals` (`freshInputTokens`, `unsplitInputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `estimatedCostUsd`,
`unpricedTokens`). `estimatedCostUsd` counts only tokens with a known price, so
a row with `unpricedTokens > 0` is a floor and a row whose money is `0` with
`unpricedTokens > 0` is unknown, not free. `provider` is `null` when the record
does not name the route. `kind` is `replies`, `subagents`, `compaction` or
`internal`. `billing` is `local` or `per-token`. Days and models are ordered
(days by date, models by estimated cost then tokens).

## How it stays fast

It does not read every log in full each time. `spend-ledger.json`, in the
Namzu home beside the session index, keeps for each log the figures its settled
turns folded into, the byte offset the next read resumes from, and the size and
modification time the log had. A report lists the logs, checks each one's size
and time, and reads only what a changed log appended since its offset (an open
turn is read again from its start; a log that got shorter is read from the
beginning). A log is read in pieces of 1 MiB and folded as it streams, so the
memory the report needs does not grow with the largest log. The file is written
only when something changed, through a temporary file and a rename.

The file is derived and safe to delete. A missing, unreadable, other-version or
malformed file is rebuilt from the logs, which stay the source of truth, and an older
command line ignores it. Its stamp is `SPEND_LEDGER_VERSION`
([kernel facts](../sdk/kernel-facts.md)). It holds slots of 15 minutes of UTC
time, not days, so changing the zone never needs a rebuild.

A log timestamped after today by this machine's clock is counted, and a note
says so; the window's `to` stays today.

Measured on fixture logs (about 13 KB each, three turns of four calls), on the
development machine: 1,000 conversations take 195 ms to read for the first time
and 33 ms when nothing changed; 10,000 conversations (131 MB of logs) take
1.6 s the first time and 0.31 s when nothing changed, which is the time to
list and check the files; one grown log adds one small read. The ledger file is
0.28 MB and 2.8 MB.
