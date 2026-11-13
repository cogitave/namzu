---
'@namzu/cli': minor
---

Hooks now run for `/compact` and the idle compaction, and see the model's last message. A `pre_compact` hook that refuses a `/compact` stops it and you see `A hook refused the summary: <reason>`. A hook can print what the summary should keep (stdout or `additionalContext` on `pre_compact`), which is sent to the summariser after the text you typed. A `matcher` on `pre_compact` and `post_compact` tests `trigger` (`manual` or `auto`), and `turn_end` and `subagent_stop` hooks receive `last_assistant_message`. If a `pre_compact` hook of yours prints to stdout only for its own log, send it to stderr: stdout is now given to the summariser.
