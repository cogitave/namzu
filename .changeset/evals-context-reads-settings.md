---
'@namzu/evals': minor
---

`kernel/context` reads `limits.maxIterations` and `limits.maxResponseTokens` from the settings `namzu eval --settings` gives a run, so a comparison of those two settings has a suite that responds to them; without a settings file it runs as before. On a kernel older than the one that added `evalSetting`, the defaults stand. The other suites do not read settings yet and their reports say so.
