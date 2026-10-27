---
'@namzu/cli': patch
---

The task-list nudge is a hidden note for the model and now speaks only while the current request has run three or more tool steps, so a long conversation of short requests is no longer nudged; its text tells the model to keep it out of its replies. Exports (`/export`) and the history a host reads (`messages`) leave out hidden reminders and recorded turn context, as the live transcript already did, so they never read as something you wrote. While a plan step is in progress, the working row names it in the words the model gave (`Running the tests`), or the step's subject, instead of `Working`. The conversation-evidence guidance tells the model to search the conversation for an error before investigating it again, and the fields of recalled evidence, recalled memory lines and the saved-agents list are each explained once in plain words. Nothing to change on your side.
