---
'@namzu/cli': minor
---

A `hooks` block written in the common hook contract's shape can be pasted into a config file and is read as written. Nothing is removed or renamed; the shape you have keeps working.

What you can now do:

- Write `hooks` as PascalCase event, then a list of groups, each with an optional `matcher` and a list `hooks` of `{ type, command, timeout, ... }` (`command`, `http`, `prompt`; `timeout` in seconds). It is read beside the shape you already use, in the same file and the same key, both spellings of an event may be mixed, and identical entries still run once.
- Rely on the tool name a moved script expects: an entry read from that shape is sent `Bash`, `Edit`, `WebFetch` as `tool_name` (and in `NAMZU_TOOL_NAME`). An entry in the existing shape keeps receiving `bash`, and may ask for the written names with `toolNames: written`. `/hooks` shows which each entry receives.
- See what could not be loaded: an event name with no counterpart here, a hook kind we do not have (`agent`, `mcp_tool`), an unreadable hook and every key not acted on are reported at launch, in `/hooks` and in `namzu doctor`, naming the file and the event. A hook that would have guarded something (a tool event, a prompt, a compaction, a turn's end) and cannot be loaded makes the `runtime.hooks` row warn. One unreadable hook, a bare string or number in an event's list included, never stops the others from loading, and a setting that cannot be read (a `timeout`, an `if`) is left off so the hook runs, never the reverse.
- The terminal's trust prompt and the Desktop app's trust dialog read the common shape too, so a hook written in it is named before the folder is trusted.

What to know: `/hooks` now adds a `tool names` note to every command and http hook on a tool event, and reports a matcher written as `Tool(pattern)` (an `if`, which fires for nothing as a matcher).
