---
"@namzu/sdk": major
---

A tool result that is the request is now refused by default — scoped to results framed as untrusted, with an off switch and a per-tool exception

`ToolResultGuardrailContext` has carried the validated `input` beside `output` since the tool-result boundary shipped, and nothing read the two together. `toolResultCorrespondenceGuardrail()` reads them: a result handed back the request instead of an answer to it is refused, which needs no pattern list to look wrong.

**The value that changed: a run now screens results framed as untrusted, by default.** `DEFAULT_TOOL_RESULT_GUARDRAILS` is one correspondence screen, and the executor installs it on the tool context of every run. A connected server's answer that restates the request — an answer that IS the question — now fails the tool call with the reason in place of the output, instead of reaching the model as an answer.

**What to do to keep the old behaviour.** Pass an empty array:

```ts
await runAgent({ provider, model, prompt, toolResultGuardrails: [] })
```

The same field is on `BaseAgentConfig`, so it reaches delegated children too. At the registry level, `new ToolRegistry({ resultGuardrails: [] })` wins over the run's default as well: a registry built with its own list — including none — is authoritative for its own results, and the default only applies where nothing was configured. Hosts that build their registry and hand it over get the default for free and the escape hatch through either door.

**Scope: `scope: 'framed'`, because the first version of this refused a working tool.** The screen judges results that carry the untrusted envelope — content this process did not author, marked as such by `wrapUntrusted`, which is what the MCP adapter applies to every non-empty text a connector returns. `scope: 'all'` adds this process's own unframed tools at the cost of an exemption list.

The scope shipped in the previous cut of this changeset as `'connected'`, implemented as "the tool definition carries `provenance`", and that predicate was wrong in both directions: it MISSED a host tool that frames its own result (the CLI's remote search frames its answer and registers as a host tool, so a search that restated its query went unscreened), and it included every connected server's tool by provenance whether or not the result was framed. `provenance` is now used only where it belongs — deriving the `server:tool` spelling `passthroughTools` accepts — and the scope is a statement about the content. If you passed `scope: 'connected'`, pass `'framed'`.

**`passthroughTools` is the exception the default needs, and `passthroughToolNames` is its rule.** The screen is right about a tool that was asked a question and handed the question back, and wrong about a tool whose purpose is to hand something back: a whitespace normaliser, a validator returning what it validated, a search that repeats its query when it found nothing, a fetch whose redirect stub IS its url. Nothing on this context distinguishes the two, and a refused legitimate result is how this control dies — the host switches the screen off and it protects nothing. So:

```ts
toolResultCorrespondenceGuardrail({
  passthroughTools: ['mcp_weather-co_lookup', 'weather-co:lookup'],
})
```

gives back the default and names the exceptions. `passthroughToolNames(toolName, server?)` is the new export that computes which names a tool answers to — the registered one, the bare tail after a plugin namespace, the server's own name for it, and `server:tool` — so a caller reporting on such a list (the CLI says so out loud when a name matches no tool it mounts) derives them the way the screen does instead of keeping a second copy of the rule. The sets are per registration shape: `mcp_weather-co_lookup` and `myplugin__mcp__weather__lookup` do not answer to each other's spellings.

**The refusal says what it did.** The reason now names the tool the result came from and describes the comparison as whitespace-normalised. It used to say the result restated the request "verbatim and on its own" for a case the comparison only reached after normalising whitespace, and to name the tool only in the message the registry wraps around it — which a caller reading the reason alone (a log line, a host's own reporting) never saw.

**The delegation claim is now implemented.** `BaseAgentConfig.toolResultGuardrails` has said since this shipped that the screens apply "in this agent and in the agents it delegates to"; the kernel did not do the second half. A delegated child is a fresh run with its own executor, so it installed the shipped default whatever its parent had chosen — a `[]` that turned the screens off for the parent left them ON in everything it delegated, and a `passthroughTools` exception did not survive the hop. `AgentManager` now stamps the parent run's value onto the child config the way it stamps `parentSpan`, `resumeHandler` and `env`, and the delegation tools carry the value from the run's `ToolContext`. A spawn that supplies `configOverrides.toolResultGuardrails` replaces the inherited value, including with `[]`.

**What the shipped tool set does and does not prove.** An earlier version of this changeset said the shipped tools were "the proof" the comparison tolerates a real tool. No shipped builtin frames its result, so the scope returned `pass` before any comparison ran and the test would have passed against a comparison that refused everything. The test now drives the same real calls twice — once on the default scope, once with `scope: 'all'` so the comparison actually runs on every one — and the second run is the claim. `web_fetch` returning its own URL is pinned as a refusal under `'all'`, and so is the exemption that gets it back.

**Why this is a default at all.** The issue this closes ended with "hosts can write this screen themselves today … this issue is about shipping a good default" — and a preset nobody can reach is not a default. `resultGuardrails` was a registry-construction option, the CLI builds `new ToolRegistry()`, and nothing set it, so the screen was enableable only by writing SDK code. The run config now carries it, the CLI names screens in `toolResultScreens`, and a default a caller cannot switch off would have been the wrong trade — which is why the option landed first, in this release, rather than after.

New exports: `toolResultCorrespondenceGuardrail`, `ToolResultCorrespondenceOptions`, `passthroughToolNames`, `DEFAULT_TOOL_RESULT_GUARDRAILS`, `untrustedEnvelopeBody`. New run option: `toolResultGuardrails` (also on `BaseAgentConfig`, `QueryParams` and `ToolContext`). `wrapUntrusted` now escapes `>` in an attribute value, so a source name containing one can no longer end the opening tag early — the frame text for the existing call sites is unchanged unless an attribute value contained `>`.

What the screen deliberately does not decide, each with its reason in the docblock: a lookup answering about the wrong subject (needs a subject declaration the framework cannot infer — a file read's answer does not name its path), an empty result for a non-empty request, a shape contradicting `ToolDefinition.outputSchema`, and a failed call whose text is a diagnostic the model needs.
