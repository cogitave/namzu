---
"@namzu/sdk": minor
---

Six more hook events, so an extension or a shell hook can act on what other coding agents' operators script against: `user_prompt_submit` (the prompt before the model sees it, on `PluginHookContext.prompt`; the one lifecycle event that can block a run with `skip`, and the one that can add to what the model is told with the new `annotate` result), `pre_compact` / `post_compact` (the pass's reason, tokens before and after, and the window on `compaction`), `subagent_stop` (fired after a delegated run's `run_end`, with `parentRunId`), and `session_start` / `session_end` (a host's to fire, with `sessionId`). Shell hooks attach to all of them: exit 2 on the prompt event blocks it, stdout on exit 0 is context for the model, and the stdin JSON carries `prompt`, `session_id`, `parent_run_id` and `compaction`. `applyLifecycleHookResults` now returns the annotations; a JavaScript hook returning `annotate` on any other event is rejected.
