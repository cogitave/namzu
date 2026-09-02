---
"@namzu/cli": minor
---

The model can ask you one question, where you are there to answer.

The interactive session mounts the SDK's `ask_user_question` tool and answers it on screen: the model's two to four options as a chooser, then "Something else…" when it allowed an answer in your own words. Enter picks a row, the free-text row opens a one-line prompt, Esc skips (the model is told the question went unanswered and proceeds on its own judgment), Ctrl+C declines and stops the turn. The choice is recorded in the transcript beside the question. Headless runs do not mount the tool, so the model is never offered a question it would ask into the void. The working doctrine already tells the model to reserve questions for decisions that are genuinely the operator's.

Also fixed: the interactive App now passes the `web` config through to its session; the previous release wired the key at the session but not from the TUI, so `web.fetch: true` reached headless runs only.
