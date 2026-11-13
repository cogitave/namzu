---
'@namzu/sdk': major
---

Breaking: `PluginSessionSource` and `PluginSessionEndReason` are wider unions, so an exhaustive `switch` on them stops compiling until it handles `clear`. A shell hook with no `matcher` on `session_start` or `session_end` also runs for the new occasions (see the CLI note).

Hooks can now tell a cleared conversation from the rest. `PluginSessionSource` gains `clear` (a conversation that begins empty after the old one was cleared) and `PluginSessionEndReason` gains `clear` (a conversation that ended because the person cleared it). A shell hook's `matcher` on `session_start` and `session_end` can name them, and its stdin carries them as `source` and `reason`. The existing values, names and fields are unchanged.

If your code switches exhaustively on `context.source` or `context.endReason` (a `never` check in the default branch), TypeScript will now ask you to handle `clear`; handle it as you handle `startup` for a start and `replaced` for an end if you have no other plan. This is the only thing that can fail to compile; nothing at runtime changes for a host that does not announce a clear. A host that embeds the kernel announces a clear by running `executeHooks('session_end', { endReason: 'clear', ... })` and `executeHooks('session_start', { source: 'clear', ... })` itself.
