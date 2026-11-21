---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Plan mode in the terminal no longer costs the model extra requests. `exit_plan_mode` is loaded from the first request instead of being found through a search, `sed -n '1,40p' file` and other print-only `sed -n` commands count as read-only and run in plan mode, and when a call is refused the model is told to write the plan file and call `exit_plan_mode` rather than to present the plan as its reply (the SDK exports `PLAN_MODE_REFUSAL_WITH_PLAN_FILE`). The plan approval box now shows the plan as formatted text (headings, tables, code, bold) instead of markdown source, with its pager counted in rows as drawn, and offers "Yes, and use auto mode" first when the session can enter auto mode.
