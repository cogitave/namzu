# Changelog

## 1.0.0

### Major Changes

- df09910: fix(sdk)!: drop plan-task lifecycle from `buildAgentTool`

  `buildAgentTool` used to auto-create a plan task in the supplied
  `taskStore` and flip it to `'in_progress'` before invoking the
  subagent. On success it flipped to `'completed'`, but on failure
  the plan task was left stuck in `'in_progress'` forever — the
  `TaskStatus` enum has no `'failed'` value to transition to, so
  there was no honest way to close it from inside the tool.

  Removed `taskStore` and `runId` from `AgentToolOptions` entirely.
  The `Agent` tool's job is "invoke a subagent and return the
  result"; plan-task tracking is the parent's responsibility via
  `TaskCreate` / `TaskUpdate`, where the host owns the status
  semantics. This avoids the leak class entirely instead of
  patching it.

  Breaking change for any consumer that was relying on the auto-
  plan-task behaviour. Migrate by creating the plan task on the
  host side before calling `Agent`, and updating it on the host
  side once the tool result is in hand.

- ea21863: feat(sdk)!: rename builtin tools to Claude Code canonical names

  **Breaking change.** Builtin tool names now mirror Claude Code's canonical
  tool table verbatim (per `code.claude.com/docs/en/tools-reference`):

  - `bash` → `Bash`
  - `edit` → `Edit`
  - `glob` → `Glob`
  - `grep` → `Grep`
  - `read_file` → `Read`
  - `write_file` → `Write`

  `LsTool` and `SearchToolsTool` are still exported but **removed from the
  default `getBuiltinTools()` set**. Claude Code's training distribution
  does not include `LS` (directory listing is `Bash` + `Glob`) and has no
  `search_tools` analogue at all. Including them in the defaults gave the
  model two tools that looked right but degraded alignment. Hosts that
  genuinely want either can register them explicitly.

  Why this is breaking and worth it: Namzu is a peer to Claude Code's
  native agentic surface, not a wrapper around the Anthropic Beta Agents
  API. Mirroring the canonical names verbatim means Claude's pretrained
  agentic instincts apply for free — no system-prompt argument needed to
  explain what `Read` or `Bash` does. Idiosyncratic snake_case names threw
  that alignment away on every call.

  **Migration:** consumers that hard-code tool-name strings in their
  prompt overlays, friendly-label maps, or per-tool deny rules need to
  update them to the new PascalCase names. The runtime registry contracts
  (register / get / has) are unchanged; only the literal string names of
  the builtin tools moved.

- 8fd9349: feat(sandbox)!: Anthropic-style multi-mount container sandbox layout

  Adds a declarative `ContainerSandboxLayout` shape that maps onto
  Anthropic's container architecture (Claude container blueprint,
  Code Interpreter, "skills"). The `Container` prefix is load-bearing
  — this layout is specific to the container tier; future microVM /
  process tiers will carry their own layout types when their adapters
  land. Layout is supplied at provider construction — not per
  `provider.create()` call — so the type system catches missing-layout
  mistakes at compile time:

  ```ts
  import {
    createSandboxProvider,
    SANDBOX_DEFAULT_OUTPUTS_PATH, // re-exported from @namzu/sdk
  } from "@namzu/sandbox";

  const provider = createSandboxProvider({
    backend: { tier: "container", image: "namzu-worker:latest" },
    layout: {
      outputs: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/outputs",
        },
      },
      uploads: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/uploads",
        },
      },
      skills: [
        {
          id: "pdf-tools",
          source: { type: "hostDir", hostPath: "/opt/skills/pdf-tools" },
        },
      ],
    },
  });
  ```

  Each mount carries a discriminated `ContainerSandboxMountSource`.
  The single variant today is `{ type: 'hostDir'; hostPath: string }`;
  future variants (squashfs skill bundles, managed volumes attached
  to a container backend) land additively as minor bumps without
  reshaping the consumer call site.

  Layout fields and their defaults:

  - `outputs` — RW. Default `/mnt/user-data/outputs`. **Required**.
  - `uploads` — RO. Default `/mnt/user-data/uploads`.
  - `toolResults` — RO. Default `/mnt/user-data/tool_results`.
  - `skills` — RO list, default `/mnt/skills/<id>` per entry.
  - `transcripts` — RO. Default `/mnt/transcripts`.

  The defaults are exported as constants from `@namzu/sdk`'s root
  barrel (`SANDBOX_DEFAULT_OUTPUTS_PATH`,
  `SANDBOX_DEFAULT_UPLOADS_PATH`, `SANDBOX_DEFAULT_TOOL_RESULTS_PATH`,
  `SANDBOX_DEFAULT_TRANSCRIPTS_PATH`, `SANDBOX_DEFAULT_SKILLS_PARENT`)
  and re-exported from `@namzu/sandbox`, so prompt-template generators
  and the backend agree on a single source of truth. Both import
  paths (`@namzu/sdk` and `@namzu/sandbox`) are pinned by tests.

  There is intentionally **no `scratchpad` field**: the
  container-internal RW area (`/home/<imageUser>`) is image-bake
  responsibility, not a runtime knob.

  **Validation** runs synchronously inside `createSandboxProvider` and
  collects every violation in one
  `ContainerSandboxLayoutValidationError.reasons[]`:

  - `outputs` must be present.
  - Skill IDs match `/^[a-zA-Z0-9_.-]+$/`, and `id.includes('..')` is
    rejected (path-traversal guard — covers `..`, `foo..bar`,
    `..foo`, `foo..`). Isolated dots (`pdf-tools.v2`) pass.
  - Skill IDs are unique.
  - Resolved `containerPath`s are unique across every mount slot.

  **Error transport.** `ContainerSandboxLayoutValidationError`
  carries a `cause` field (Error native), `toJSON()` keeps `reasons`
  (and `cause` when set), and a new helper
  `serializeSandboxError(err: unknown): SerializedSandboxError`
  returns a plain object that survives `structuredClone`,
  `postMessage`, and `JSON.stringify` round-trips uniformly. The
  helper is **cycle-safe** — a `WeakSet`-threaded recursion detects
  self-cycles (`a.cause = a`), two-node cycles (`a.cause = b;
b.cause = a`), and longer loops, replacing the offending node with
  a `{ name: 'CircularReference', message: '[circular]' }` sentinel
  rather than overflowing the stack. The helper is also
  **transport-safe** — non-Error causes (Function, Symbol, BigInt,
  NaN, ±Infinity, undefined, null, primitives, plain objects) are
  converted to a typed envelope by `serializeNonErrorCause` BEFORE
  they enter the wire shape, so values that `JSON.stringify` drops
  silently or `structuredClone` throws on never appear.
  `SerializedSandboxError.cause` is strictly typed
  `SerializedSandboxError | undefined`. Use the helper at any
  worker / IPC / log-shipper boundary; cloning the Error subclass
  itself is not supported.

  **Breaking changes** — the legacy single-mount paradigm is removed:

  - `SandboxCreateConfig.hostWorkspaceDir` is removed. Pass the host
    path on `layout.outputs.source.hostPath` at provider construction.
  - `ContainerBackendConfig.workspaceMount` is removed. Pass the
    in-container path on `layout.outputs.containerPath`.
  - `SandboxProviderConfig` is now a discriminated union: the
    container variant requires `layout: ContainerSandboxLayout`, the
    other variants do not carry the field. Constructing a docker
    provider without a layout fails at compile time.
  - `SandboxCreateConfig.layout` does NOT exist; layout is
    factory-baked. The SDK runtime cannot accidentally call a
    container provider without a layout.
  - The docker backend no longer allocates host directories
    (`mkdtemp`) or removes them on `destroy()`. Every bind source is
    consumer-owned. This also fixes an `EACCES: permission denied,
mkdir '/Users'` crash that hit sibling-container deployments
    (Vandal Cowork).
  - The worker no longer reads `NAMZU_SANDBOX_LAYOUT` (it never
    branched on the env, only logged it; size grew with the skill
    list). Only `NAMZU_SANDBOX_WORKSPACE` is forwarded today.

  The reference Dockerfile pre-creates **only the parent directories**
  `/mnt`, `/mnt/user-data`, `/mnt/skills` — root-owned, mode 0555.
  Leaf paths (`outputs/`, `uploads/`, `tool_results/`, `transcripts/`,
  `<skill-id>/`) are intentionally NOT pre-created. When a bind is
  attached the docker daemon creates the leaf as the bind target;
  when not attached, the leaf does not exist — the model gets ENOENT
  instead of an empty writable dir that looks "mounted but uploaded
  nothing".

  `pnpm sandbox:smoke` (alias for `pnpm --filter @namzu/sandbox
test:smoke`) runs an opt-in docker integration test exercising the
  leaf-permission contract against a real docker daemon. Excluded
  from the default `pnpm test`; gated by a dedicated
  `.github/workflows/sandbox-smoke.yml` workflow that builds the
  reference image and runs the smoke test on PR / push when the
  sandbox surface changes. On CI (`process.env.CI === 'true'`), the
  smoke test fails fast if docker / the image are absent rather than
  silently skipping.

  `@namzu/sdk` exports `ContainerSandboxLayout`,
  `ContainerSandboxLayoutMount`, `ContainerSandboxMountSource`,
  `ContainerSandboxSkillMount`, `ResolvedContainerSandboxLayout`,
  and the five `SANDBOX_DEFAULT_*_PATH` constants from its root
  barrel. `@namzu/sandbox` re-exports those names plus
  `ContainerSandboxLayoutValidationError`, `serializeSandboxError`,
  and the `SerializedSandboxError` shape. The packed-tarball shape
  is verified by `.github/scripts/verify-consumer-install.sh`'s
  `@namzu/sandbox public-surface fixture`, which installs the
  package from a tarball into a clean project and asserts every
  documented constant + runtime export comes back via both
  `@namzu/sandbox` and `@namzu/sdk` import paths. `@namzu/sandbox`
  is also added to `ci.yml`'s `publint` and ATTW (Are The Types
  Wrong) gates.

