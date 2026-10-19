---
type: Reference
title: Asking the user a question
description: The ask_user_question tool — its input (one to four related questions per call), the recommended flag and preview on an option, how a recommendation marker the model writes into a label is taken out in any language, what the host is handed, the per-question answers a host returns, and the answer the model reads back.
resource: packages/sdk/src/tools/coordinator/ask-user-question.ts
tags: [sdk, tools, hitl, questions]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Asking the user a question

`ask_user_question` turns a turn around to face the person: the model asks one question, or up to four related ones, each with two to four options, the turn parks through the host's `ResumeHandler`, and the answer comes back as the tool's result. `buildAskUserQuestionTool({ resumeHandler })` builds it on its own; `buildCoordinatorTools` includes it when it is given a `resumeHandler` and a turn.

## What the model sends

```ts sketch
{
  questions: [                        // 1-4; question texts and headers unique in one call
    {
      question: 'Who is the audience?',
      header: 'Audience',             // optional, at most 24 characters
      options: [                      // 2-4
        { label: 'Board', description: 'Executive framing', recommended: true },
        { label: 'Engineering team', description: 'Details and diagrams', preview: 'Slides with diagrams' },
      ],
      multiSelect: false,             // default false
      allowFreeText: true,            // default true
    },
    // …up to three more related questions
  ],
}
```

The schema offered to the model is closed: `questions` and nothing else; an option carries `label`, optional `description`, optional `recommended` and optional `preview`, and nothing else. A question carries `question`, `header`, `options`, `multiSelect` and `allowFreeText`.

**One call, several questions.** Put several entries in one call only when they are related decisions that all block the next step and the person can answer them together (which account, for what purpose, which environment before a credentialed step). The person sees them in one card, answers them in any order, reviews and submits once; the model gets one answer per question. A call with no questions or more than four, two questions with the same text, and two with the same header are refused with the shape to retry with.

**The older input still works.** A call with `question`, `options`, … at the top level, the shape this tool took before batches, is read as a batch of one, so existing callers, scripts and models keep working. It is not offered to the model any more. Mixing both shapes in one call is refused.

`preview` is plain text or markdown a host may show beside the option list while that option is focused (a snippet, a mock-up). It never has to be shown, and answering never needs it.

`recommended: true` marks the option the model recommends. The tool's description tells the model to put that option first, to set the flag, and never to write "(Recommended)" or a translation of it into a label, nor end a label with a parenthesised note (qualifiers go in the description). A multi-select question may flag more than one option.

## Markers a model still writes

A model used to be told to append " (Recommended)" to the label, and one answering in the user's language wrote "(Önerilen)" or "(Empfohlen)" instead. The tool takes such a marker out of the label before the host sees it, and the host learns which options are recommended from each option's `recommended` field, never from its label:

- "(Recommended)" at the end of any option's label, in any letter case, is a marker, and it is removed from every option that carries it. Where the model left the flag out, it makes the option recommended; where the model set `recommended: false`, the option stays unrecommended: the flag is the model's word, and the English marker counts only where the flag is absent. An option is therefore recommended when the model set `recommended: true` on it, or left the flag out and ended its label in "(Recommended)". The model was told to append that marker to the option's name, so what is left before it is the name, and a group there is a qualifier: "Cloud (AWS) (Recommended)" arrives, and is answered, as "Cloud (AWS)", and "Kurul (Önerilen) (Recommended)" as "Kurul (Önerilen)".
- On a recommended option, a trailing parenthesised group of one to three words of letters, in ASCII `( )` or full-width `（ ）` parentheses, is taken for the marker a model writes next to the flag out of habit, when every option whose label ends in a parenthesised group is recommended, did not end in "(Recommended)", and ends in that same group. Two groups, or two labels, are the same when they differ only in letter case, in runs of spaces, or in Unicode normalisation; the comparison lowercases with Unicode's default mapping, the same on every host whatever its locale, and counts "İ", "I", "ı" and "i" as one letter and "ß" as "ss", so "(ÖNERİLEN)" and "(Önerilen)" are one marker on a Turkish host and on any other. It only decides what is the same; no label is rewritten by it. A model that writes a marker writes the same word on each option it recommends, so a group that differs between options is what tells them apart and stays: "Postgres (managed)" / "Postgres (self-hosted)" keep their groups whether one of them is flagged or both, and so do a multi-select's flagged "Tests (unit)" / "Tests (e2e)". A group left from "(Recommended)" is a qualifier too, so every group in its question stays: a flagged "Lint (Empfohlen)" next to "Tests (unit) (Recommended)" keeps its group. A marker also stays on an option whose label would otherwise be another option's: "Postgres (managed)" next to "Postgres" keeps its group, and a flagged "Redis (Empfohlen)" next to "Redis" keeps its marker while a flagged "Postgres (Empfohlen)" in the same question loses it. Every label is judged as written before any is changed, so the order of the options changes nothing. A group with digits or symbols (`(v2)`, `(~5 min)`) is never a marker. The tool tells the model to put qualifiers in the description, so a flagged "Use cache (Redis)" arrives as "Use cache".
- Nothing else is taken out of a label, and nothing else makes an option recommended. An option that is not recommended, first or not, arrives exactly as written apart from surrounding spaces and a trailing "(Recommended)" (which comes off even next to `recommended: false`), and its trailing group is never read as a recommendation. Recommending is optional, so "Cloud (AWS)" or "Tabs (current)" on an unflagged first option is a qualifier, and `recommended: false` is never overridden. A localised marker written without the flag stays in the label: the tool cannot tell it from a qualifier.

