---
'@namzu/cli': patch
---

`/jobs` is now the `Background` panel: a row per background shell (status icon, command, `running` / `done` / `error` / `stopped`), `Shell details` with `Status:`, `Runtime:`, `Command:` and live `Output:`, and no job ids on screen. When a background command ends the transcript gets a row such as `● Background command "npm test" completed (exit code 0) · 12s`, or `failed with exit code 2` / `was stopped`.