### Minor Changes

- 542f057: feat(sdk): canonical `Agent` tool for synchronous subagent delegation

  Adds `buildAgentTool({ gateway, workingDirectory, allowedAgentIds, ... })`
  that builds a single tool named `Agent` with the input shape
  `{ description, prompt, subagent_type }`. This mirrors Claude Code's
  training distribution verbatim (per `code.claude.com/docs/en/sub-agents`):
  the parent's tool call BLOCKS on `gateway.waitForTask(handle.taskId)`,
  the subagent runs in its own context window, and the subagent's final
  text comes back as the tool result.

  Why this matters: the existing `buildCoordinatorTools` shipped a
  non-blocking `create_task` / `continue_task` / `cancel_task` trio that
  returned immediately and surfaced subagent completion via a
  `<task-notification>` callback. That pattern is useful for fire-and-
  forget multi-task fan-out but is **not** what Claude was trained on.
  Models calling the async coordinator tools waste tokens reasoning
  about whether the task completed yet; with the canonical `Agent`
  tool, the model just receives the result and continues. Free
  alignment, no system-prompt argument needed.

  Both surfaces remain available — the coordinator trio is the right
  choice for genuine work-queue surfaces, the `Agent` tool is the
  right choice when the host wants Claude Code parity.

- 265150b: feat(sdk): default sandboxed verification gate preset + expanded brick-pattern denylist

  Ship `defaultSandboxedGateConfig()` and `defaultSandboxedShellGateConfig()` from `@namzu/sdk` so
  hosts running an agent inside an isolated workspace don't have to hand-roll a `VerificationRule[]`
  just to keep in-sandbox file mutation from triggering a review prompt on every call. The first
  preset auto-allows read-only tools and `category: 'filesystem' | 'analysis' | 'custom'`; the
  second extends auto-allow to `category: 'shell'` for hosts with real OS-level isolation. Both
  keep the dangerous-patterns hard-deny in place.

  `DANGEROUS_PATTERNS` (consumed by the `deny_dangerous_patterns` rule) gains entries for `sudo`,
  `su -`, world-writable `chmod 777 /`, `curl|sh` / `wget|sh` exfil-then-exec pipes, outbound
  `ssh user@host`, and raw dynamic `eval`. The list is still high-signal, not exhaustive — the
  README in `verification/presets.ts` is explicit that the sandbox itself is the safety boundary
  and the patterns only catch blatant attempts.

- 52af97e: **Paste images into the conversation (vision input).**

  A user message can now carry image attachments. `@namzu/sdk` adds an optional `attachments` field to user messages (`ImageAttachment { data, mediaType }`, additive — text messages are unchanged), and the Anthropic provider sends them as image content blocks so the model can see them. In the CLI, press `Ctrl+V` to paste an image from the clipboard — it shows as an `⎘ Image #N` chip in the composer and is sent to the model as vision input when you submit.

- a71422a: feat(sdk): ReactiveAgent forwards verificationGate to drainQuery

  Adds an optional `verificationGate?: VerificationGateConfig` field on
  `ReactiveAgentConfig` and forwards it through `ReactiveAgent.run()` into
  `drainQuery`, mirroring the existing `SupervisorAgentConfig.verificationGate`
  plumbing. Without this, child agents running under `ReactiveAgent` could not
  opt into the same capability-aware deny/allow rules the supervisor already
  uses — the only path was `drainQuery`'s `autoApproveHandler` default, which
  approves every tool call silently. Hosts that want defense-in-depth at the
  child level (deny dangerous shell patterns, restrict by category) can now
  pass the same preset they pass to the supervisor.

