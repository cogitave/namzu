---
"@namzu/cli": minor
"@namzu/sdk": patch
---

When Namzu's own learning activates a revision of a folder's guidance, the terminal now shows one dim row saying what was learned and how to take it back (`namzu learn --undo`); a rejected or inconclusive cycle shows nothing. Nothing to change on upgrade; `learningGenerator: false` still turns learning off. The `save_memory` tool description now tells the model to save a durable lesson on its own, without waiting to be asked, which may make a model save memories more often than before.
