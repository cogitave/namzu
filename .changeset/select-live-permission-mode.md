---
'@namzu/cli': minor
---

Allow an interactive session to inspect and select `prompt`, `auto`, or `strict`
tool-review behavior with `/permissions`. Changing mode at an idle boundary now
revokes an earlier approve-all choice, and a session launched with `--yolo` can
be narrowed back to prompting without rebuilding the session.
