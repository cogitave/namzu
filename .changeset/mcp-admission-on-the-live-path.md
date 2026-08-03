---
'@namzu/sdk': minor
---

The MCP admission boundary is on the path a real server takes.

`MCPToolDiscovery` has held two checks since it was written: a per-server allow/deny policy deciding what a server may contribute, and detection for a server whose tool set changed since it was last seen. It was implemented, tested and publicly exported, and **nothing outside its own tests ever constructed one**.

`PluginLifecycleManager.attachMCPServer` — the only code in the tree that connects a real MCP server — called `client.listTools()` and registered whatever came back. So the remote side decided what entered the agent's tool registry, which is least privilege inverted at the one place it matters. Tools land as `deferred` and a run's `allowedTools` filters the model-visible catalogue, so this was never "arbitrary tools reach the model immediately" — but the check written for exactly this was not consulted.

`PluginLifecycleManagerConfig` takes `mcpToolPolicies` and `onMCPToolDrift`, and discovery now runs through the boundary. Passing neither admits everything, exactly as before: adding a boundary must not turn a working plugin into a broken one.

**Drift is keyed by server name rather than client id, and that is what makes it fire at all.** A client id is minted per connection, so on the path a real server takes — a plugin enabling, connecting, being disabled, another enabling — every discovery was the first that id had ever seen and drift could not fire however many times the server changed underneath. The threat it exists for is a server that advertises something benign while a host is deciding and something else afterwards, which is a property of the *server* across connections. For the same reason a disconnect no longer forgets what a server last advertised: forgetting on teardown is precisely the window that swap uses.

Drift compares what was **admitted**, not what was advertised, so a tool the policy refuses either way does not raise a warning. A warning that fires for something already refused trains a host to ignore the one that matters.
