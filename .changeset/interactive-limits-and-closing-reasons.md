---
'@namzu/sdk': patch
'@namzu/cli': major
---

Interactive CLI sessions now honor `limits.maxIterations` and `limits.tokenBudget` from user and trusted project configuration. Previously these configured limits were ignored by TUI startup, although headless commands applied them. This also applies when rebuilding a session after a model change or reopening a conversation. To keep interactive cumulative tokens unlimited, omit `limits.tokenBudget` from the effective config and use `--token-budget` for individual headless runs. Omitted defaults remain unchanged; `limits.waitForProviderMs` remains a headless policy.

SDK closing prose requested by a token, cost or time warning now preserves the triggering limit's stop reason instead of reporting `end_turn`. The partial text is still returned, including when allowance remains, but this path skips prose answer review and must not be treated as verified completion. Cancellation and validated native structured-output settlement retain their existing behavior.
