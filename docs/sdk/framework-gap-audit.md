---
type: Analysis
title: Framework and computer-use gap audit
description: Source-verified implementation boundaries against Pydantic AI, AG-UI and OpenBot.
resource: packages/sdk/src/index.ts
tags: [sdk, harness, ag-ui, computer-use, verification]
status: draft
---

# Framework and computer-use gap audit

Reviewed 2026-09-08 against Namzu `035dcbc6`. Fresh shallow upstream checkouts
were inspected without installing or running their applications:

| Source | Revision |
| --- | --- |
| Pydantic AI | `62f1e8302a356d09962c55117f41a282cf1eb243` |
| Pydantic AI Harness | `c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504` |
| CopilotKit/OpenBot | `7b94a0b802732e6491634160cf9ed3fcfb813424` |

OpenBot is interpreted as CopilotKit/OpenBot from the AG-UI context; the user
had not supplied a repository URL. This is a bounded source audit, not a claim
of exhaustive framework parity or measured model-quality superiority. Kernel
contracts, optional capability packages, transport adapters and application UI
are separate responsibilities.

## What exists and was checked

* `@namzu/computer-use` implements native Windows/WSL, macOS, X11 and Wayland
  adapters. `packages/cli/src/tui/App.tsx` enables it;
  `packages/cli/src/tui/agent.ts` initializes the host and mounts the SDK tool.
  Its 62 tests and the 3 CLI reachability tests passed during this audit.
* A real device probe initialized the Windows adapter through WSL and read
  `5120 × 1440`, scale 1. This proves desktop reachability and geometry, not
  successful arbitrary GUI tasks. No clicks, typed input or screenshots were
  performed during this audit. Feature flags are declarations, not independent
  execution tests for every action.
* `@namzu/ag-ui` is a Namzu adapter built on official protocol schemas and SSE
  encoding (`@ag-ui/core`, `@ag-ui/encoder`), with `fast-json-patch` for state
  patches. It does not embed the Python Pydantic runtime. All 117 package tests
  passed, including official `HttpAgent` interoperability. Backend tools, text,
  shared state, cancellation and successful final persistence are covered.
* Existing SDK run checkpoints, event replay cursors and authorization are
  useful primitives for the missing UI round trips. Their presence does not
  mean the AG-UI adapter already exposes those round trips.

## Confirmed computer-use gaps

**Incorrect per-action capability advertising.**
`packages/computer-use/src/adapters/darwin.ts:130` sets `mouse` from osascript
availability; its scroll branch at line 194 always refuses. The SDK's
`packages/sdk/src/tools/builtins/computer-use.ts:148` expands `mouse: true` into
move, click, drag and scroll. A controlled Darwin adapter fixture without
cliclick produced an advertised scroll action followed by an immediate
`ActionCapabilityError`, without executing a native command. Move/drag also
have additional cliclick requirements. This is an actual defect, independent
of any competitor. Introduce action-specific declarations and derive both
advertising and admission from them; test every adapter's advertised actions.

