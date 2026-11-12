---
type: Reference
title: Span attributes from the OpenTelemetry GenAI convention
description: Which attribute names from the OpenTelemetry semantic conventions for generative AI the kernel's spans carry, the convention version they are pinned to, where each value comes from, what is left out and why, the setting that turns them off, and what to do when the convention moves.
resource: packages/sdk/src/telemetry/genai.ts
tags: [sdk, telemetry, opentelemetry, observability, genai]
status: stable
generated: { by: process:agent, at: 2026-11-12T00:00:00Z }
---

# Span attributes from the OpenTelemetry GenAI convention

Tools that read traces (dashboards, cost and quality monitors) look for fixed
attribute names for the model, the operation, token counts, tool calls and
agents. The OpenTelemetry semantic conventions for generative AI define them.
The kernel's spans carry those names **in addition to** its own. Nothing was
renamed or removed.

## The pinned version

| | |
| --- | --- |
| Convention | OpenTelemetry semantic conventions, generative AI |
| Version followed | **1.41.1** (released 2026-05-11) |
| Schema URL | `https://opentelemetry.io/schemas/1.41.1` |
| Stability the convention states | **Development**: every `gen_ai.*` name below is marked "Development", so names can change. `error.type` is Stable. |
| Source read | [spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/docs/gen-ai/gen-ai-spans.md), [agent spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/docs/gen-ai/gen-ai-agent-spans.md), [attribute registry](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/docs/registry/attributes/gen-ai.md) |

Why 1.41.1 and not the newest release (1.45.0 at the time of writing): from
1.42.0 the repository's GenAI pages are stubs that say the conventions moved to
a separate repository (`open-telemetry/semantic-conventions-genai`), and the
1.45.0 registry lists the `gen_ai.*` attributes as deprecated because they
moved. That repository has no release yet and its README gives no schema URL.
1.41.1 is the last release that carries the full text, so it is the last one
that can be followed exactly and stated by a schema URL that resolves.

The version is stated the way the convention says: the schema URL is on the
**instrumentation scope** (`namzu`) of every span the kernel starts, not on
individual spans. It is present only while the names are on. The kernel's own
`namzu.*` names and `gen_ai.system` are not part of that schema; a backend
that applies schema translation sees them as extra attributes.

## What each span carries

"Added" is what this change added; "existing" was already there under the
same name and is listed because it is part of the convention too. The count of
added attributes is the number a backend that bills by attribute will see.

