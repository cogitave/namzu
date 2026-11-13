---
'@namzu/sdk': major
---

Breaking default: what an attached shell hook prints to stdout on `pre_compact` (exit 0, not JSON) used to be ignored and is now given to the summariser. To keep the old behaviour, print it to stderr.

Hooks now see every compaction and the model's last message, and a `pre_compact` hook can say what the summary keeps.

- `pre_compact` and `post_compact` fire for a pass a person asked for (`compactNow`, `compactRegion`, `compactSession`, `compactSessionRange` with the new `hooks` option, `{ manager }`) and for the idle pass, not only for the kernel's own. The context's `compaction` gains `trigger` (`manual` or `auto`; idle is `auto`), `instructions` on `pre_compact` (what the person typed, or `null`) and `summary` on `post_compact` (8000 characters at most). A shell hook's `matcher` on these events tests `trigger`; its stdin gains `trigger`, `custom_instructions` and `compact_summary`.
- A `pre_compact` refusal now also refuses a pass a person asked for: those functions throw the new `CompactionRefusedError` (with `reason`); an idle pass is cancelled and returns `null`. A pass the provider forced still cannot be refused.
- What a `pre_compact` hook prints with exit 0, its `additionalContext`, or an in-process `annotate` (now accepted on this event) or `continue` with `context` is given to the summariser after the person's instructions, framed as a hook's, 8000 characters at most. The summary model step runs for it even with `llmVerification` off. A hook that prints to stdout on `pre_compact` for its own log now has that text sent to the summariser: print to stderr instead.
- `turn_end` and `subagent_stop` carry `lastAssistantMessage` (`last_assistant_message` in the shell payload), 8000 characters at most, absent when the turn produced no text.

`PluginCompactionInfo.reason` gains the value `manual` (used by passes a host asks for outside a turn); a consumer that switches exhaustively on `reason` should handle it, or test `trigger` instead. Nothing is removed or renamed.
