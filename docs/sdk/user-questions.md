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

A model used to be told to append " (Recommended)" to the label, and one answering in the user's language wrote "(Önerilen)" or "(Empfohlen)" instead. The tool takes such a marker out of the label before the host sees it, and the host learns which options are recommended from each option's `recommended` field, never from its label:

- "(Recommended)" at the end of any option's label, in any letter case, is a marker, and it is removed from every option that carries it. Where the model left the flag out, it makes the option recommended; where the model set `recommended: false`, the option stays unrecommended: the flag is the model's word, and the English marker counts only where the flag is absent. An option is therefore recommended when the model set `recommended: true` on it, or left the flag out and ended its label in "(Recommended)". The model was told to append that marker to the option's name, so what is left before it is the name, and a group there is a qualifier: "Cloud (AWS) (Recommended)" arrives, and is answered, as "Cloud (AWS)", and "Kurul (Önerilen) (Recommended)" as "Kurul (Önerilen)".
- On a recommended option, a trailing parenthesised group of one to three words of letters, in ASCII `( )` or full-width `（ ）` parentheses, is taken for the marker a model writes next to the flag out of habit, when every option whose label ends in a parenthesised group is recommended, did not end in "(Recommended)", and ends in that same group. Two groups, or two labels, are the same when they differ only in letter case, in runs of spaces, or in Unicode normalisation; the comparison lowercases with Unicode's default mapping, the same on every host whatever its locale, and counts "İ", "I", "ı" and "i" as one letter and "ß" as "ss", so "(ÖNERİLEN)" and "(Önerilen)" are one marker on a Turkish host and on any other. It only decides what is the same; no label is rewritten by it. A model that writes a marker writes the same word on each option it recommends, so a group that differs between options is what tells them apart and stays: "Postgres (managed)" / "Postgres (self-hosted)" keep their groups whether one of them is flagged or both, and so do a multi-select's flagged "Tests (unit)" / "Tests (e2e)". A group left from "(Recommended)" is a qualifier too, so every group in its question stays: a flagged "Lint (Empfohlen)" next to "Tests (unit) (Recommended)" keeps its group. A marker also stays on an option whose label would otherwise be another option's: "Postgres (managed)" next to "Postgres" keeps its group, and a flagged "Redis (Empfohlen)" next to "Redis" keeps its marker while a flagged "Postgres (Empfohlen)" in the same question loses it. Every label is judged as written before any is changed, so the order of the options changes nothing. A group with digits or symbols (`(v2)`, `(~5 min)`) is never a marker. The tool tells the model to put qualifiers in the description, so a flagged "Use cache (Redis)" arrives as "Use cache".
- Nothing else is taken out of a label, and nothing else makes an option recommended. An option that is not recommended, first or not, arrives exactly as written apart from surrounding spaces and a trailing "(Recommended)" (which comes off even next to `recommended: false`), and its trailing group is never read as a recommendation. Recommending is optional, so "Cloud (AWS)" or "Tabs (current)" on an unflagged first option is a qualifier, and `recommended: false` is never overridden. A localised marker written without the flag stays in the label: the tool cannot tell it from a qualifier.

## What the host is handed

The park request is `{ type: 'user_question', question: UserQuestionData }`. Each `UserQuestionOption` has a positional `id` (`opt_1`, `opt_2`, …), the `label` trimmed of surrounding spaces and without a marker, the `description`, and `recommended: true` on each recommended option; the field is absent on the others. A host shows the recommendation from the flag (a badge, an emphasis) and never has to parse a label for it. The CLI's question card draws `[recommended]` in the option's marker column; see [Terminal design](../cli/terminal-design.md).

The `user_question_asked` session event and its SSE (`question.asked`) and A2A mappings carry the question text and ids only, not the options.

## What the model reads back

The answer quotes the labels the person saw, so a marker never reaches it:

```text
User answered "Who is the audience?": "Board"
```

`data.selected` lists `{ id, label }` for each chosen option, with `recommended: true` on an option the model recommended, so a host or an eval can tell that the person took the recommendation without the text saying so. Free text arrives as `data.freeText` and in the output as `Additional note from the user: "…"`, or `in their own words: "…"` when no option was chosen. An empty answer, an answer for another question and a decision that is not `answer_question` all read as "The user did not answer this question", never as consent; `abort` ends the turn as declined.
