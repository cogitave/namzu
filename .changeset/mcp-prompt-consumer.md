---
'@namzu/sdk': minor
---

A published MCP prompt reaches the model.

`listPrompts` and `getPrompt` landed on the client and server last release and stopped there: a server could publish prompts, the SDK could fetch them, and nothing ever put one in front of a model. That shipped the protocol half without the consumer half — the same primitive-with-no-driver shape this series exists to remove, created by the fix for it.

A prompt is now adapted into a tool the model can call, `mcp_prompt_<server>_<name>`, with an input schema built from the arguments the prompt declares.

**Why a tool and not system content.** Folding a prompt into the system prompt puts remote text in the cached prefix, so every turn pays for it and the cache breaks whenever the server changes its wording — and system position *reads* as instruction, which is the last thing text from a remote party should read as. A slash command would route through the host's UI, so a headless run could never use one. A tool call is explicit, auditable, passes the same admission policy and `allowedTools` filter as every other capability, and its answer arrives as a `tool_result`, which a model already treats as data returned by something rather than as direction.

The result is wrapped in an envelope naming the server and the prompt, and saying the content is material to work with rather than instructions. Untrusted content arriving through a tool result is the standard injection surface, and the mitigation that survives contact is saying plainly whose words these are. A server that returns an `assistant` message has that role reported inside the envelope, never turned into an assistant turn in the run's own history.

Prompts pass the **same admission policy** as tools, via a shared name check — a server publishing a prompt is the same trust question as one publishing a tool, and two copies of an allow/deny rule are two chances for one to drift permissive. They are namespaced apart from tools, since a server may publish both under one name and collapsing them would let whichever registered second replace the first.

A fetch that fails is returned to the model rather than thrown: a read-only lookup that a server cannot answer is something an agent can work around, and ending the run over it is the wrong trade.