## What the host is handed

The park request is `{ type: 'user_question', question: UserQuestionData }`. Each `UserQuestionOption` has a positional `id` (`opt_1`, `opt_2`, …), the `label` trimmed of surrounding spaces and without a marker, the `description`, an optional `preview`, and `recommended: true` on each recommended option; the field is absent on the others. A host shows the recommendation from the flag (a badge, an emphasis) and never has to parse a label for it. The CLI's question card draws `[recommended]` in the option's marker column; see [Terminal design](../cli/terminal-design.md).

For a batch, `question.questions` lists every question as a `UserQuestionItem` (`id`, `question`, `header?`, `options`, `multiSelect`, `allowFreeText`). The item id is the asking `tool_use_id`, `#`, and the question's position (`toolu_1#0`, `toolu_1#1`, …), so an answer names its question whatever order a host shows them in. `question.questionId` stays the `tool_use_id`, and the top-level `question`, `header`, `options`, `multiSelect` and `allowFreeText` mirror the first item. A host that does not know `questions` therefore shows and answers the first question, and the rest read as not answered. A single question leaves `questions` out.

A host answers with `{ action: 'answer_question', questionId, selectedOptionIds, freeText?, answers? }`. For a batch, `answers` carries one `{ questionId, selectedOptionIds, freeText? }` per question the person answered (`selectedOptionIds` and `freeText` at the top level are then ignored; send `[]`). A question with no entry, or an entry that selects nothing and says nothing, was not answered; an entry naming a question that is not in this call, or a second entry for the same one, is dropped. A decision without `answers` answers the first question. Cancelling is not a partial answer: `abort` declines the whole batch and ends the turn, and any other decision that is not an answer leaves every question unanswered.

A resumed run carries a partly answered batch the same way: the decision (with its `answers`) is delivered to the re-entered tool by `PendingAnswers`, keyed by the `tool_use_id`, and nothing is asked again.

The `user_question_asked` session event and its SSE (`question.asked`) and A2A mappings carry the question text and ids only, not the options.

## What the model reads back

The answer quotes the labels the person saw, so a marker never reaches it. A single question reads as it always has:

```text
User answered "Who is the audience?": "Board"
```

A batch reads one line per question, keyed by its header (or its text when it has none), with the questions the person left alone said to be unanswered rather than guessed:

```text
The user answered 3 of 3 questions:
Audience: "Board"
Environment: "Staging", "Production"
Purpose (own words): "monthly cost report"
```

`data.selected` lists `{ id, label }` for each chosen option, with `recommended: true` on an option the model recommended, so a host or an eval can tell that the person took the recommendation without the text saying so. For a batch, `data.answers[]` has one `{ questionId, header?, question, selected[], freeText?, answered }` per question, in the order asked. Free text arrives as `data.freeText` and in the output as `Additional note from the user: "…"` (`(note: "…")` in a batch), or `in their own words: "…"` when no option was chosen. A single-select question keeps one selection even if a host sends more. An empty answer (no question answered), an answer for another question and a decision that is not `answer_question` all read as "The user did not answer this question" (or "these questions"), never as consent; `abort` ends the turn as declined.
