---
type: Reference
title: Asking the user a question
description: The ask_user_question tool — its input, the recommended flag on an option, how a recommendation marker the model writes into a label is taken out in any language, what the host is handed, and the answer the model reads back.
resource: packages/sdk/src/tools/coordinator/ask-user-question.ts
tags: [sdk, tools, hitl, questions]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Asking the user a question

`ask_user_question` turns a turn around to face the person: the model asks one question with two to four options, the turn parks through the host's `ResumeHandler`, and the answer comes back as the tool's result. `buildAskUserQuestionTool({ resumeHandler })` builds it on its own; `buildCoordinatorTools` includes it when it is given a `resumeHandler` and a turn.

## What the model sends

```ts sketch
{
  question: 'Who is the audience?',
  header: 'Audience',                 // optional, at most 24 characters
  options: [                          // 2-4
    { label: 'Board', description: 'Executive framing', recommended: true },
    { label: 'Engineering team', description: 'Details and diagrams' },
  ],
  multiSelect: false,                 // default false
  allowFreeText: true,                // default true
}
```

The schema is closed: an option carries `label`, optional `description` and optional `recommended`, and nothing else.

`recommended: true` marks the option the model recommends. The tool's description tells the model to put that option first, to set the flag, and never to write "(Recommended)" or a translation of it into a label, nor end a label with a parenthesised note (qualifiers go in the description). A multi-select question may flag more than one option.

## Markers a model still writes

A model used to be told to append " (Recommended)" to the label, and one answering in the user's language wrote "(Önerilen)" or "(Empfohlen)" instead. The tool takes such a marker out of the label before the host sees it and records the recommendation as the flag:

- "(Recommended)" at the end of any option's label, in any letter case, is a marker, and marks that option recommended.
- A trailing parenthesised group of one to three words of letters, in ASCII `( )` or full-width `（ ）` parentheses, is a marker on the recommended option: the one the model flagged or, when it flagged none, the first. It is removed only when no other option's label ends in a parenthesised group and the label left over is not another option's. "Postgres (managed)" / "Postgres (self-hosted)" keep their groups, as does "Postgres (managed)" next to "Postgres". A group with digits or symbols (`(v2)`, `(~5 min)`) is never a marker.
- A marker found on an unflagged first option makes that option recommended, which is what the old instruction meant by it. A group on any later unflagged option is left alone.

## What the host is handed

The park request is `{ type: 'user_question', question: UserQuestionData }`. Each `UserQuestionOption` has a positional `id` (`opt_1`, `opt_2`, …), the `label` without a marker, the `description`, and `recommended: true` on each recommended option; the field is absent on the others. A host shows the recommendation from the flag (a badge, an emphasis) and never has to parse a label for it. The CLI's question card draws `[recommended]` in the option's marker column; see [Terminal design](../cli/terminal-design.md).

The `user_question_asked` session event and its SSE (`question.asked`) and A2A mappings carry the question text and ids only, not the options.

## What the model reads back

The answer quotes the labels the person saw, so a marker never reaches it:

```text
User answered "Who is the audience?": "Board"
```

`data.selected` lists `{ id, label }` for each chosen option, with `recommended: true` on an option the model recommended, so a host or an eval can tell that the person took the recommendation without the text saying so. Free text arrives as `data.freeText` and in the output as `Additional note from the user: "…"`, or `in their own words: "…"` when no option was chosen. An empty answer, an answer for another question and a decision that is not `answer_question` all read as "The user did not answer this question", never as consent; `abort` ends the turn as declined.
