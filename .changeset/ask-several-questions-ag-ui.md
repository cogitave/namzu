---
"@namzu/ag-ui": minor
---

A batch of questions from `ask_user_question` is one `input_required` interrupt. Its `message`, `selected`/`text` schema and `metadata.namzu` options still describe the first question, so a client that knows one question shows and answers it; `metadata.namzu.questions` lists every question (with option `preview`s when the model gave them), and a resume payload may carry `answers: [{ questionId, selected?, text? }]`, one per question answered. Each entry is checked against what its own question offered, and a question with no entry is reported to the model as not answered. Clients that send only `selected`/`text` keep working and answer the first question.