| Span (name, unchanged) | Attribute | Type | Value and our source | Convention level | |
| --- | --- | --- | --- | --- | --- |
| `chat <model>` | `gen_ai.operation.name` | string | `chat` | Required | existing |
| | `gen_ai.provider.name` | string | a value the convention lists when our provider is that vendor's own API, otherwise our own provider id as a custom value (below); always present | Required | added |
| | `gen_ai.request.stream` | boolean | `true`: the kernel always streams a model call | Conditionally required | added |
| | `gen_ai.request.model` | string | the model the turn asked for | Conditionally required | existing |
| | `gen_ai.conversation.id` | string | the session id | Conditionally required | existing |
| | `gen_ai.request.temperature`, `gen_ai.request.max_tokens` | double, int | the request, when set | Recommended | existing |
| | `gen_ai.response.model`, `gen_ai.response.id` | string | what the response said | Recommended | existing |
| | `gen_ai.response.finish_reasons` | string[] | one value: `stop`, `tool_calls`, `length` or `content_filter` | Recommended | existing |
| | `gen_ai.usage.input_tokens` | int | the whole prompt, cache reads and writes included, as the convention asks | Recommended | existing |
| | `gen_ai.usage.output_tokens` | int | completion tokens | Recommended | existing |
| | `gen_ai.usage.cache_read.input_tokens` | int | tokens served from the provider's cache; only when the driver reported more than 0 | Recommended | added |
| | `gen_ai.usage.cache_creation.input_tokens` | int | tokens written to the cache; only when more than 0 | Recommended | added |
| | `gen_ai.usage.reasoning.output_tokens` | int | reasoning tokens, a subset of the output; only when the driver reported more than 0 | Recommended | added |
| | `error.type` | string | on a failed call: the provider failure kind (`throttle`, `network`, `auth`, `context_overflow`, `bad_request`, `server`), else the error's class name, else `_OTHER` | Conditionally required | added |
| `namzu.tool.execute <tool>` | `gen_ai.operation.name` | string | `execute_tool` | Required | added |
| | `gen_ai.tool.name` | string | the tool's name | Required | existing |
| | `gen_ai.tool.call.id` | string | the model's call id, when there is one | Recommended | existing |
| | `gen_ai.tool.type` | string | `function` | Recommended | existing |
| | `error.type` | string | on a failure: `permission_denied` for a call the kernel refused (outside the step's allow-list, plan mode), the exception's class name for a tool that threw, `_OTHER` for any other failed result (a tool that is not available included) | Conditionally required | added |
| `namzu.agent.turn <agent>` | `gen_ai.operation.name` | string | `invoke_agent` | Required | added |
| | `gen_ai.provider.name` | string | as for the model call | Required | added |
| | `gen_ai.agent.name`, `gen_ai.agent.id` | string | the agent's name and id | Conditionally required | existing |
| | `gen_ai.conversation.id` | string | the session id | Conditionally required | existing |
| | `gen_ai.request.model` | string | the turn's model | Conditionally required | existing |
| | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | int | the turn's running totals of the kernel's own count. The convention says input tokens should include cached ones; this total can leave cached tokens out, so on a turn with cache reads it can be lower than the sum of its model-call spans. Read cached and total input from the model-call spans, which follow the convention. The turn span carries no cache attributes for this reason. The values predate this change and are not altered | Recommended | existing |
| | `error.type` | string | on a failed turn: as for the model call. A turn that pauses after a failed model call (status `paused`, span status OK, resumable) does not carry it; the failed model-call span does | Conditionally required | added |

A sub-agent is the same turn span for the child session, parented to the
span that started it and carrying `namzu.session.parent_id`. It gets the same
attributes as any agent run.

Attributes added per span, at most, with the default on: model call **5**
(provider, stream and the three token counts; a failed call carries provider,
stream and `error.type`, 3), tool call **2** (operation, `error.type` on a
failure), agent run **3** (operation, provider, `error.type` on a failure).
The iteration span carries none.

### Provider names

`gen_ai.provider.name` is Required. The convention's registry at 1.41.1
(`docs/registry/attributes/gen-ai.md`, the list of well-known values) says:
"If one of them applies, then the respective value MUST be used; otherwise, a
custom value MAY be used." It states no rule on the form of a custom value.
The kernel therefore writes a listed value only when its provider is that
vendor's own API, and otherwise its own provider id, lower case, so the
attribute is on every span that carries it. A gateway that forwards to several
vendors, a local runner and a custom HTTP endpoint are never given a vendor's
value they are not. `gen_ai.system` is a separate, deprecated attribute; the
convention does not tie the two together, and the kernel keeps writing it
unchanged.

| Kernel provider id | `gen_ai.provider.name` |
| --- | --- |
| `anthropic` | `anthropic` |
| `bedrock` | `aws.bedrock` |
| `deepseek` | `deepseek` |
| `google` | `gcp.gen_ai` (the convention's value for any Google generative AI endpoint; the id does not say which) |
| `openai`, `codex` | `openai` |
| any other id: `ollama`, `lmstudio`, `openrouter`, `http`, `zen`, `zen-go`, the scripted test provider (`mock`) | the id itself, lower case, as a custom value |

## Where the kernel does not follow the convention

- **Span names.** The convention names an agent span `invoke_agent <agent>` and
  a tool span `execute_tool <tool>`. The kernel's are `namzu.agent.turn <agent>`
  and `namzu.tool.execute <tool>`, which existing dashboards and queries use.
  They stay. A backend that finds spans by operation should filter on
  `gen_ai.operation.name`, which is now set. The model call is `chat <model>`,
  as the convention names it.
- **Span kind.** Every kernel span is `INTERNAL`. The convention prefers
  `CLIENT` for a model call. Changing it would change service maps for existing
  users, so it is kept.
- **`gen_ai.system`.** Written by the kernel before this change, with the
  kernel's provider id. It is in the 1.41.1 registry but deprecated, replaced
  by `gen_ai.provider.name`. The kernel still emits it, deliberately, because
  existing users rely on it; it is not removed.
- **Not emitted because the record cannot fill them truthfully:**
  `server.address` and `server.port` (the driver does not report the endpoint
  to the span), `gen_ai.request.top_p`, `top_k`, `seed`, `stop_sequences` and
  the penalties (the kernel does not set them per request),
  `gen_ai.response.time_to_first_chunk`, `gen_ai.output.type`,
  `gen_ai.agent.version`, `gen_ai.agent.description`, `gen_ai.tool.description`.
- **Compaction and MCP calls** have no spans of their own; an MCP tool call is
  a tool span.

## Content

The convention treats prompts, replies, system instructions, tool definitions
and tool arguments and results as opt-in (`gen_ai.input.messages`,
`gen_ai.output.messages`, `gen_ai.system_instructions`,
`gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`,
`gen_ai.tool.call.result`), because they are likely to hold personal data. The
kernel's spans have never carried any of it and have no content switch, so
this change emits **none** of those names, ever. A host that wants the
conversation exported uses the separate, redactable
[session export](../cli/telemetry-export.md). The one free-text attribute
that was already there, `namzu.tool.error`, is unchanged.

## Turning the names off

On by default: the names are added beside the existing ones, are few (counted
above) and are what readers of these traces look for. A backend that bills by
attribute can turn them off. Off removes every attribute marked "added" above
and the schema URL; everything else is as before.

| Where | How |
| --- | --- |
| `@namzu/telemetry` | `registerTelemetry({ ..., genAiAttributes: false })` |
| The terminal application | `NAMZU_TELEMETRY_GENAI=0` (`0`, `false`, `no` or `off`) in the environment that turns the export on |
| The SDK alone | `setGenAiConventions(false)`, before the first turn |

The setting is read per span, process-wide. `@namzu/telemetry` applies it
when it starts; an older `@namzu/sdk` inside the peer range has neither the
names nor the setting, so nothing is emitted there.

## When the convention moves

1. Read the new release's GenAI text where it now lives, for the attributes in
   the table above.
2. Change `GENAI_SEMCONV_VERSION` and `GENAI_SEMCONV_ATTRIBUTES` in
   `packages/sdk/src/telemetry/genai.ts` together, and this page.
3. A name that was renamed is **added** under its new name beside the old one
   for a minor release, then the old one is dropped in a major, as for any
   public name.
4. `packages/telemetry/src/__tests__/genai-attributes.test.ts` fails when a
   span carries a `gen_ai.*` or `error.type` name that is not in the pinned
   list, and when the list stops matching the names written there from the
   pinned registry. Update the literal list in that test from the new text, not
   from the code.

`GENAI_SEMCONV_VERSION`, `GENAI_SEMCONV_SCHEMA_URL`, `GENAI_SEMCONV_ATTRIBUTES`,
`GENAI_NON_CONVENTION_NAMES`, `setGenAiConventions` and
`genAiConventionsEnabled` are exported from `@namzu/sdk`.
