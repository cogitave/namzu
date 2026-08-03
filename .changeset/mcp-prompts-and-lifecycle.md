---
'@namzu/sdk': minor
---

MCP prompts, server lifecycle events, and an honest "not here".

**Prompts.** `MCPPromptDefinition` and `MCPPromptArgument` were declared when the MCP types were written; no client method ever asked a server for one and no server branch ever served one, so a server publishing prompts had them silently ignored. `MCPClient` gains `listPrompts()` and `getPrompt(name, args)`, and `MCPServer` takes an optional `MCPServerPromptProvider` alongside the tool and resource ones.

Prompts page through the same reader as every other list, which is the point of that reader being generic — a server that pages its prompts does not get silently truncated to page one the way the tool list once was. Required arguments are checked against the prompt's own declaration in the server rather than left to each provider to re-implement or forget.

The messages a prompt returns are the **server's** composition, carried in their own `MCPPromptMessage` shape rather than the kernel's `Message`. A prompt arriving from a remote server is exactly the untrusted-content case: converting at the boundary is what stops a server's `assistant` message from becoming a claim that this agent already said something.

**Lifecycle events.** `MCPLifecycleEvent` and `MCPEventListener` were declared beside the prompt types and nothing ever emitted one, so a host learned a server had died by noticing that calls had started failing. `MCPClient.onLifecycle(listener)` emits from the four transitions that already existed and already mutated `status` — no new state, the client just says out loud what it already knew. It returns an unsubscribe, which `onNotification` does not: a listener that cannot be removed keeps a disposed host object alive for the life of the client. A listener that throws is logged and the rest still run, because these fire from inside transport callbacks and an escaping exception would surface as a connection error, blaming the server for a bug in the host's observer.

**"None" and "not here" are different answers.** `resources/list` returned `{ resources: [] }` when no provider was configured, for a capability `initialize` never advertised — telling a client, in the protocol's own vocabulary, that the answer is "none" when the truth is "this server does not do that". The two send a client in opposite directions: one stops asking, the other looks elsewhere. Unimplemented methods now answer with the protocol's method-not-found code via the exported `MCPMethodNotFound`, while a provider that throws still reports an internal error — a broken provider is not an absent feature, and collapsing them tells a client to stop asking for something that works tomorrow.
