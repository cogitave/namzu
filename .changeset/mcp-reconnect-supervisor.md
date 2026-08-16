---
'@namzu/sdk': minor
---

An MCP connection that drops is now reconnected instead of staying dead for the
life of the process.

`MCPClient.connect()` was called exactly once, by whoever built the client.
`transport.onClose` set the status, emitted the lifecycle event and rejected
everything pending — and nothing scheduled another attempt. One network blip,
one server restart, one laptop sleep, and a plugin's MCP tools were gone until
the process ended, while the plugin itself went on reporting as enabled.

New `MCPReconnectSupervisor` (exported from the connector barrel) watches one
client through the existing `onLifecycle` subscription and reconnects with
bounded exponential backoff — defaults: 500 ms initial, 30 s ceiling, 6
attempts, then `onGaveUp`. `PluginLifecycleManager` attaches one per client it
creates.

**If you build clients yourself, stop the supervisor before disconnecting.**
`disconnect()` emits the same `mcp_client_disconnected` event a dead transport
does and the event carries nothing that separates them, so a supervisor still
attached at teardown will reconnect what you just closed. `stop()` is part of
the teardown sequence, not an optimisation. The plugin lifecycle already does
this on both its teardown paths.

`onReconnected` fires after a successful recovery. A reconnected server may
have restarted with a different tool list, and the supervisor cannot know what
a host needs to redo — so it reports when rather than guessing what.
