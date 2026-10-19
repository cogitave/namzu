---
"@namzu/cli": minor
---

When the model asks several questions in one call, the terminal shows them as one card instead of one card after another: a tab for each question with a mark on the answered ones, a review tab that submits them together, multiple choice with Space, `Something else…` typed in place, and an option's preview beside the list. Esc or Cancel skips the whole call and the model is told nothing was answered; a question you leave alone is reported to it as not answered. A lone single-choice question looks and works as before, and a multiple-choice question now gets the card too (it was shown as a single choice). A Pal's answer to a batch of questions is checked question by question.
