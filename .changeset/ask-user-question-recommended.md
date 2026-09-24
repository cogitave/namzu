---
"@namzu/sdk": minor
"@namzu/cli": patch
---

**`ask_user_question` says which option it recommends in a field, not in the label.** An option takes `recommended: true`, and `UserQuestionOption.recommended` is set on each recommended option of the question your `ResumeHandler` receives; it is absent on the others. The answer's `data.selected[]` carries `recommended: true` on a chosen option the model recommended. The tool no longer tells the model to append " (Recommended)" to a label.

Labels now reach your handler without a recommendation marker. "(Recommended)" was already removed from the answer; it is now also removed from the label you are shown, and so is a marker in another language — "(Önerilen)", "(Empfohlen)", "（推荐）" — on the recommended option, which used to reach both your screen and the answer the model read back. A parenthesised qualifier the options share, or one that is all that tells two options apart, is kept.

What to do: if your question UI showed the recommendation only because the label said "(Recommended)", show it from `option.recommended` instead; nothing else changes. In the CLI the question card draws `[recommended]` next to that option.
