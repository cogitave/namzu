---
'@namzu/sdk': minor
---

`ToolFailureReason` gains four members: `not_read` (an edit or write on a file the conversation never read), `changed_on_disk` (the copy it was based on has since changed), `text_not_found` and `not_unique` (an edit whose text is missing or appears more than once). The `edit` and `write` tools now return them in `facts` on those refusals. A write over an existing file that was never read used to report `already_exists`; it now reports `not_read`. If you `switch` over `ToolFailureReason` exhaustively, add cases for the four new members or a default branch.