- d6b5bc1: **Remove the legacy `append` file tool.** `AppendFileTool` is gone — it was already excluded from `getBuiltinTools()` (Claude Code's tool distribution has no `Append`), and appending is canonical `edit` with `insertLine: "end"`. The export is removed from the public surface; hosts that relied on it should switch to `edit`. namzu's CLI no longer needs to filter `append` out of its tool set.
- 63b4885: feat(sdk): forward sandboxProvider through reactive/supervisor agents

  `ReactiveAgentConfig` and `SupervisorAgentConfig` gain an optional
  `sandboxProvider?: SandboxProvider` field. When set, the agent's
  `runConfig` builder forwards the provider into `drainQuery`'s
  `sandboxProvider` slot, so the supervisor — and every child
  specialist run that inherits the supervisor's run config — gets
  the same per-task ephemeral container.

  Without this plumbing, a host that wires `sandboxProvider` only on
  the supervisor sees the field silently dropped before child
  specialists are spawned, and each child runs without a sandbox.
  The forwarding closes that gap so multi-agent hosts can pass a
  single per-task provider instance and have supervisor + every
  child share one container.

  Pure additive change — `SupervisorAgent` / `ReactiveAgent`
  constructors that don't pass `sandboxProvider` behave exactly as
  before.

- d86b161: **namzu can now delegate to sub-agents.**

  The CLI wires the SDK's native delegation: the model gets the canonical `Agent({ description, prompt, subagent_type })` tool and can hand a self-contained task to a fresh `general-purpose` sub-agent that runs in its own context window with its own tools, then returns its result. Delegations show in the transcript as a normal `Agent(...)` tool call with a live spinner and result.

  To support this from a host, `@namzu/sdk` now exports `ThreadManager` and `InMemoryThreadStore` from its public runtime surface (alongside the already-public `AgentManager`, `AgentRegistry`, `ReactiveAgent`, `LocalTaskGateway`, `buildAgentTool`, and the session/summary/capacity/workspace primitives) so a consumer can stand up an `AgentManager` end to end.

### Patch Changes

- 140bcc0: fix(sdk): Agent tool no longer reports failed subagents as successful

  `buildAgentTool` was treating `gateway.waitForTask(handle.taskId)`'s
  returned `state === 'completed'` as proof of success and ignoring
  the underlying `BaseAgentResult.status`. That was wrong: some
  gateways (the SDK's `LocalTaskGateway` for one) forward
  `task.state` directly from the agent manager without re-deriving it
  from the run's `status`, so a subagent run with `status: 'failed'`
  plus a non-empty `lastError` could surface as `state: 'completed'`
  and fool the parent into receiving `success: true` with garbage
  output.

  The check now requires BOTH layers to agree before reporting
  success: gateway state must be `'completed'` AND the run's
  `BaseAgentResult.status` (when present) must be `'completed'`. On
  failure the tool surfaces `lastError` and the disagreement state in
  both `error` and `data` so the parent can debug.

  Adds three pinned cases in
  `packages/sdk/src/tools/coordinator/__tests__/agent.test.ts`
  covering: both-agree-success, run-status-failed-but-state-completed
  (the regression case), and gateway-state-failed.

- 38c4b62: Harden two paths flagged by an adversarial review: `ToolRegistry.searchDeferred` no longer over-activates deferred tools — batched-query tokens match the tool name only (not descriptions) and short/generic tokens like `clawtool` are ignored, so a common word can't activate the whole catalog. The dynamic `Agent` sub-agent now unregisters its per-call `dyn-N` definition in a `finally`, so long sessions don't leak persona registrations on success, failure, or throw.
- a1c6694: **Fix a race when multiple file-mutating tools run in one turn.**

  The tool executor ran every tool call in a batch with `Promise.all`, ignoring each tool's `concurrencySafe` flag. Several `edit`/`write` calls to the same file in one assistant turn therefore raced on read→modify→write — each read the same starting content and the last writer clobbered the others, even though every call reported success. The executor now honors `concurrencySafe`: read-only tools (ls/grep/glob/…) still run in parallel, but concurrency-unsafe tools (edit/write/append/bash) are serialized within the batch, so same-file edits apply one-after-another.

- 63e44f7: Worker `handleExecute` no longer crashes the per-task container when a
  single request body is rejected by `resolveWithinWorkspace` (e.g. a host
  path forwarded as `cwd`) or by the workspace `mkdir`. Each fallible step
  now returns a typed `400` (or a terminal NDJSON `error` event for
  post-headers failures) and the worker stays alive for the next call —
  prior behaviour was an unhandled rejection on the `http.createServer`
  callback, which on Node ≥ 15 exits the process and gives every
  subsequent SDK call the bare `fetch failed` from `UND_ERR_SOCKET`.

  The docker backend's host-side `execViaWorker` and `writeFile` fetches
  now surface `error.cause.code` / `cause.message` instead of the
  stripped `fetch failed`. The bash builtin no longer forwards
  `context.workingDirectory` (a host-side path that has no meaning
  inside the sandbox container) as `cwd`; tools that need a sub-cwd
  inside the sandbox can be added later via an explicit
  `SandboxExecOptions` field.

  The SDK's iteration aggregator now derives
  `ChatCompletionResponse.toolCalls[i].function.arguments` from each
  bucket's parsed input rather than the raw `argsBuf` buffer. When a
  provider stream truncates with `stop_reason: "max_tokens"` mid-
  `input_json_delta`, downstream `JSON.parse` in
  `runtime/query/executor.ts:executeSingle` no longer rejects with the
  generic "Invalid JSON in tool arguments" — the tool runs against the
  empty parsed object and the input zod schema produces a readable
  "<field> is required" error instead.

- 38c4b62: Fix `search_tools` failing to load deferred tools when the model names several at once. `ToolRegistry.searchDeferred` matched the entire query as a single substring, so a batched query like `"A2aCard PeerRegister PeerList"` matched no tool and activated nothing — the subsequent call then failed with "deferred and cannot be executed". The query is now tokenized: a tool matches if its name or description contains the whole phrase OR any single term, so a batch activates each named tool.
- 6b74cd0: **Sub-agents do real work, and tool tracking is keyed on the SDK's tool-use id.**

  - Sub-agents now get the same tool set as the parent — builtins, memory, and clawtool's catalog (deferred, incl. web search/fetch and peer dispatch) — so a delegated research/work task can actually use tools instead of answering from memory alone.
  - The transcript's live tool tracking now matches each call by the SDK's stable `toolUseId` rather than by name/order, so parallel tool calls (even same-named) are attributed correctly.
  - Stronger anti-fabrication instruction for both the main agent and sub-agents: never claim to have run a tool, written a file, or produced a result without actually doing it; if a capability is unavailable, say so instead of inventing output.
  - `@namzu/sdk`: the `Agent` tool's `subagent_type` is now optional when only one sub-agent is registered (defaults to it), so the model can't trip a "subagent_type required" validation error on the common single-sub-agent setup.

## 0.6.0

### Minor Changes

- 1df23b1: `SupervisorAgentConfig` accepts `resumeHandler` and `verificationGate`.

  The supervisor's existing tool-review pipeline (drainQuery's
  `runToolReview` phase) was reachable only by callers that constructed
  `drainQuery` arguments by hand — `SupervisorAgent.run` ignored them
  entirely and always fell back to `autoApproveHandler`. Hosts that
  wanted "Ask before acting" semantics had no way to plug in.

  `SupervisorAgent.run` now forwards both fields verbatim to
  `drainQuery` when the caller supplies them. Behaviour is unchanged
  for callers that omit them — the SDK still defaults to auto-approve.

  Migration:

  ```ts
  new SupervisorAgent({...}).run(input, {
    ...config,
    // surface tool_review_requested events to the user; resolve when
    // they approve / modify / reject.
    resumeHandler: async ({ runId, toolCalls, ... }) => {
      return await waitForUserDecision(runId, toolCalls)
    },
    // optionally pre-classify tools so trivial reads bypass review.
    verificationGate: { enabled: true, rules: [...] },
  })
  ```

## 0.5.0

### Minor Changes

- 2749d32: RunEvent v3 + streaming-only `LLMProvider` (ses_001-tool-stream-events).

  The kernel now emits a per-message and per-tool-input lifecycle on the
  event bus, and the provider contract collapses to a single streaming
  entry point. Together these unlock live tool-call rendering (Calling →
  Running → Done with incremental input) for SSE consumers — the cowork
  workspace surface that motivated the work in the first place.

  ## Breaking changes

  ### `LLMProvider.chat()` removed

  `LLMProvider` exposes a single LLM entry point: `chatStream()`. The
  non-streaming `chat()` method is gone from every shipped provider
  (`@namzu/anthropic`, `@namzu/openai`, `@namzu/bedrock`,
  `@namzu/openrouter`, `@namzu/http`, `@namzu/ollama`,
  `@namzu/lmstudio`).

  Consumers that need an aggregated `ChatCompletionResponse` use the new
  helper:

  ```ts
  import { collect } from "@namzu/sdk";

  const response = await collect(provider.chatStream(params));
  ```

  `collect()` drains the stream and assembles the legacy response shape:
  text concatenated in arrival order, tool calls bucketed by index,
  latest `finishReason` and `usage` win, defaults to `{ finishReason:
'stop', zero usage }` when the provider omits them (defensive against
  SDK quirks like dropped `message_stop` frames).

  The orchestrator consumes the stream directly so it can emit per-delta
  RunEvents — it does NOT call `collect()`.

  ### `RunEvent` envelope `schemaVersion: 2 → 3`

  `RUN_EVENT_SCHEMA_VERSION` is now `3`. The envelope narrows from `2 |
3` to `3`; sub-session lifecycle events stamp `3` automatically via
  `RunEventSchemaVersion`.

  ### `llm_response` removed

  The coarse `llm_response` event is replaced by a message lifecycle:

  - `message_started { runId, iteration, messageId }` — first chunk arrives.
  - `text_delta { runId, iteration, messageId, text }` — per-chunk text.
  - `message_completed { runId, iteration, messageId, stopReason, usage?, content? }` — provider stream closes.

  `message_completed.content` is the aggregated text and is optional —
  consumers that already accumulate `text_delta` themselves can ignore
  it; consumers that only care about the completed message (telemetry,
  A2A bridge) read it directly.

  `stopReason` is the new `MessageStopReason` union: `'end_turn' |
'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal'
| 'forced_finalize'`.

  ### Tool input lifecycle

  Tool calls now traverse a five-event lifecycle keyed by `toolUseId`:

  - `tool_input_started { runId, iteration, messageId, toolUseId, toolName }`
  - `tool_input_delta { runId, toolUseId, partialJson }` — raw fragment
  - `tool_input_completed { runId, toolUseId, input }` — parsed object
  - `tool_executing { runId, toolUseId, toolName, input }` — runtime invokes
  - `tool_completed { runId, toolUseId, toolName, result, isError }` — required `isError`

  `tool_executing` and `tool_completed` payloads tighten: `toolUseId`
  becomes required on both, `isError` becomes required on
  `tool_completed`. The wire-level `tool.error` event is dropped — the
  boolean carries the same signal without ambiguity.

  Probe veto, malformed JSON args, plugin hook errors, and exception
  throws inside `tools.execute()` all now emit a terminal
  `tool_completed { isError: true }` so consumer UI cards can finalise
  instead of being orphaned.

  ### Ephemeral events skip persistence

  `text_delta` and `tool_input_delta` are flagged `isEphemeralEvent()`
  and bypass `transcript.jsonl`. They live only on the in-memory bus
  for live UI rendering. Replay is unaffected (it reads checkpoints,
  not transcripts). The bus has a 1000-event soft cap; under pressure
  the oldest ephemeral is dropped while lifecycle events are preserved.

  ### `StreamChunk.delta.toolCallEnd`

  New optional field signalling per-tool-block boundary closure. The
  orchestrator translates it into `tool_input_completed`. Providers
  that emit a per-tool-block close (Anthropic `content_block_stop` of
  type `tool_use`, Bedrock equivalent) populate it; providers that
  don't fall back to end-of-stream flushing.

  ## Migration

  Most consumers only use the iteration orchestrator's emitted
  `RunEvent` stream. They:

  1. Replace `case 'llm_response':` handlers with a `case
'message_completed':` handler reading `event.content`.
  2. Drop any reads of `event.hasToolCalls` — derive from the
     subsequent absence/presence of `tool_executing` events keyed by
     the same `runId`.
  3. Optional: subscribe to `text_delta` and `tool_input_*` for live
     rendering. The events are interleaved by `toolUseId` to support
     parallel tool calls.

  Consumers calling `provider.chat()` directly:

  ```diff
  - const response = await provider.chat(params)
  + import { collect } from '@namzu/sdk'
  + const response = await collect(provider.chatStream(params))
  ```

  Aggregated response shape is identical.

  ## Internal surface (not externally consumed)

  - `runtime/query/iteration/index.ts` — new `streamProviderTurn()`
    helper, replaces synthesised `message_started`/`message_completed`
    with native streaming. `forced_finalize` path uses `collect()`.
  - `provider/instrumentation.ts` — captures `usage` from the last
    chunk that supplies one (`extractStreamUsage`).
  - `runtime/query/events.ts` — `EventTranslator.emitEvent` skips
    `appendEvent()` for ephemeral events, applies the queue cap.
  - `bridge/sse/mapper.ts` — six new wire types
    (`message.created/delta/completed`,
    `tool.input_started/delta/completed`); `tool.error` removed;
    `tool.executing/completed` carry `tool_use_id` + `is_error`.
  - `bridge/a2a/mapper.ts` — `message_completed.content` routes to A2A
    status update, replacing the per-iteration `llm_response` mapping.

  ## Tests

  SDK suite at 958 (was 943 + new contracts − removed
  `chat()`/`llm_response` invariants). `pnpm typecheck && pnpm lint &&
pnpm test && pnpm build` all green across every package. The
  `@namzu/http` request-construction and response-parsing suites have
  10 tests marked `.skip` pending an SSE-mock rewrite — the streaming
  path is still covered by the existing streaming-suite tests.

## 0.4.5

### Patch Changes

- aead3a8: Doctor registry runtime + 5 built-in checks — ses_007 Phase 4.

  `runDoctor(opts?)` aggregates registered checks into a `DoctorReport` with per-check status + summary + sysexits exit code. `registerDoctorCheck(check)` is the programmatic registration entry point.

  **New runtime exports (12 names):**

  - `doctor` (singleton `DoctorRegistry`), `DoctorRegistry`, `createDoctorRegistry`
  - `registerDoctorCheck(check)` — programmatic registration
  - `runDoctor(opts?)` → `Promise<DoctorReport>`
  - `builtInDoctorChecks` — readonly list of the six shipped checks
  - Six individual built-in checks: `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`, `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

  **LLMProvider interface gains optional `doctorCheck?(): Promise<DoctorCheckResult>`.** Non-breaking — existing providers don't need to implement it. Consumers wanting provider health probes register a custom check that walks `ProviderRegistry.getAll()` and calls `provider.doctorCheck?.()` per provider.

  **Built-in checks ship intentionally conservative for v1.** `sandbox.platform` passes on darwin if `/usr/bin/sandbox-exec` is executable; inconclusive on linux (proc namespace probe deferred); warn on win32; inconclusive elsewhere. `runtime.cwd-writable` + `runtime.tmpdir-writable` are real `fs.access(W_OK)` probes. `telemetry.installed` dynamic-imports `@namzu/telemetry` (specifier-variable to evade TS resolution since SDK doesn't depend on telemetry); pass if installed, inconclusive if not. `vault.registered` + `providers.registered` are intentionally inconclusive with explicit "register your own check" guidance — vault and provider registries are module-private and aren't auto-discoverable from a standalone process.

  **Failure isolation:** a thrown check is recorded as `fail` with the throw message; other checks still run. A check exceeding `perCheckTimeoutMs` (default 5000ms) becomes `inconclusive`. Wall-clock timeout (default 10000ms) marks not-yet-completed checks as `inconclusive`. Status set: `pass | fail | inconclusive | warn`. Only `fail` affects the exit code (1); `inconclusive` and `warn` are informational. Empty registry → exit 2 (no config).

  **Embedded usage today, CLI command in the next patch.** Consumers can `import { runDoctor, registerDoctorCheck } from '@namzu/sdk'` and integrate the doctor in their own process where their checks have already executed. The standalone `namzu doctor` CLI command lands in the next patch (Phase 5).

- 8f076e5: ses_007 Phase 5 — doctor runtime moved from `@namzu/sdk` to `@namzu/cli`. Architectural pivot: kernel = SDK (pure runtime primitives), operator surface = CLI (presentation + tooling).

  ## Breaking changes — `@namzu/sdk`

  The following 12 runtime exports have been **removed** from `@namzu/sdk`. They now live in `@namzu/cli`:

  - `doctor` (singleton), `DoctorRegistry`, `createDoctorRegistry`
  - `registerDoctorCheck`, `runDoctor`
  - `builtInDoctorChecks`
  - `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`
  - `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

  The `RunDoctorOptions` type has also been removed from `@namzu/sdk` exports.

  **What stays in `@namzu/sdk`:**

  - The protocol types — `DoctorCheck`, `DoctorCheckResult`, `DoctorCheckContext`, `DoctorCheckRecord`, `DoctorReport`, `DoctorStatus`, `DoctorCategory` — remain in `types/doctor/` so kernel components can implement custom checks against them.
  - `LLMProvider.doctorCheck?(): Promise<DoctorCheckResult>` — the kernel hook that lets a provider expose its own healthcheck stays on the interface.

  ## Migration

  If you were calling the doctor in your own process:

  ```diff
  - import { runDoctor, registerDoctorCheck } from '@namzu/sdk'
  + import { runDoctor, registerDoctorCheck } from '@namzu/cli'
  ```

  If you were running it from the command line:

  ```bash
  # Before — required a custom CLI bin or `pnpm dlx tsx packages/sdk/src/doctor/...`
  # After:
  pnpm dlx @namzu/cli doctor
  # or, after install: namzu doctor
  ```

  Custom check authors continue to import the protocol types from `@namzu/sdk`:

  ```ts
  import type { DoctorCheck, DoctorCheckResult } from "@namzu/sdk";
  import { registerDoctorCheck } from "@namzu/cli";

  const myCheck: DoctorCheck = {
    id: "app.db.reachable",
    category: "custom",
    run: async (): Promise<DoctorCheckResult> => {
      // your probe
    },
  };
  registerDoctorCheck(myCheck);
  ```

  ## New — `@namzu/cli` (initial public release)

  `@namzu/cli` v0.1.0 ships as a public package for the first time. Dual-purpose:

  - **Standalone bin** — `npx @namzu/cli doctor`, or after install: `namzu doctor`. Supports `--json`, `--verbose`, `--category <a,b,c>`, `--per-check-timeout <ms>`, `--wall-clock-timeout <ms>`. Sysexits-aligned exit codes (`0` ok, `1` fail, `2` no config, `70` internal error).
  - **Library** — `import { runDoctor, registerDoctorCheck, builtInDoctorChecks } from '@namzu/cli'` for embedded usage where consumer code wants to invoke the doctor in its own process so app-registered checks are visible.

  **What ships built-in:**

  - `sandbox.platform` (darwin sandbox-exec presence + win32 warn + linux/other inconclusive)
  - `runtime.cwd-writable` + `runtime.tmpdir-writable` (real `fs.access(W_OK)` probes)
  - `telemetry.installed` (dynamic-import probe for `@namzu/telemetry`)
  - `vault.registered` + `providers.registered` (intentionally inconclusive — consumers register their own walking their setup)

  **Why patch-bump-equivalent:** `@namzu/sdk: minor` carries the breaking removal (pre-1.0 cadence); `@namzu/cli: minor` carries the new package's first feature release. Together they make the next release a coordinated cut.

## 0.4.4

### Patch Changes

- ffe516c: Probe layer (typed observation + narrow veto) over AgentBus + RunEvent stream — ses_007 phases 0–3.

  Public surface additions:

  - **Typed probe observation.** `probe.on(kind | kind[], handler, opts?)` registers a typed handler scoped to one or more event kinds. `probe.onAny(handler, opts?)` is the catch-all tier preserving legacy `AgentBus.on` semantics. Options: `{ where, priority, name, override }`. Events are frozen at the registry boundary; throws are isolated per probe.
  - **Narrow veto on tool execution.** `probe.veto('tool_executing', handler, opts?)` registers a veto handler. Handler returns `'allow' | 'deny' | { action: 'deny', reason }`. `VetoableEventKind = 'tool_executing'` in v1 (additive minor adds more kinds later). First-deny wins by ascending priority; subsequent veto handlers still fire for audit. Tool executor short-circuits before `tools.execute(...)` on deny: returns a synthetic tool failure carrying `ProbeVetoError.message` so the LLM sees a normal tool-call failure with the probe name + reason.
  - **5 new bus event variants.** `provider_call_start`, `provider_call_completed`, `provider_call_failed`, `vault_lookup`, `sandbox_decision`. Joined to the existing `AgentBusEvent` discriminated union. Snake_case real discriminants — no rename pass on existing events.
  - **Opt-in instrumentation wrappers.** `wrapProviderWithProbes(provider, opts?)` returns an `LLMProvider` that emits `provider_call_*` around every `chat`/`chatStream` call (correlated by a `pcall_${string}` callId, with optional usage telemetry). `wrapVaultWithProbes(vault, opts?)` emits `vault_lookup` on every `retrieve()`; the secret value is never included in the event payload (covered by a "no leakage" test).
  - **First-time public exposure of bus event types.** `AgentBusEvent`, `AgentBusEventListener`, `CircuitBreakerSnapshot`, `FileLock`, etc. were already reachable via `AgentBus.on(listener)` at runtime but couldn't be statically typed by consumers. Now in `public-types.ts`. Pre-existing duplicate `LockId` declaration in `types/bus/` was deduplicated to a re-export from `types/ids/` in passing.
  - **Replay-aware probe context.** `ProbeContext.isReplay: boolean` flag wired through `buildProbeContext({ runId?, isReplay? })` so probes that bill or call external services can opt out on replayed runs (`ctx.isReplay === true`). Replay-execution wiring lands in a future session; the accessor is ready.

  Integration:

  - `AgentBus.emit` dispatches through `ProbeRegistry` first (typed-priority probes → legacy `bus.on` listeners → `onAny` catch-all). Existing `bus.on(listener)` consumers see every event in unchanged relative order.
  - `EventTranslator.emitEvent` dispatches every `RunEvent` through the same registry before the existing pendingEvents push + persist flow.
  - `ToolExecutor.executeSingle` calls `probes.queryVeto({type: 'tool_executing', ...})` immediately after the existing `tool_executing` emit, before `tools.execute(...)`.

  Not yet wired (follow-up commits):

  - Per-run probes via `createRun({ probes: [...] })` — the registry has the foundation; createRun plumbing lands in a follow-up.
  - `wrapProviderWithProbes` / `wrapVaultWithProbes` are opt-in helpers; the SDK's own `ProviderRegistry` does not auto-wrap registered providers yet.
  - `sandbox_decision` ships as a type only; emit site lands when a real sandbox provider exists (current `LocalSandboxProvider` is a stub).

  Public surface delta: `380 → 392` runtime keys (verified against the regenerated baseline). Net new symbols added by this changeset:

  - `probe`, `ProbeRegistry`, `createProbeRegistry`, `buildProbeContext`, `ProbeNameCollisionError`, `ProbeVetoError`
  - `wrapProviderWithProbes`, `wrapVaultWithProbes`

  Non-runtime (types-only) additions: `ProbeEventKind`, `ProbeEventOf<K>`, `ProbeContext`, `ProbeHandler<K>`, `ProbeOptions<K>`, `Unsubscribe`, `VetoableEventKind`, `VetoDecision`, `VetoHandler<K>`, `VetoOutcome`, `DoctorStatus`, `DoctorCategory`, `DoctorCheck`, `DoctorCheckContext`, `DoctorCheckResult`, `DoctorCheckRecord`, `DoctorReport`, `ProviderCallId`, `ProviderCallUsage`, `SandboxDecisionAction`, plus first-time exposure of all `AgentBusEvent` shape types.

  Doctor types ship in this release; the runtime registry + CLI command land in a subsequent ses_007 patch.

## 0.4.3

### Patch Changes

- ddd0aad: Test-side hardening from ses_006 pre-freeze fix.

  - **New test: `runtime/query/iteration/phases/advisory.test.ts`** — pins the advisory-phase mutation boundary where fired advisories inject user messages via `runMgr.pushMessage(createUserMessage(...))`. 13 assertions covering early-return paths, happy-path exactly-once calls, envelope format, warnings + decisions rendering, and trigger-selection semantics. Before this test a regression removing the `pushMessage` call at `advisory.ts:154` would pass typecheck, lint, the coverage gate, and every existing `src/advisory/*` test. It now fails deterministically.
  - **`LogLevel` gains `'silent'`** — purely additive; the value short-circuits every `log()` call. Used by the SDK's vitest setup to suppress unmocked `getRootLogger()` stderr writes so GitHub Actions stops annotating `[ERROR]`-level log lines as workflow errors. Consumer impact: zero unless you pass `'silent'` to `configureLogger()` yourself.
  - No runtime behavior change. No public surface additions beyond the one `LogLevel` union member.

## 0.4.2

### Patch Changes

- 14ff062: Public-surface barrel split (ses_011-sdk-public-surface).

  **Note on bump level.** Originally classified as minor when ses_011 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset explicitly preserved all 380 pre-existing public names (verified by `.github/scripts/verify-public-surface.mjs`), so patch is semver-accurate at the name-set level. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

  `packages/sdk/src/index.ts` splits from 357 lines of mixed re-exports into three focused bucket files, consumed through a thin 10-line root barrel:

  - **`public-types.ts`** — every type a consumer type-checks against (branded IDs, wire shapes, domain entities, store contracts, event unions, config types).
  - **`public-runtime.ts`** — every runtime value (classes, functions, constants, zod schemas, error classes, ID generators).
  - **`public-tools.ts`** — agent-tool surface (`defineTool` primitive, built-in tools, domain builders, connector tool bridge, `createRAGTool`).

  No consumer-visible change. All 380 previously-exported names continue to be exported; none removed, none added. Verified by a baseline snapshot (`.github/scripts/public-surface-baseline.json` — captured at the tip of ses_010) plus a CI smoke test (`.github/scripts/verify-public-surface.mjs`) that loads `@namzu/sdk` at runtime and compares `Object.keys()` against the baseline.

  Additional cleanup:

  - The `ProjectId` / `RunId` / `MessageId` / `SessionId` double-channel (reachable through both `contracts/` and `types/ids/`) is closed. IDs come from `types/ids/` uniformly; `contracts/ids.ts` is deleted; `contracts/api.ts` imports IDs from `../types/ids/` directly.
  - The `RunStatus` carve-out is folded. Since ses_010 renamed the wire-side alias to `WireRunStatus`, the domain `RunStatus` can flow through `types/run/index.ts` with a plain `export *` — no explicit carve-out needed.

- 2eccadd: Replay primitive v1 — fork an existing run from any stored checkpoint with optional mutation at the fork point (ses_005-deterministic-replay).

  **Note on bump level.** This release adds new public exports (`prepareReplayState`, `listCheckpoints`, `projectEmergencyToCheckpoint`, `MutationNotApplicableError`, the `Mutation` / `CheckpointListEntry` / `ReplayAttribution` types, `Run.replayOf?`). In strict semver these would be a minor bump. Classified as patch here because the SDK is pre-1.0 and the project reserves minor/major for larger feature deltas — 0.5.0 should land with a more complete replay surface (5b end-to-end wrapper, reproduce mode, or similar) rather than just this state-preparation half. Decision logged 2026-04-21 post-freeze of ses_005.

  New public runtime values:

  - **`prepareReplayState({ baseDir, runId, fromCheckpoint, mutate?, emergencyDir? })`** — pure-read helper that resolves `fromCheckpoint` (`CheckpointId | 'latest' | 'emergency'`), applies mutations, and returns `{ messages, sourceCheckpoint, attribution }` ready to thread into a `query(...)` call.
  - **`listCheckpoints({ baseDir, runId })`** — lists a run's checkpoints as lightweight `CheckpointListEntry` projections.
  - **`projectEmergencyToCheckpoint(dump)`** — project an `EmergencySaveData` snapshot to an `IterationCheckpoint` shape with deterministic `cp_emergency_*` id.
  - **`MutationNotApplicableError`** — thrown by `prepareReplayState` when a mutation targets a tool call that is not pending at the fork point; carries `availableToolCallIds` for recovery.

  New public types:

  - **`Mutation`** — discriminated union; single `injectToolResponse` variant in v1.
  - **`CheckpointListEntry`** — listing projection distinct from the pre-existing HITL `CheckpointSummary`.
  - **`ReplayAttribution`** — `{ sourceRunId, fromCheckpointId, mutations, replayedAt }` record.
  - **`Run.replayOf?: ReplayAttribution`** — optional attribution field; `undefined` on original runs.

  Scope and non-scope — v1 ships **forked execution from a captured checkpoint, not byte-for-byte reproduction**. Past the fork point, provider calls and tool calls execute live. Deterministic reproduce mode is deferred to a follow-up session.

  A single-call `replay({ runId, opts })` wrapper is intentionally not shipped in v1. Composing `listCheckpoints → prepareReplayState → caller-owned query()` is the v1 flow; the wrapper requires a `ReplayEnvironment` design (provider, tools, resume handler, session scope) that lands in a follow-up session.

  See `docs/sdk/runtime/replay.md` for the full primitive docs, determinism envelope, and non-scope.

- 9efae03: Type layering rationalised (ses_010-sdk-type-layering).

  **Note on bump level.** Originally classified as minor when ses_010 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset introduced no consumer-visible new names and renamed `AgentRun → Run` with a `@deprecated` alias, which the policy treats as a patch-level churn for 0.x. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

  All pure shapes — entities, store contracts, wire types, events — now live under `packages/sdk/src/types/`. Feature folders (`session/`, `manager/`, `store/`, `agent/`, `provider/`) contain runtime code only.

  **Public surface changes:**

  - `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` are kept as `@deprecated` type aliases for the 0.4.x compatibility window — existing code importing either continues to compile. New code should use `Run`.
  - Wire-side `Run` interface renamed to `WireRun`, mirroring the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` and wire `WireRun` with no collision.
  - Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the old path no longer exists.

  No runtime behaviour change. Every entity previously exported (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk`.

## Unreleased

### Minor Changes

- ses_010-sdk-type-layering: Type layering rationalised. All pure shapes (entities, store contracts, wire types, events) now live under `packages/sdk/src/types/`; feature folders under `session/`, `manager/`, `store/`, `agent/`, `provider/` contain runtime code only.

  Public surface changes:

  - `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` remain as `@deprecated` type aliases for the 0.4.x compatibility window; consumers importing either keep compiling. New code should use `Run`.
  - The wire-side `Run` interface at `contracts/api.ts` renamed to `WireRun` — mirrors the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` (from `types/run/`) and wire `WireRun` (from `contracts/`) with no same-symbol collision.
  - Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the path no longer exists.

  No change to runtime behaviour. Every entity shape that used to live under `session/hierarchy/` (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk` — only the internal folder structure moved.

## 0.4.1

### Patch Changes

- c9b180d: Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

  Resulting versions:

  - `@namzu/sdk` → `0.4.1`
  - `@namzu/telemetry` → `0.1.1`
  - `@namzu/computer-use` → `0.2.1`
  - `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`

## 0.4.0

### Minor Changes

- 96e3f84: **BREAKING**: OpenTelemetry SDK and exporters extracted to `@namzu/telemetry`. `zod` and `zod-to-json-schema` moved to `peerDependencies`. `@opentelemetry/api` moved to `peerDependencies`.

  All removed exports have a replacement in `@namzu/telemetry`:

  | Removed                                    | Import from `@namzu/telemetry`             |
  | ------------------------------------------ | ------------------------------------------ |
  | `TelemetryProvider`                        | `TelemetryProvider`                        |
  | `initTelemetry` (sync)                     | `registerTelemetry` (async — **await it**) |
  | `getTelemetry`, `getTracer`, `getMeter`    | same names                                 |
  | `createPlatformMetrics`, `PlatformMetrics` | same names                                 |
  | `TelemetryConfig`, `ExporterType`          | same names                                 |
  | `GENAI`, `NAMZU`, span-name helpers        | `@namzu/telemetry/attributes` subpath      |

  Install-surface delta: `@namzu/sdk` runtime deps 10 → 0. Consumers who don't emit telemetry and don't use Zod directly install 0 extra packages from the SDK tree. See [`docs/migration/0.4.md`](https://github.com/cogitave/namzu/blob/main/docs/migration/0.4.md) for the full upgrade path.

  Related: `@namzu/telemetry@0.1.0` initial publish ships in the same release.

## 0.3.0

### Minor Changes

- 40eb841: Unblock BYO-provider use of `AgentManager.spawn` and capture the full 0.2.x → 0.3.0 window.

  **Bug Fixes**

  - `AgentManager.sendMessage` no longer requires both `configBuilder` AND `factoryOptions` together. The configBuilder now runs whenever it is registered; `factoryOptions` defaults to `{}` when absent. This closes the silent crash path that consumers following README's "getting started" install hit with Bedrock (ERESOLVE → bare-config → ReactiveAgent null access).
  - `AgentFactoryOptions.apiKey` is now optional. BYO-provider flows (Bedrock IAM, custom `ProviderRegistry.create(...)`) no longer need to fabricate a meaningless empty `apiKey` just to satisfy the type.

  **Breaking Changes carried over from the 0.2.x → 0.3.0 window**

  - `feat(sdk)!: propagate threadId through runtime + wire archive gate` — childConfig now receives `sessionId/threadId/projectId/tenantId` automatically from the parent context (stamped by AgentManager after configBuilder returns). configBuilder implementations that previously emitted these fields manually are unaffected; implementations relying on the old 0.2.0 three-ID triple (`sessionId/projectId/tenantId` without `threadId`) will now see `threadId` populated on the child config.

  **Other**

  - `knip` integrated as the dead-code detector (dev-only, no runtime surface change).
  - `ThreadManager.archive`/`delete` primitives added to `SessionStore`; wire-side `thread_id` renamed during the Thread→Project wire refactor (internal rename).

  See commits since `sdk-v0.2.0` for the full list; this changeset captures the visible-to-consumer summary.

All notable changes to Namzu are documented here.

## [0.2.0] — 2026-04-17

### Features

- **sdk**: close Task 10 known deltas + expose session hierarchy (Phase 9) [**BREAKING**]
- **sdk**: add retention + archival primitives with deleteSession close-out (Phase 8)
- **sdk**: add migration utilities for 0.2.0 upgrade path (Phase 7)
- **sdk**: refactor AgentManager to spawn SubSession triple with kernel summarization (Phase 6) [**BREAKING**]
- **sdk**: add SessionSummaryMaterializer kernel terminalization primitive (Phase 5)
- **sdk**: add handoff state machine with atomic broadcast rollback (Phase 4)
- **sdk**: add SessionStore + PathBuilder + git-worktree workspace driver (Phase 3) [**BREAKING**]
- **sdk**: add RunEvent schemaVersion + sub-session lifecycle events (Phase 2) [**BREAKING**]
- **sdk**: introduce session hierarchy type foundation (Phase 1) [**BREAKING**]

### Testing

- **sdk**: add Task 10 integration test coverage matrix (Phase 10)

## [0.1.8] — 2026-04-15

### Documentation

- **changelog**: update for sdk-v0.1.7
- **readme**: rewrite root + fix sdk stale ProviderFactory refs

## [0.1.7] — 2026-04-15

### Documentation

- **changelog**: add 0.1.6 (sdk) and 0.1.0 (computer-use) entries; fix cliff tag prefix + workflow race
- **changelog**: update for sdk-v0.1.6-rc.1

### Features

- **bedrock**: extract BedrockProvider to @namzu/bedrock package (Phase I.3 pilot)
- **openrouter**: extract OpenRouterProvider to @namzu/openrouter package (Phase I.4)

### Refactor

- **sdk**: address Codex review — scope providers/ subfolder, hide registry reset
- **sdk**: replace ProviderFactory with ProviderRegistry for per-vendor extraction [**BREAKING**]

## [0.1.6-rc.1] — 2026-04-15

### Documentation

- **changelog**: update for v0.1.5

### Features

- **sdk**: add ComputerUseHost interface and computer_use tool

### Miscellaneous

- initialize namzu monorepo from sdk; add @namzu/computer-use capability package

## [0.1.5] — 2026-04-15

### Bug Fixes

- **emergency**: uuid tmp suffix, outer try/catch, and explicit exit
- **store**: resolve withLock race, delete deadlock, and atomic edge updates

### Documentation

- **changelog**: update for v0.1.5-rc.2

### Refactor

- **barrels**: route root barrel through sub-barrels (Path B)
- **connector**: brand ConnectorId/TenantId on public interfaces [**BREAKING**]

### Testing

- **store**: add concurrency regression tests for DiskTaskStore

## [0.1.5-rc.2] — 2026-04-14

### Bug Fixes

- **plugin**: wire MCP servers and fail fast on unsupported contributions
- **plugin**: consume hook results and wire tool hooks in runtime
- **release**: normalize pre-release counter to strip non-digit suffix

### Documentation

- **changelog**: update for v0.1.5-rc.1-fix
- **contracts**: formalize wire/domain duality + refresh README
- **readme**: rewrite code examples to match current SDK API

### Refactor

- **plugin**: remove duplicate PluginConfigSchema in types/
- **registry**: migrate Agent/Connector/Tool registries to ManagedRegistry
- **run**: remove legacy Session\* aliases for run-centric classes

## [0.1.5-rc.1] — 2026-04-12

### Documentation

- **changelog**: update for v0.1.4

### Refactor

- architectural cleanup and infrastructure improvements

## [0.1.4] — 2026-04-11

### Documentation

- **changelog**: update for v0.1.4-rc.3

### Features

- sandbox isolation, new tools (edit/grep/ls), session-to-run migration

## [0.1.4-rc.3] — 2026-04-10

### Miscellaneous

- **release**: derive version from git tag, no manual bump needed

## [0.1.4-rc.2] — 2026-04-10

### Bug Fixes

- **ci**: remove duplicate --strip flag in git-cliff command
- **plugin**: rename session hooks to run_start/run_end
- **release**: use tag name as release title instead of prefixed name

### Features

- P3 + plugin architecture — emergency save, memory index, plugin system
- P2 — AgentBus, prompt cache split, verification gate
- integrate compaction loop and advisory phase into iteration pipeline

### Miscellaneous

- **changelog**: automate CHANGELOG.md via git-cliff in release workflow

## [0.1.4-rc.1] — 2026-04-10

### Bug Fixes

- add description field to package.json, reorder README badges

### Features

- **advisory**: provider-agnostic advisory system with three-layer architecture
- structured compaction, tool tiering, task router
- output discipline, shell compression, pre-release workflow

### Miscellaneous

- remove BEFORE-RELEASE.md from repo

## [0.1.3] — 2026-04-10

### Bug Fixes

- point entry fields to dist/ for bundler compatibility

### Documentation

- add npm, ci, license, typescript, node badges to README

## [0.1.2] — 2026-04-10

### Other

- Namzu v0.1.1 — Wisdom, shared

Open-source AI agent framework by cogitave.

Let's build the agent layer together.

### Refactor

- constants centralization, strict lint, release automation
