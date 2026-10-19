---
"@namzu/sdk": minor
---

`ask_user_question` can ask up to four related questions in one call and returns one answer per question. The model-facing input is now `{ questions: [...] }`; the older single-question input (`question`, `options`, … at the top level) is still accepted as a batch of one, so nothing that sends it needs to change. A host that does not know about batches keeps working: `UserQuestionData` gains an optional `questions` list whose first entry its existing fields mirror, so it shows and answers the first question and the rest read as not answered. A host that does know sends `answer_question.answers` with one `{ questionId, selectedOptionIds, freeText? }` per question it has an answer for (a missing entry means not answered); the question ids are `<tool_use_id>#<index>`. An option can carry an optional `preview` for a host to show beside the list. Question texts and headers must be unique within one call.
