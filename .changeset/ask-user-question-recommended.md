---
"@namzu/sdk": minor
"@namzu/cli": patch
---

**`ask_user_question` says which option it recommends in a field, not in the label.** An option takes `recommended: true`, and `UserQuestionOption.recommended` is set on each recommended option of the question your `ResumeHandler` receives; it is absent on the others. The answer's `data.selected[]` carries `recommended: true` on a chosen option the model recommended. The tool no longer tells the model to append " (Recommended)" to a label.

Labels now reach your handler without a recommendation marker. "(Recommended)" at the end of a label was already removed from the answer; it is now also removed from the label you are shown, and it sets `recommended: true` on that option unless the model set `recommended: false`. On an option the model flagged `recommended: true`, a trailing parenthesised group of one to three words — "(Önerilen)", "(Empfohlen)", "（推荐）", which used to reach both your screen and the answer the model read back — is taken for the marker and removed from the label you are shown and from the answer. That includes a qualifier the model put there against the tool's instructions: a flagged "Use cache (Redis)" arrives as "Use cache". A group the options share, one that is all that tells two options apart, and one with digits or symbols are kept. An option the model did not flag reaches you, and the answer, exactly as written, and is never marked recommended because of its label.

What to do: if your question UI showed the recommendation only because the label said "(Recommended)", show it from `option.recommended` instead; nothing else changes. In the CLI the question card draws `[recommended]` next to that option.
