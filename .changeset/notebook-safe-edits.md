---
'@namzu/sdk': patch
---

The built-in `edit` and `write` tools now refuse a change that would leave a `.ipynb` file that no notebook program can open: a body that is not valid JSON, or that lacks `cells`, a numeric `nbformat`, a `metadata` object, or a cell with a valid `cell_type` and `source`. The refusal says what to fix and the file is left unchanged. Other files are unaffected; a caller that wrote a notebook through these tools only sees a difference when the write would have corrupted it.
