---
"@namzu/cli": patch
---

The model pickers (TUI and Desktop catalogue) list Zen's free models before the ones that need an API key and show them under separate "Free" and "API key" headings (a model with no published price follows under "Other models"; a list with only one group draws no headings and keeps an "(API key)" note on its key models), and mark a model whose limits the catalogue has not published yet with "Limits not published yet". Nothing to change on your side; only the order and headings of the Zen list and one extra note differ. The Desktop catalogue row gains an optional `group` field (`'free'` or `'key'`, Zen only). A client that ignores `group` draws no headings and loses the "(API key)" marker on a list that has both groups, because the per-row note is dropped once the headings carry it.