**Semantic browser observation and stable element actions.** Namzu's built-in
`ComputerUseAction` contract contains screenshots and coordinate/key actions.
It has no browser snapshot/reference protocol. OpenBot's
[ARIA snapshot parser](https://github.com/CopilotKit/openbot/blob/7b94a0b802732e6491634160cf9ed3fcfb813424/agent-computer/src/aria-snapshot.ts)
and [browser action handlers](https://github.com/CopilotKit/openbot/blob/7b94a0b802732e6491634160cf9ed3fcfb813424/agent-computer/src/index.ts#L1128)
support element references with snapshot freshness checks. A browser capability
package could add this while retaining pixel actions for non-browser apps.
Acceptance: navigate, inspect, fill and submit a local fixture; stale references
must fail before mutation. This audit does not claim that an externally supplied
MCP browser server cannot already provide similar tools.

**Computer allocation and human handover.** Namzu's shipped host targets the
current device and offers no computer lease/profile allocation or human-control
state machine in `ComputerUseHost`. OpenBot's
[supervisor](https://github.com/CopilotKit/openbot/blob/7b94a0b802732e6491634160cf9ed3fcfb813424/server/src/computer/supervisor.ts),
[persistent profiles](https://github.com/CopilotKit/openbot/blob/7b94a0b802732e6491634160cf9ed3fcfb813424/agent-computer/src/profiles.ts)
and [control state](https://github.com/CopilotKit/openbot/blob/7b94a0b802732e6491634160cf9ed3fcfb813424/agent-computer/src/control.ts#L201)
are separate application/environment features. Its actor is refused while a
human owns control. Its screen streaming is browser streaming, not evidence of
all-desktop support. Namzu already has sandbox providers, but those do not
automatically create isolated desktop sessions or browser profiles.
Acceptance: two allocated computers cannot share profiles; taking control blocks
agent mutation until release; reconnect preserves the owning lease.

## Confirmed AG-UI gaps

| Gap | Namzu evidence | Upstream evidence and next acceptance check |
| --- | --- | --- |
| Frontend tools | `packages/ag-ui/src/adapter.ts:141` refuses nonempty `tools` with HTTP 422. | Pydantic's [frontend toolset](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/ui/ag_ui/_adapter.py#L341) is built from frontend tool definitions. Add host-admitted deferred calls; an official client must receive and return one authorized result exactly once. |
| Approval and interrupt resume | `adapter.ts:147` refuses `resume`; `events.ts:232` maps native pause to custom event plus error. | Pydantic's [resume conversion](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/ui/ag_ui/_adapter.py#L362) maps interrupt payloads to deferred results. Bind host-owned interrupt IDs to native checkpoints; test approval, denial, edited arguments, duplicate and foreign-thread resumes. |
| Client-held replay fidelity | `messages.ts` drops reasoning/activity history and rejects encrypted conversational metadata. | Pydantic's [history conversion](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/ui/ag_ui/_adapter.py#L809) supports opaque thinking/compaction round trips. This is optional: server-owned history is a valid alternative. Never solve it by exposing private reasoning text. |
| Reconnect and real UI coverage | Adapter disconnect cancels its request-owned run; CopilotKit React integration is a documentation sketch. | Add host-owned durable streaming/replay and a real CopilotKit UI fixture. SDK replay cursors can be reused. No equivalent built-in reconnect endpoint was established in the inspected Pydantic adapter, so this is not claimed as its kernel advantage. |

The AG-UI [interrupt specification](https://docs.ag-ui.com/concepts/interrupts)
is the interoperability target, rather than copying one framework's internal
checkpoint shape. Supporting ordinary SSE is not sufficient for interactive
approval, frontend tools or reconnect.

## Remaining kernel and harness differences

**Structured-output host review and native query mode are implemented.**
Namzu already validates structured output with Zod and bounded retries.
The audit found `reviewAnswer` only on the plain-text path. Optional
[structured output review](structured-output-review.md) now checks JSON-decoded
candidates before settlement, with bounded corrections, fail-closed errors and
checkpointed rejection counts. Pydantic's
[parsed-output validators](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/_output.py#L126)
provide a run-aware async validation/retry hook. Zod refinements are not absent
in Namzu; the host review gap is now addressed.
Query request assembly now populates provider-level `responseFormat` for
explicit native mode in `StructuredOutputConfig`; Pydantic exposes explicit
[native, tool and prompted modes](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/output.py#L43).
Acceptance: a schema-valid answer rejected by a host check is corrected within
one bounded review loop; a native-schema run sends the expected wire format.

**Cumulative tool-call admission is distinct from concurrency.**
`packages/sdk/src/run/LimitChecker.ts` checks tokens, cost, time and iterations;
the executor caps simultaneous calls. Optional
[tool call budgets](tool-call-budget.md) now add cumulative batch preadmission
and durable per-run accounting for retries, nested calls and recovery. Pydantic checks a
[projected batch count](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/_tool_execution.py#L495)
before executing calls. Acceptance: a batch of three with only two calls left
executes none; retries, nested calls and resumed runs have documented accounting.

**Task status is stored but not automatically reminded each step.** The CLI
owns durable task tools, yet its current per-step context contributes memory
recall without a projection of current task status. The SDK already supplies
`prepareStep.system` and `workingMemoryProvider`. Harness
[Planning](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/planning/_capability.py#L170)
reads its plan before each request. This is a CLI composition opportunity;
test next-request visibility after compaction and measure saved repeated work
against extra prompt tokens before enabling a blanket reminder.

**External workflow engines are an optional integration gap.** Namzu already
has fenced claims, injectable run/checkpoint stores and completed-call recovery.
Pydantic additionally ships integrations such as
[Temporal durability](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/durable_exec/temporal/_durability.py#L103).
Namzu hosts currently own worker orchestration. Acceptance for such an adapter
is a killed worker resumed on a second worker with retained receipts and approval
ownership; installing a database alone does not establish those guarantees.

The audit's focused SDK validation passed 47 tests covering structured output,
partial-batch recovery, prepared-tool authorization, limits and working memory.
Execution barriers, memory recall, delegation and tool selection are already
implemented and must not be reported as wholly missing.

## Implementation order

Follow-up implementation now addresses the computer action-advertising defect
through [exact action and button capabilities](computer-actions.md). The
source observations above remain the audit of the named baseline revision.
The [tool-discovery receipt](tool-discovery.md) now verifies active matches and
keeps unknown requests distinct; the two defects in step 1 are addressed.

1. Correct computer action capability declarations and tool-discovery feedback.
   `packages/sdk/src/tools/builtins/search-tools.ts` still says all matching tools
   are active when a deferred search has no result, without checking active
   matches. The earlier [efficiency review](../cli/harness-efficiency-review.md)
   identified this; it remains open at this revision.
2. Add uniform parsed-output review and cumulative tool-call preadmission with
   explicit retry/recovery contracts.
3. Build the admitted deferred-tool/interrupt round trip, then exercise it
   through the official client and a real CopilotKit UI.
4. Add browser semantic observation and explicit control ownership as optional
   capability/environment layers. Do not make a web coworker platform a kernel
   dependency.
5. Measure long-run evidence recovery and resume behavior before claiming a
   complete memory or cognitive system. Existing bounded conversation search
   now pages through large transcripts with bounded reads and 4 MiB record admission; retained previews cannot restore discarded
   bytes. Indexed/spilled evidence recovery remains an extension.

This audit changes documentation only. Passing the existing tests establishes
the supported contracts and does not close the gaps listed here.

The adapter now supports explicit initial `MESSAGES_SNAPSHOT` publication through
`ui.setInitialMessages` inside the host query factory. Official-client tests
verify stale display history replacement before new query events. This closes
initial display reconciliation only; snapshots at a live interrupt boundary,
frontend execution and replay-safe AG-UI resume remain open.

Anthropic's provider-level `responseFormat` omission is now fixed: `json_schema`
reaches `output_config.format` alongside effort. Real vendor-SDK loopback tests
verify the body and local refusal of unsupported format variants. Native mode
selection and local validation inside `query` are now implemented; see
[native structured output](native-structured-output.md).
