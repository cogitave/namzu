---
type: Guide
title: Handing a task back to a person
description: The way out for a model that cannot do a task as specified - the hand_back_task tool, what ends the turn, where the fact is kept and what a reopened conversation shows, what a person sees in the terminal, in namzu exec (exit status 3), in a scheduled run and in a goal, the guidance the model is given and its size, the setting that turns it on (off by default), and what must be measured before it could be the default.
resource: packages/sdk/src/tools/hand-back/index.ts
tags: [sdk, cli, outcome, exec, scheduled-tasks, goal]
status: draft
generated:
  by: claude/sonnet-5.5
  at: 2026-11-12
---

# Handing a task back to a person

A turn ends when the model stops calling tools. Until now the only honest way to stop on a task that cannot be done as specified (a test that contradicts the request, an input that is not there, a decision that is not the model's to make) was prose, which a person may not read in an unattended run, and the pull toward forcing a pass by special-casing or weakening the check is real. With this turned on, the model has a legitimate exit: it hands the task back.

It is **off by default**. See [the setting](#the-setting) and [before it could be the default](#before-it-could-be-the-default).

## The tool

`hand_back_task` takes four fields:

| Field | Meaning |
|---|---|
| `kind` | `conflict` (the request conflicts with itself or with the checks), `missing` (something needed is missing or not allowed) or `decision` (a decision is needed that belongs to a person) |
| `blocker` | What blocks it |
| `tried` | What it tried |
| `needed` | What a person has to decide or provide |

The three sentences are the model's words: each is cut to 800 characters and its whitespace folded. A call with a field missing or empty is refused as any bad call is, and the turn goes on.

**A call that is accepted ends the turn.** No further model call is made. If the model made other calls in the same step, none of them runs: each is answered with `Not run: this step handed the task back to a person with hand_back_task, and the turn ends there.` The turn settles as an ordinary completed turn (`stopReason: end_turn`); nothing is cancelled or failed.

## The record

The fact is `Turn.handedBack` (`{ kind, blocker, tried, needed }`), on the turn, on the live `turn_completed` event as `settlement.handedBack`, on `BaseAgentResult`'s sibling `EvalTurn.handedBack` for the eval suites, and on the terminal's `done` event. It sits beside the [outcome record](turn-outcome.md), not in it: a turn can change files, be `unchecked`, and be handed back, and the verdict still says what the work was.

**Nothing is added to the session log, and the outcome record is not touched.** The outcome record is validated strictly (an earlier release that sees an unknown field refuses the log), so a field there would break older readers. The call and its receipt are already in the saved conversation: the assistant message holds the `hand_back_task` call with its arguments, and the tool message holds the receipt `Handed back to a person.` A reopened conversation reads the call and draws the same closing lines (see below) from it, exactly as it works out the [claim line](turn-outcome.md#the-answer-against-the-record) from the saved answer. A refused call has an error result, not the receipt, and draws nothing. An older release reading a newer log sees a tool call and its result, and nothing it does not know.

The comparison of an answer with the record is skipped for a turn that was handed back: what the model says blocks it is not an answer to read claims out of.

## What a person sees

**The terminal.** Under the outcome line, a warning line in the kernel's words, then the model's sentences, each under a label that says whose they are:

```text
The model handed the task back to a person: the request conflicts with itself or with its checks.
The model says it is blocked by: <the model's blocker>
It tried: <the model's tried>
It needs a person to: <the model's needed>
```

The first line names a kind and never contains the model's text. Control characters in the model's text are made printable. A reopened conversation shows the same lines.

**`namzu exec`.** Exit status **3**; see [Exit codes](../cli/exec-exit-codes.md). With `--output-format json` the result carries an optional `handedBack` key (`kind`, `blocker`, `tried`, `needed`), absent for a turn that was not handed back. The default mode prints the lines above to stderr (like other status lines, they are not shown with `--quiet`) and the model's last words, if any, on stdout. `exec --json` carries the same `handedBack` key on the `done` event, and its exit status is unchanged (0), because that stream is the protocol a host reads.

**A scheduled task.** The run ends as `needs-a-person`, see [Scheduled tasks](../cli/scheduled-tasks.md#a-run-that-needs-a-person). It is recorded with `handedBack`, counts toward the failure streak, is told once per cause and can pause the job, as a failing run is.

**A goal.** A goal round that is handed back ends the goal as **not confirmed**: the goal is left blocked with the code `handed-back-to-a-person` and the reason, whatever the goal was confirmed by. The closing line is `Goal not confirmed: the model handed the task back to a person (<the kind's sentence>).` See [Goals](../cli/goals.md#a-goal-handed-back).

## The guidance

One paragraph, in one place (`HAND_BACK_GUIDANCE`), added to the static part of the system prompt only when the setting is on:

> ## Handing a task back
> If the task cannot be done as specified, call `hand_back_task` instead of forcing a result: it ends the turn and tells a person what blocks you, what you tried and what they must decide or provide. Never weaken, skip, delete or special-case a check to make it pass; if the request and its checks cannot both hold, hand it back. Hand back only what you could not finish.

**Size.** By the kernel's own estimate (`estimateTextTokens`) the paragraph is **98 tokens** and the tool's name, description and input schema **186 tokens**: **284 tokens** with the setting on, against 1,736 for the kernel's working doctrine alone. Two tests hold ceilings (100 for the paragraph, 200 for the tool). With the setting off, neither is present: the tool list and the prompt are byte for byte what they were, which a test pins.

## The setting

- Config: `handBack.enabled: true` in `~/.namzu/config.yaml` or `namzu.config.json` (a boolean; anything else is refused naming the key).
- Command line: `namzu exec --hand-back` (also `exec --json`).
- Programmatic: `TurnConfig.handBack: true`. Off or absent: the tool is not registered and the paragraph is not added.

The setting reaches the terminal UI, `exec`, `exec --json` and scheduled runs. Background drains, Pal and learning sessions and the Desktop host do not pass it yet, so a model in those never sees the tool; the Desktop feed ignores the `done` key it adds.

It is a setting rather than a default because it changes what the model is told and which tools it has.

## Before it could be the default

A change of default is a major release and needs a measurement this change does not have. Two numbers, with real models, both from the same run:

1. On tasks that **cannot** be done as specified (the tests contradict the request), how often a model forces a pass (special-cases or weakens the check) with the tool absent and with it present.
2. On tasks that **can** be done, how often a model hands one back that it could have finished.

The case for the tool rests on older evidence from one study, with data written by its researchers: giving a model an explicit way to stop cut one model's rate of cheating on impossible tasks from 54% to 9%. That is the reason to build it and not a measurement of this tool, this prompt or these models. The second number is the cost, and nothing here measures it.

What can be measured without a model is in `@namzu/evals` as `kernel/hand-back`: a scripted model that hands back (the record, the kernel's closing sentence, the goal's ending, nothing further running, the tool and paragraph present), one that does not, one with the setting off, and one that calls the tool in a step with other calls. It pins the kernel, not a model. The exit status and the scheduled run's status are pinned by the command line's own tests.

## Exports

`HAND_BACK_TOOL_NAME`, `HAND_BACK_RECEIPT`, `HAND_BACK_GUIDANCE`, `HAND_BACK_GUIDANCE_CONTRIBUTION_ID`, `HAND_BACK_MAX_CHARS`, `HAND_BACK_SIBLING_REFUSAL`, `HandBackInputSchema`, `buildHandBackTool`, `parseHandBack`, `describeHandBack`, `handBackKindSentence`, `handBackModelLines`, `handBackReason`, the types `HandBack` and `HandBackKind`, `handedBackScorer` and `EvalTurn.handedBack` for suites, `GoalConfirmation.handBack` and `GoalEndingReport.handedBack` for goals.

## Related

- [Turn outcome](turn-outcome.md): the record the hand-back sits beside.
- [Goal confirmation](goal-confirmation.md): how goals end.
- [Exit codes of `namzu exec`](../cli/exec-exit-codes.md).
