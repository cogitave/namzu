---
"@namzu/sdk": minor
---

`browser_act` `click` and `hover` accept `text`, or `role` with `name`, in place of `ref`; `type` accepts `keys`, `clear` and `append`; `press` without `ref` is described for the short named key set. Two new host error shapes, `browser_no_effect` (nothing changed, one retry after a fresh snapshot is safe) and `browser_target_unclear` (none or several matches, with candidates), are rendered to the model; `BrowserHostError` is wider by those two, so a host or caller that switches over it exhaustively should handle them. `BrowserActOperation` click and hover now carry an optional `ref` beside `text`, `role` and `name`.
