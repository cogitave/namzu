---
'@namzu/sdk': minor
---

Hook order is declared, and a hook deadline stops holding the process open.

**Order was install order** — neither declared nor stable, since it depends
on when each plugin happened to be installed. That is fine for a hook that
only observes and wrong for one that decides: `executeHooks` short-circuits
on `skip` and `error`, so a hook that denies a dangerous command only gets
to deny it if it runs before whatever else stops the chain. A guard that
fires depending on installation history is not a guard.

`PluginHookDefinition.priority` — lower runs first, default `100`, ties
keeping registration order so a plugin that sets nothing behaves exactly as
before. Convention: guards below 100, observers above. `post_*` hooks still
unwind, so a guard at priority 1 runs first on `pre_tool_use` and last on
`post_tool_use` — the wrapping order a guard needs.

**The deadline timer was never cleared.** `setTimeout` was armed per hook
invocation and left running after the hook resolved, and an armed timer
keeps the Node event loop alive. Hooks fire on every tool call and every
model call, so a run of twenty tool calls left twenty live timers and the
process could not exit until the last one expired. Nothing failed — it just
hung, for up to the timeout, every time.

**`PluginHookContext.signal`** aborts when that deadline expires. The
runtime stops waiting on a slow hook either way, but without a signal the
hook never learns it was abandoned: a request inside it keeps a socket open
and its eventual result is written into a run that moved on.

**`registerHook(pluginId, hook)`** attaches a hook without installing a
plugin from disk. Registration was reachable only through `enable()`, which
loads a manifest and imports modules by path, so a host that wanted one
in-process guard had to lay out a plugin directory to get it — and this
class's own tests were reaching into a private map to work around it,
constructing entries the real path would never produce.
