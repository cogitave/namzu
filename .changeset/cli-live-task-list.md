---
"@namzu/cli": minor
---

The model's plan is a live list, and a slow paragraph streams a sentence at a time.

- **Live task list.** `task_create` / `task_update` used to reach the screen as two transcript rows — one when a task opened, one when it closed — and nothing in between. The interactive session now keeps the whole plan in the live region above the composer: every task with its current mark (`☐` pending, `◐` in progress, `☑` done, `☒` failed) and a `done/total` count, updated in place on each change, kept up after the turn ends and cleared when the next request begins. The transcript still records the opening and the close.
- **A paragraph that takes a while is shown a sentence at a time.** Reply text is released a block at a time so it never types itself out; a model's paragraph is one line, so nothing of a long one was shown until its final character. Text held longer than 250 ms is now released to its last safe cut — a sentence end or a line end, never mid-word, never inside a fence or an open inline code span. A fast reply still lands a paragraph at a time.
- **`run-stream` wire (minor):** the `task` event now carries `taskId`, and is emitted on every status change (`pending`, `in_progress`, `completed`, `failed`) rather than only on creation and completion. Existing fields are unchanged; a consumer that keyed on `subject` and ignored intermediate states keeps working, one that counted `task` events as "opened or closed" should now filter on `status`.
