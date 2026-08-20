import { join } from 'node:path'
import {
	AdvisorRegistry,
	AdvisoryContext,
	AdvisoryExecutor,
	TriggerEvaluator,
	assertBudgetEnforceable,
} from '../../advisory/index.js'
import { drainQueuedMessages } from '../../agents/handle.js'
import { AuthorizationGate } from '../../authorization/gate.js'
import {
	type ToolHistoryRepairReport,
	repairToolMessageHistory,
	toolHistoryRepairChanged,
} from '../../compaction/dangling.js'
import { extractFromUserMessage } from '../../compaction/extractor.js'
import { WorkingStateManager } from '../../compaction/manager.js'
import type { ContextReducer } from '../../compaction/reducer.js'
import { serializeState as serializeWorkingState } from '../../compaction/serializer.js'
import { restoreWorkingState, snapshotWorkingState } from '../../compaction/wire.js'
import type { CompactionConfig } from '../../config/runtime.js'
import { BOOT_EVENT_NAMES } from '../../constants/telemetry/index.js'
import { TOOL_OUTPUT_DIR_NAME } from '../../constants/tools/index.js'
import { EmergencySaveManager } from '../../manager/run/emergency.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { resolveModelPricing } from '../../pricing/index.js'
import { resolveProviderCapabilities } from '../../provider/capabilities.js'
import {
	type ProviderChainMember,
	type ServingMember,
	withProviderFallback,
} from '../../provider/fallback.js'
import { resolveStreamIdleTimeoutMs, withStreamIdleTimeout } from '../../provider/idle-timeout.js'
import { type ProviderRetryConfig, withProviderRetry } from '../../provider/retry.js'
import { DefaultFilesystemMigrator, loggingMigrationSink } from '../../session/migration/index.js'
import type { PathBuilder } from '../../session/workspace/path-builder.js'
import { resolveAttachments } from '../../store/attachment/index.js'
import {
	GENAI,
	NAMZU,
	agentRunSpanName,
	parentContext,
	serializeSpan,
} from '../../telemetry/attributes.js'
import { recordRunDuration } from '../../telemetry/metrics.js'
import { getTracer } from '../../telemetry/runtime-accessors.js'
import { buildAdvisoryTools } from '../../tools/advisory/index.js'
import { SearchToolsTool } from '../../tools/builtins/search-tools.js'
import {
	STRUCTURED_OUTPUT_TOOL_NAME,
	createStructuredOutputTool,
} from '../../tools/builtins/structuredOutput.js'
import { buildTaskTools } from '../../tools/task/index.js'
import type { AdvisoryConfig } from '../../types/advisory/index.js'
import type { AgentRuntimeContext, RuntimeToolOverrides } from '../../types/agent/base.js'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import type { WorkingMemoryProvider } from '../../types/agent/working-memory.js'
import type { AuthorizationGateConfig } from '../../types/authorization/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { InputGuardrailSpec, OutputGuardrailSpec } from '../../types/guardrail/index.js'
import {
	type CheckpointId,
	type HITLResumeDecision,
	type ResumeHandler,
	autoApproveHandler,
} from '../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import {
	type AssistantMessage,
	type Message,
	createSystemMessage,
} from '../../types/message/index.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { TaskRouterConfig } from '../../types/router/index.js'
import type { ReviewAnswer } from '../../types/run/answer-review.js'
import type { CheckpointStore, FencingToken } from '../../types/run/checkpoint-store.js'
import type { RunEventCursor, RunEventReplay } from '../../types/run/event-cursor.js'
import { resolveRunEventReplay } from '../../types/run/event-cursor.js'
import type {
	AgentRunConfig,
	BeforeStep,
	PrepareStepChain,
	Run,
	RunEvent,
	RunEventListener,
	StepResult,
	StopCondition,
} from '../../types/run/index.js'
import type { PromoteMemory } from '../../types/run/memory-promotion.js'
import { memoryCandidateFor } from '../../types/run/memory-promotion.js'
import type { RunStore } from '../../types/run/store.js'
import type { Sandbox, SandboxProvider } from '../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type { Skill } from '../../types/skills/index.js'
import type { StructuredOutputConfig } from '../../types/structured-output/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { RepairToolCall } from '../../types/tool/repair.js'
import type { BackoffPolicy } from '../../utils/backoff.js'
import type { ModelPricing } from '../../utils/cost.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateRunId } from '../../utils/id.js'
import { errorAttributes } from '../../utils/log/exception.js'
import { EVENT_NAME_ATTRIBUTE } from '../../utils/log/types.js'
import type { Logger } from '../../utils/logger.js'
import type { BackgroundJobRegistry } from '../jobs/registry.js'
import { AUTO_APPROVE_POLICY_NAME, createRunApprovalPolicy } from './approval-policy.js'
import { CheckpointManager } from './checkpoint.js'
import { RunContextFactory } from './context.js'
import { EventTranslator } from './events.js'
import { GuardCoordinator } from './guard.js'
import { runInputGuardrails, runOutputGuardrails } from './guardrails.js'
import { IterationOrchestrator } from './iteration/index.js'
import { isCompactionMessage } from './iteration/phases/compaction.js'
import { isWorkingMemoryMessage } from './iteration/phases/working-memory.js'
import { applyLifecycleHookResults } from './plugin-hooks.js'
import type { PromptCache } from './prompt-cache.js'
import { PromptBuilder } from './prompt.js'
import type { PromptSegments } from './prompt.js'
import { PendingAnswers, QuestionParkBinding } from './question-park.js'
import { RepeatCallTracker } from './repeat-call.js'
import { resolveMaxRequestRichContentBytes } from './request-rich-content.js'
import { ResultAssembler } from './result.js'
import {
	type PendingResumePlan,
	applyPendingResume,
	planCrashResume,
	planPendingResume,
	recoverCompletedCalls,
	unansweredToolCalls,
} from './resume-pending.js'
import type { SteeringChannel } from './steering.js'
import { ToolGrantSet } from './tool-grants.js'
import { createToolPause } from './tool-pause.js'
import { ToolingBootstrap } from './tooling.js'

export interface QueryParams {
	/**
	 * Notice when the model issues the identical tool call repeatedly, and
	 * say so on the next `tool_result`. Defaults on.
	 *
	 * `false` removes the tracker entirely rather than gating a branch, so
	 * an opted-out run produces byte-identical messages to one from before
	 * this existed.
	 */
	repeatCallAdvisory?: boolean

	/**
	 * Tool names this run may not use, subtracted from its effective list.
	 * See {@link import('../../types/agent/base.js').BaseAgentConfig.deniedTools}.
	 */
	deniedTools?: readonly string[]

	systemPrompt?: string
	persona?: AgentPersona
	skills?: Skill[]
	basePrompt?: string
	provider: LLMProvider
	/**
	 * Transient-failure policy for model calls. A single 429 or 503 used to
	 * terminate a run outright — no driver in the estate retries. Defaults
	 * to {@link DEFAULT_PROVIDER_RETRY}; pass `false` to opt out (e.g. when
	 * the host already wraps the provider with its own policy).
	 *
	 * Only failures that happen BEFORE the first content chunk are retried;
	 * see `withProviderRetry`.
	 */
	retry?: Partial<ProviderRetryConfig> | false

	/**
	 * Members to fall over to, in order, when {@link provider} cannot serve.
	 *
	 * Absent means what it always meant: one provider, no failover. Each member
	 * is tried at most once per call and the chain never rewinds, so the scope
	 * of a swap is this `query()` — for a host whose call is one user turn, that
	 * is turn scope with no reset to forget. See `withProviderFallback`.
	 *
	 * Two things this does NOT do, both deliberate. Capabilities are negotiated
	 * once against {@link provider}, so a member that declares less will be sent
	 * a request shaped for the head — refuse a disagreeing chain before you
	 * build one. And a fallback loses the prompt cache: the replacement provider
	 * has never seen this conversation, so the turn re-reads its whole context
	 * at full price.
	 */
	fallbackProviders?: readonly ProviderChainMember[]

	/**
	 * Install process-level crash handlers that dump this run's state to
	 * `<runDir>/../emergency/<runId>.json` on SIGINT, SIGTERM or an
	 * uncaught exception. `replay({ fromCheckpoint: 'emergency' })` reads
	 * that file.
	 *
	 * **Off by default, and it must stay that way.** `attach` registers
	 * `process.on(...)` handlers that call `process.exit()`. A library
	 * seizing a host's termination path is an overreach in any embedded
	 * context (an API server has its own drain sequence), and the manager
	 * is a singleton whose `attach` detaches whoever held it before — so
	 * with concurrent runs the last one to start would silently become the
	 * only one that gets saved.
	 *
	 * Turn it on for a process the run owns end-to-end: a CLI, a worker
	 * that handles one run at a time. The handlers are removed when the
	 * run settles.
	 */
	emergencySave?: boolean

	/**
	 * Durability for questions raised by a tool that closed over its
	 * binding before the run existed.
	 *
	 * The built-in `ask_user_question` is built with the agent's tool
	 * registry, so only whoever builds the tools can hand it one — that is
	 * what lets a single tool instance be durable inside a run and inert
	 * outside one. Without it, THAT tool's park is only a suspended
	 * `await`: kill the process while somebody is looking at the card and
	 * the answer can never be applied.
	 *
	 * Not required for `ToolContext.requestPause`. The run builds that
	 * seam per call and binds its own recorder when none is passed, so a
	 * pause raised from a host-authored tool is durable on every surface
	 * rather than only on the one agent class that supplies this.
	 */
	questionParks?: QuestionParkBinding

	/**
	 * Channel a host uses to hand guidance to the running turn.
	 *
	 * Optional and additive: absent leaves the loop byte-identical. Present,
	 * anything queued during a tool batch is appended to that batch's last
	 * tool result — the only slot a provider will accept text in mid-batch,
	 * and the one the model already reads for tool outcomes.
	 */
	steering?: SteeringChannel

	/**
	 * The registry a re-entered `ask_user_question` reads its answer from.
	 *
	 * Same shape, same reason and same limit as {@link questionParks}: it
	 * exists for a tool that closed over the instance before the run did,
	 * and without it a resumed run re-asks that tool's question. A pause
	 * from `ToolContext.requestPause` needs none, because the run fills
	 * its own on the resume path.
	 */
	pendingAnswers?: PendingAnswers

	/** Default per-tool execution deadline. See {@link ToolDefinition.timeoutMs}. */
	toolTimeoutMs?: number
	/**
	 * Where background jobs this run starts are held, and killed.
	 *
	 * Host-owned so it can outlive one run — a registry built per run could
	 * never be the thing that kills a run's jobs when the run is already
	 * gone. This run's jobs are torn down in the `finally` below; another
	 * run's are untouched. The registry launches host processes, so a run
	 * that also supplies a {@link sandboxProvider} does not expose it to tools:
	 * background execution is refused rather than silently bypassing the sandbox.
	 */
	backgroundJobs?: BackgroundJobRegistry

	/**
	 * What else goes in this run's prompt.
	 *
	 * `static` and `dynamic` contributions reach the system prompt through
	 * `PromptBuilder`; `turn` contributions reach the ephemeral trailing
	 * message once per iteration. A host registers once and the placement
	 * decides where it lands.
	 */
	promptContributions?: import('../../prompt/contributions.js').PromptContributionRegistry

	/**
	 * Where the `skill` tool loads from.
	 *
	 * Separate from `skills`, which is the LIST that goes in the prompt
	 * manifest. A run can have the manifest without the tool — that is what
	 * every run did before the tool existed — and the two are wired
	 * independently on purpose: a host may want the guidance visible without
	 * granting a way to pull bodies in mid-run.
	 */
	skillRegistry?: import('../../types/tool/index.js').SkillRegistryRef

	/**
	 * Where a message's stored attachments are resolved from.
	 *
	 * Absent is fine for every run whose attachments are inline, which is
	 * every run that existed before this. A message carrying a ref with no
	 * store REFUSES rather than dropping the attachment.
	 */
	attachmentStore?: import('../../store/attachment/index.js').AttachmentStore

	/**
	 * How this run reaches the web.
	 *
	 * `fetch` and `search` are independent, and this kernel ships only the
	 * first — see `connector/web` for why choosing a search backend here
	 * would choose it for every consumer.
	 */
	web?: import('../../types/tool/index.js').ToolContext['web']

	/**
	 * Wait between in-loop retries of a failed tool call, with full jitter.
	 * Defaults to {@link DEFAULT_TOOL_RETRY_BACKOFF}.
	 *
	 * Only reached by a tool that opted into retrying
	 * ({@link ToolDefinition.maxRetries}) or a `post_tool_use` hook that asked
	 * for one. Set `initialDelayMs: 0` for the retry-immediately behaviour
	 * this loop had before it had any backoff at all.
	 */
	toolRetryBackoff?: Partial<BackoffPolicy>

	/** Max concurrently-executing concurrency-safe tools in one batch. */
	maxToolConcurrency?: number

	/**
	 * Model-visible size cap for a single tool result. Over-budget output is
	 * spilled to the run directory and replaced with a head+tail preview
	 * naming the path, so nothing is lost and tokens are paid only if the
	 * agent decides the rest is worth re-reading. Set `0` to disable.
	 */
	maxToolOutputChars?: number

	/**
	 * Cap on the RICH channel of a single tool result, in base64 characters.
	 * `0` or absent disables it. Separate from {@link maxToolOutputChars}:
	 * that one bounds characters the model reads, this one bounds the image
	 * payload beside them, which no text budget ever touched.
	 */
	maxToolContentBytes?: number

	/**
	 * Last chance to fix a tool call the model got wrong, before the error
	 * reaches it.
	 *
	 * A malformed call costs a full round trip otherwise: the error goes
	 * back as a `tool_result`, the model re-reads the entire context, and
	 * issues a second inference to add a missing brace. A host that can
	 * repair the arguments locally — a cheap model handed the schema, or
	 * plain string surgery — turns that into nothing.
	 *
	 * See {@link RepairToolCall}. Declining is normal and cheap: the
	 * original error simply proceeds to the model as before.
	 */
	repairToolCall?: RepairToolCall

	/**
	 * Programmable halt condition, evaluated after each step's tools have
	 * run so a predicate can see what they returned.
	 *
	 * Before this the only halt was `GuardCoordinator`, which sees four
	 * numeric budgets and never the messages — so a terminal
	 * `submit_answer` tool could not end a run, and the model had to be
	 * prompt-begged to stop with `maxIterations: 200` as the only backstop.
	 *
	 * Helpers: `stepCountIs`, `hasToolCall`, `anyOf`.
	 */
	stopWhen?: StopCondition

	/**
	 * Judge the answer the run is about to settle with, and hand it back
	 * with feedback when it is not good enough.
	 *
	 * `stopWhen` is only consulted after tools have run, so there was no
	 * seam at the point the model stops calling them: the run finalized
	 * with whatever it had. Verify-then-fix — run the build, feed the
	 * failure back, let it try again — meant starting a new run and
	 * re-supplying the context the first one had already assembled.
	 *
	 * Bounded by {@link maxAnswerReviews}. Never called on the forced-final
	 * turn, which exists to extract a closing summary under pressure.
	 */
	reviewAnswer?: ReviewAnswer

	/**
	 * Decide what this run should leave behind when it settles.
	 *
	 * See {@link PromoteMemory}. Absent means nothing is offered and the
	 * run behaves exactly as it did.
	 */
	promoteMemory?: PromoteMemory

	/** Rejections allowed before the run stops. Default 3. */
	maxAnswerReviews?: number

	/** Called with each completed step, as it completes. */
	onStepFinish?: (step: StepResult) => void

	/**
	 * Shape each step before the model is called: narrow the tool surface,
	 * swap the model, add one-step guidance, change sampling.
	 *
	 * `stopWhen` let a run decide TO STOP from what its steps produced;
	 * this is the other half — deciding how the next step should look.
	 * Without it, the tool surface and model are fixed at `query()` time,
	 * so a phased agent (research with search tools, write with file tools,
	 * verify with a cheaper model) had to be three separate runs, each
	 * starting blind to the last one's context.
	 *
	 * Narrowing `activeTools` costs a prompt-cache prefix, since tools
	 * render at position 0 — worth it at a real phase boundary, not every
	 * step. It does not touch `tool_choice`: not every provider has an
	 * `allowed_tools`, and moving `tool_choice` invalidates cached MESSAGE
	 * blocks too, which is a strictly worse trade for the same effect.
	 *
	 * Fails open — a throw leaves the step with the run's configuration.
	 */
	prepareStep?: PrepareStepChain
	/**
	 * Refuse the next model call before it is made. See {@link BeforeStep}.
	 * A throw fails CLOSED, opposite to `prepareStep` beside it.
	 */
	beforeStep?: BeforeStep

	/**
	 * Force the run to finish by calling a schema-validated tool, and land
	 * the parsed value on `Run.structuredOutput`.
	 *
	 * Both leaf pieces already shipped and neither was reachable:
	 * `createStructuredOutputTool` is excluded from the default builtin set,
	 * and `StructuredOutputConfig` had no field on QueryParams at all. A host
	 * needing a typed result had to register the tool by hand and hope —
	 * nothing forced the call, and nothing stopped the loop when it came.
	 */
	structuredOutput?: StructuredOutputConfig

	/**
	 * Checks run BEFORE the first model call. A block settles the run as
	 * `input_guardrail` having spent nothing.
	 *
	 * namzu's three tool gates all point one way — they protect the world
	 * from the agent. These are the other direction.
	 */
	inputGuardrails?: readonly InputGuardrailSpec[]

	/**
	 * Checks run against the FINAL result. A block settles the run as
	 * `output_guardrail`; a `rewrite` replaces the text (so a PII policy
	 * can redact rather than discard the whole answer).
	 *
	 * These gate the result, not the stream: `text_delta` events already
	 * reached the host, so a rewrite arrives as a correction alongside a
	 * `guardrail_triggered` event.
	 */
	outputGuardrails?: readonly OutputGuardrailSpec[]
	tools: ToolRegistryContract
	runConfig: AgentRunConfig
	allowedTools?: string[]
	agentId: string
	agentName: string
	workingDirectory?: string
	pricing?: ModelPricing
	enableActivityTracking?: boolean
	messages: Message[]
	signal?: AbortSignal
	resumeHandler: ResumeHandler
	resumeFromCheckpoint?: CheckpointId

	/**
	 * The answer to the decision the checkpoint parked on, collected
	 * out-of-band — typically in a different process.
	 *
	 * Recording a park makes the request survive a restart; this is what
	 * makes the ANSWER survive one. Without it a resumed run repairs the
	 * unanswered `tool_use` blocks away and lets the model re-decide, so a
	 * human's "yes, delete that row" degrades into "ask the model again and
	 * hope it asks for the same thing".
	 *
	 * Applies only to a `tool_review` park (the others leave no tool calls
	 * to apply a decision to) and only when the checkpoint's tool calls
	 * still match the ones the decision was made about — otherwise the
	 * decision is ignored and the repair path runs, because consent to one
	 * batch is not consent to a different one.
	 */
	pendingDecision?: HITLResumeDecision

	/**
	 * How long a HITL decision may take before the park is written to the
	 * checkpoint store. Defaults to {@link PARK_RECORD_DELAY_MS}.
	 *
	 * A park is only worth persisting if a human is actually looking at it:
	 * a programmatic handler answers in microseconds, and the iteration
	 * gate runs on every iteration, so recording every park unconditionally
	 * would take a long run from one full-history checkpoint write per
	 * iteration to three. Set `0` to record every park (tests, or a host
	 * that wants an unconditional audit trail).
	 */
	parkRecordDelayMs?: number

	/**
	 * Span this run should hang off, when it is a delegated one.
	 *
	 * A spawned sub-agent is part of its parent's work, and a trace that
	 * shows the delegation is the whole reason to trace a supervisor at
	 * all. Absent for a top-level run, which correctly starts its own root.
	 */
	parentSpan?: import('@opentelemetry/api').Span

	/** Session scope for the run. Required — every run is attributed to a Session. */
	sessionId: SessionId

	/**
	 * Topic the Session lives under. Required — every run carries the full
	 * five-layer scope (Tenant → Project → Topic → Session → Run).
	 * Denormalized from `session.topicId`; callers build this alongside
	 * `sessionId` so the query pipeline never needs a second SessionStore
	 * round-trip to recover it.
	 */
	topicId: TopicId

	/** Long-lived goal scope for the run. Required. */
	projectId: ProjectId

	/** Isolation boundary (Convention #17). Required. */
	tenantId: TenantId

	/**
	 * Optional path layout override. Defaults to a {@link DefaultPathBuilder}
	 * rooted at `{workingDirectory}/.namzu`. First-call filesystem migration
	 * runs on this same entry point.
	 */
	pathBuilder?: PathBuilder

	/**
	 * Optional checkpoint persistence override. Absent ⇒ iteration
	 * checkpoints go to the disk layout under the run's output directory
	 * (today's behavior). A host injects a scope-keyed
	 * {@link CheckpointStore} (e.g. Postgres-backed) so mid-turn resume
	 * survives machines that lose their local disk.
	 */
	checkpointStore?: CheckpointStore

	/**
	 * The fence of the claim this worker holds on the run, from `claimRun`.
	 *
	 * Presented on every checkpoint the run writes, so a worker that stalled
	 * past its lease is refused rather than writing into a run somebody else
	 * has taken over. Omit it for single-writer deployments, which is what
	 * every run did before claims existed.
	 *
	 * This hop did not exist for a release. The claim, the fence and the
	 * store-side refusal were all built and tested, and no path between a run
	 * and its store carried the number — so every checkpoint a RUN wrote went
	 * out unfenced while the tests, which called the store directly, all
	 * passed. A capability complete except for the wire between its halves
	 * reads exactly like a working one.
	 *
	 * It fences checkpoints and nothing else. {@link QueryParams.runStore}
	 * takes no fence, so two workers that both took one run still overwrite
	 * each other's run record, transcript and report — see the changeset.
	 */
	claimFence?: FencingToken

	/**
	 * Where this run records its own evidence — the run record, its messages,
	 * its transcript and its report. Defaults to the disk layout under the
	 * resolved output directory.
	 *
	 * The sibling of {@link QueryParams.checkpointStore}, and it should always
	 * have been one: checkpoints could be pointed at durable storage and the
	 * evidence could not.
	 */
	runStore?: RunStore

	/**
	 * Where a reconnecting consumer left off, so this run's stream can start by
	 * handing back what it missed.
	 *
	 * The case this serves is the one that exists without a network hop: the
	 * process holding the run died, and the consumer watching it is coming back
	 * to a run that has to be resumed. Pair it with `resumeFromCheckpoint` — or
	 * reach it through {@link import('./resume-run.js').resumeRun}, which is the
	 * surface that does both — and the missed durable events are yielded, in
	 * order, before the resumed run emits anything of its own.
	 *
	 * On a run with no log to catch up on the cursor is answered honestly rather
	 * than ignored: a `sinceSeq` above what exists is `cursor_ahead`, not
	 * silence.
	 *
	 * What comes back is message-granular. Streaming deltas are never persisted
	 * — see {@link import('../../types/run/store.js').RunStore.appendEvent} —
	 * so a late subscriber recovers the assistant text, the tool results and the
	 * lifecycle, not the keystroke cadence that produced them.
	 */
	eventCursor?: RunEventCursor

	/**
	 * What became of {@link QueryParams.eventCursor}.
	 *
	 * A callback rather than an event on the stream, because the answer is about
	 * the SUBSCRIPTION and not about the run — and rather than a throw, because
	 * a stale cursor is a client's problem and must not be able to stop a run
	 * from continuing. A host that receives `unavailable` re-derives from the
	 * transcript; one that receives nothing at all would splice a hole into its
	 * state and never know.
	 *
	 * Called once, before the run's first event, and only when a cursor was
	 * supplied.
	 */
	onEventReplay?: (replay: RunEventReplay) => void

	runId?: RunId

	parentRunId?: RunId

	depth?: number

	promptCache?: PromptCache

	contextLevel?: AgentContextLevel

	continuationMode?: boolean

	taskStore?: TaskStore

	runtimeToolOverrides?: RuntimeToolOverrides

	runtimeContext?: AgentRuntimeContext

	taskScheduler?: import('../../types/agent/scheduler.js').TaskScheduler

	/**
	 * Text queued for this run since its last turn, drained at the boundary.
	 *
	 * A callback because the queue belongs to whoever accepts the messages,
	 * and an array captured here would be whatever was queued before the run
	 * started. See `BaseAgentConfig.inboundMessages` for what it closes.
	 */
	inboundMessages?: () => import('../../types/message/index.js').Message[]

	/**
	 * Where this conversation's durable state lives.
	 *
	 * Supplies the permission mode when `runConfig.permissionMode` names
	 * none, and receives the flip when a plan is approved. Absent is the
	 * ordinary case: a run with no topic state behaves exactly as it did.
	 */
	topicStateStore?: import('../../store/topic/state.js').TopicStateStore

	/**
	 * The live permission-mode box, when the caller holds one too.
	 *
	 * Whoever builds the coordinator tools needs to flip this from the
	 * approval hook, and that is not this function. Sharing the object is
	 * what lets an approved plan leave plan mode in the SAME run.
	 */
	permissionModeRef?: { current: import('../../types/permission/index.js').PermissionMode }

	/**
	 * A name for the policy `resumeHandler` implements.
	 *
	 * Only ever written to the durable log and shown to an operator, so it
	 * costs nothing to omit — but omitting it means every entry about who
	 * approved something says `host`, which is the answer that helps least.
	 */
	approvalPolicyName?: string

	/**
	 * Receive this run's approval-policy box, so it can be swapped mid-run.
	 *
	 * The box is built HERE rather than passed in, unlike
	 * {@link permissionModeRef}, because changing the policy emits a durable
	 * event and only the run holds the emitter. A host that constructed its
	 * own box would be able to change the policy without recording it, which
	 * is the one thing this must not allow.
	 */
	onApprovalPolicy?: (policy: import('../../types/hitl/policy.js').RunApprovalPolicy) => void

	/**
	 * Where a worker completion goes when no tool call is waiting for it.
	 *
	 * Supplied by whoever built the coordinator tools, because the tools and
	 * this loop have to share one inbox: the tools claim what they deliver,
	 * and the loop delivers what is left. Omitted, the loop drains nothing and
	 * the behaviour is exactly what it was before the inbox existed.
	 */
	completionInbox?: import('../../scheduler/completion-inbox.js').CompletionInbox

	onContextCreated?: (ctx: {
		planManager: import('../../manager/plan/lifecycle.js').PlanManager
	}) => void

	taskRouter?: TaskRouterConfig

	advisory?: AdvisoryConfig

	compactionConfig?: CompactionConfig

	/**
	 * Optional neutral working-memory seam. When set, the iteration loop
	 * re-renders the provider's string into a single pinned leading system
	 * message every turn (the primacy-edge, compaction-preserved slot).
	 * Absent ⇒ `refreshWorkingMemory` early-returns and the run path is
	 * byte-identical.
	 */
	workingMemoryProvider?: WorkingMemoryProvider

	/**
	 * Replace context reduction for this run.
	 *
	 * Outranks `compactionConfig.strategy`, and the built-in structured pass
	 * does not also run: two mechanisms editing one history in the same pass
	 * cannot both be reasoned about. See `ContextReducer` for the invariants a
	 * reducer is expected to keep.
	 */
	contextReducer?: ContextReducer

	agentBus?: import('../../bus/index.js').AgentBus

	authorizationGate?: AuthorizationGateConfig

	pluginManager?: import('../../plugin/lifecycle.js').PluginLifecycleManager

	sandboxProvider?: SandboxProvider

	invocationState?: InvocationState

	/**
	 * Capability-mismatch handling. Default `false`: when the request asks
	 * for something the provider driver declared it cannot do (tools
	 * registered against a `supportsTools: false` driver, image
	 * attachments against a `supportsVision: false` driver), the runtime
	 * warns loudly, emits a `capability_warning` run event, and degrades
	 * explicitly (tool surfaces stripped from prompt + request;
	 * attachments left unmapped by the driver). `true`: throw instead of
	 * degrading.
	 */
	strictCapabilities?: boolean
}

/**
 * Refuse to price a run whose tokens two differently-priced members may produce.
 *
 * `RunPersistence` holds ONE {@link ModelPricing} table and applies it to every
 * accumulation regardless of which model produced the tokens. Across a swap that
 * makes `costInfo.totalCost` wrong by an unbounded margin, and silently — the
 * number keeps the shape of an answer. `CostInfo` cannot express the truth
 * either: it carries `inputCostPer1M` / `outputCostPer1M`, and there is no
 * honest value for those once a total spans two rate cards.
 *
 * So the total is refused rather than blended. Naming what that costs is part
 * of the refusal, because the caller loses `costLimitUsd` with it: the guard
 * enforces that limit from this same accumulated total, and a limit enforced
 * with the wrong rate card stops a run early or late by the same unbounded
 * margin. A budget that is quietly wrong is worse than a budget that is
 * declined.
 *
 * Reachable, not decorative: a host that passes `pricing` and declares a chain
 * hits it on the first call. It costs `@namzu/cli` nothing, which passes no
 * pricing at all — its `/cost` already reports that the provider gave no price.
 *
 * The way out is per-member pricing, which needs a `CostInfo` that can sum over
 * heterogeneous rates. That is a public-type change and it is not this one.
 */
function assertCostIsAttributable(
	chain: readonly ProviderChainMember[],
	pricing: ModelPricing | undefined,
): void {
	if (pricing === undefined || chain.length < 2) return
	throw new NamzuError({
		code: 'invalid_config',
		message:
			`A provider chain of ${chain.length} members was declared together with a single pricing table. ` +
			'One table cannot price two members, so the run would report a total that is wrong by an unbounded ' +
			'margin — and `runConfig.costLimitUsd` would be enforced against that same wrong total. ' +
			'Either drop `pricing` (usage is still reported per model in the run) or declare one member.',
		details: { chainLength: chain.length },
	})
}

/**
 * Refuse a budget that cannot be measured.
 *
 * `runConfig.costLimitUsd` is enforced against `costInfo.totalCost`, and that
 * total only moves for tokens something has a rate for. A model no rate card
 * covers therefore produced a limit that could never trip — a host that set a
 * cost cap had no cost cap, and nothing said so. That was every run before the
 * price catalogue existed, which is how it went unnoticed.
 *
 * Refusing at the front is the cheap half of the answer: it costs the caller
 * nothing, fires before any spend, and names both ways out. The other half is
 * the `cost_unmeasurable` stop, for the models this cannot see — a step naming
 * its own, or a chain member declaring one.
 *
 * This is the same shape `advisory/budget.ts` already applies to
 * `AdvisoryBudget.maxCostPerRun`, one layer down, and for the same reason. The
 * run path simply never had it.
 */
function assertBudgetIsMeasurable(params: QueryParams): void {
	const limit = params.runConfig.costLimitUsd
	if (limit === undefined || limit <= 0) return
	// A host-supplied table prices whatever it is pointed at, so a caller who
	// brought one has answered the question themselves.
	if (params.pricing !== undefined) return
	const model = params.runConfig.model
	if (resolveModelPricing(params.provider.id, model) !== undefined) return

	throw new NamzuError({
		code: 'invalid_config',
		message:
			`runConfig.costLimitUsd is set to ${limit}, but no rate is known for model "${model}" on ` +
			`provider "${params.provider.id}". The limit is enforced against the run's accumulated ` +
			'cost, and tokens with no rate never reach that total — so the budget would read as ' +
			'satisfied for the whole run and stop nothing. Either pass `pricing` to declare the rate ' +
			'yourself, add the model to packages/sdk/src/pricing/rates.source.json, or drop ' +
			'`costLimitUsd` and bound the run with `tokenBudget`, which is measurable here.',
		details: { model, providerId: params.provider.id, costLimitUsd: limit },
	})
}

/**
 * Ask the driver what this model's window is, and never let the answer
 * cost the run.
 *
 * Three outcomes collapse to two here on purpose. No member and a resolved
 * `undefined` both mean "no answer" — the distinction matters to a driver
 * author, not to a caller about to fall through to the table. A rejection
 * is the third, and it is logged rather than propagated: a run that would
 * have worked on the table must not fail because a listing endpoint was
 * down.
 */
async function resolveProviderContextWindow(
	provider: LLMProvider,
	model: string | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	log: Logger,
): Promise<number | undefined> {
	if (!provider.resolveContextWindow || !model) return undefined
	if (signal?.aborted) return undefined

	// The resolver is an optional optimisation that runs before RunContext
	// owns its child controller. Give it a private deadline signal and fuse
	// caller cancellation into that transport in the safe direction: neither
	// outcome aborts the caller's controller. Passing a signal is necessary
	// but not sufficient, because a third-party driver can accept it and still
	// leave its promise pending; the race below makes fallback independent of
	// driver cooperation. Promise.race keeps the losing provider promise
	// observed, so a later rejection cannot become unhandled.
	const deadline = new AbortController()
	const resolverSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
	const interrupted = Symbol('provider-context-window-interrupted')
	let onAbort: (() => void) | undefined
	const interruption = new Promise<typeof interrupted>((resolve) => {
		onAbort = () => resolve(interrupted)
		resolverSignal.addEventListener('abort', onAbort, { once: true })
	})
	// Wire and directory config validation already limit this field to one
	// hour. The clamp also keeps a direct QueryParams caller from triggering
	// Node's >2^31-1 one-millisecond timer coercion and turning a huge run
	// budget into an immediate metadata fallback.
	const deadlineMs = Math.min(Math.max(0, timeoutMs), 2_147_483_647)
	const timer = setTimeout(() => {
		deadline.abort(new Error(`Provider context-window lookup exceeded ${deadlineMs}ms`))
	}, deadlineMs)

	try {
		const resolution = provider.resolveContextWindow(model, resolverSignal)
		const reported = await Promise.race([resolution, interruption])
		if (reported === interrupted) {
			if (deadline.signal.aborted) {
				log.debug('Provider context-window lookup timed out; using the table', {
					'namzu.model.id': model,
					'namzu.runtime.timeout_ms': deadlineMs,
				})
			}
			return undefined
		}
		return typeof reported === 'number' && reported > 0 ? reported : undefined
	} catch (err) {
		log.debug('Provider could not report a context window; using the table', {
			'namzu.model.id': model,
			'namzu.error.message': toErrorMessage(err),
		})
		return undefined
	} finally {
		clearTimeout(timer)
		if (onAbort) resolverSignal.removeEventListener('abort', onAbort)
	}
}

interface PendingHistoryRepairEvent {
	readonly source: 'fresh-history' | 'abandoned-checkpoint'
	readonly report: ToolHistoryRepairReport
}

/**
 * Project historical system messages exactly as a new run will persist them.
 *
 * Arbitrary historical prompt floors are rebuilt for this run and therefore
 * never reach its provider-bound conversation. Repair must happen AFTER that
 * removal: treating a soon-to-be-dropped system message as a tool-result
 * boundary can replace an exact real result with an invented unknown outcome.
 * The two state-bearing system forms survive; fresh inherited compaction is
 * pinned until this run can prove it reconstructed equivalent state.
 */
function projectStateBearingHistory(
	messages: readonly Message[],
	options: { readonly pinCompaction: boolean },
): Message[] {
	const projected: Message[] = []
	for (const message of messages) {
		if (message.role !== 'system') {
			projected.push(message)
			continue
		}
		if (isCompactionMessage(message.content)) {
			projected.push(options.pinCompaction ? { ...message, retain: true } : message)
		} else if (isWorkingMemoryMessage(message.content)) {
			projected.push(message)
		}
	}
	return projected
}

/**
 * Remove the incomplete turn still owned by a durable resume plan.
 *
 * The plan re-appends the exact assistant with real/denied/recovered results.
 * Generic history repair must not synthesize a competing result first. Any
 * partial results for that turn are removed too; the executor reconstructs
 * them from the durable run transcript through `recoveredResults`.
 */
function withoutOwnedResumeTurn(
	messages: readonly Message[],
	assistant: AssistantMessage,
): Message[] {
	const ownerIndex = messages.lastIndexOf(assistant)
	if (ownerIndex < 0) {
		throw new NamzuError({
			code: 'invalid_config',
			message: 'A pending checkpoint resume plan does not own a message in its checkpoint.',
		})
	}
	const ownedIds = new Set((assistant.toolCalls ?? []).map((call) => call.id))
	return messages.filter(
		(message, index) =>
			index !== ownerIndex &&
			!(index > ownerIndex && message.role === 'tool' && ownedIds.has(message.toolCallId)),
	)
}

export async function* query(params: QueryParams): AsyncGenerator<RunEvent, Run> {
	// Resolved at the DOOR, before a run id exists or a logger is built.
	// A caller who set both spellings of a renamed field has a config bug,
	// and refusing it here costs them nothing; refusing it at the read site
	// deep in the loop turns the same bug into a mid-run failure, after a
	// provider call has been paid for and a partial transcript written.
	const promptCache = params.promptCache
	const taskScheduler = params.taskScheduler
	const streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(params.runConfig.streamIdleTimeoutMs)
	const maxRequestRichContentBytes = resolveMaxRequestRichContentBytes(
		params.runConfig.maxRequestRichContentBytes,
	)
	// Persist the EFFECTIVE value, not only an override. A run replayed after a
	// later release must be able to explain which liveness policy settled it;
	// an absent field whose meaning follows the currently-installed default
	// would rewrite that evidence at read time.
	const runConfig: AgentRunConfig = {
		...params.runConfig,
		streamIdleTimeoutMs,
		maxRequestRichContentBytes,
	}

	// The run's one correlated logger, built before anything below needs
	// one — the migration check, the retry/fallback wrappers and `ctx`
	// itself all read this SAME object, so a retry warning and the run
	// record it retried for carry the identical `namzu.run.id` instead of
	// three separate `getRootLogger()` reads that happened to agree by
	// accident. `runId` is resolved here, once, rather than left to
	// `build`'s own `config.runId ?? generateRunId()` fallback —
	// generating it twice would silently hand the log and the run two
	// different ids.
	const runId = params.runId ?? generateRunId()
	const log = RunContextFactory.buildLogger({
		agentName: params.agentName,
		runConfig,
		runId,
		parentRunId: params.parentRunId,
		sessionId: params.sessionId,
		topicId: params.topicId,
		projectId: params.projectId,
		tenantId: params.tenantId,
	})

	// Boot-time filesystem migration (session-hierarchy.md §13.4.1). First
	// call per process per root actually runs; subsequent calls short-circuit
	// via the in-memory guard in `context.ts`. Kept here rather than inside
	// the synchronous `RunContextFactory.build` so the factory signature stays
	// sync for tests / non-async call sites.
	//
	// The migrator built here — not `ensureMigrated`'s own default — is what
	// turns the migration facts `DefaultFilesystemMigrator` already computes
	// into a `namzu.migration.completed` record instead of discarding them.
	// `ensureMigrated`'s default parameter stays
	// `NOOP_FILESYSTEM_MIGRATION_SINK` (see `context.ts`), so any other path
	// that reaches `ensureMigrated` keeps today's silent behaviour.
	const cwdForMigration = params.workingDirectory ?? process.cwd()
	const migrationResult = await RunContextFactory.ensureMigrated(
		`${cwdForMigration}/.namzu`,
		new DefaultFilesystemMigrator(loggingMigrationSink(log)),
	)
	// `loggingMigrationSink` only ever hears about `kind: 'migrated'` — the
	// only outcome `DefaultFilesystemMigrator` ever hands its sink (see the
	// module doc on `FilesystemMigrationSink`). The other two are logged
	// here, straight off the resolved result, rather than by widening
	// `FilesystemMigrationEvent` to carry them: a wider union would need a
	// new arm in every exhaustive switch already written over it — a major —
	// for two outcomes `migrationResult.kind` already fully describes.
	if (migrationResult.kind !== 'migrated') {
		log.debug('filesystem migration: nothing to do', {
			[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.MIGRATION_COMPLETED,
			// `namzu.migration.*`, matching `loggingMigrationSink` — the OTHER
			// emitter of this same event name. Two emitters of one event writing
			// two namespaces for the same fact is precisely the collision the
			// namespaced-key rule exists to stop, and a per-module derivation is
			// how it would be reintroduced.
			'namzu.migration.kind': migrationResult.kind,
			'namzu.migration.marker_path': migrationResult.markerPath,
		})
	}

	// Every model call in the run — the loop's turns, the forced-final
	// summary, advisory and compaction side calls — goes through this one
	// wrapped provider, so the retry policy cannot be bypassed by a code
	// path that happens to hold the raw driver.
	// The logger is passed on purpose: `withProviderRetry` guards every one
	// of its warns behind `options.log`, and this is its only production
	// call site — so without it the "failed, retrying" and "failed, giving
	// up" lines were dead code and a backoff left no trace anywhere.
	//
	// With a chain declared, the same sentence holds two levels out. The idle
	// watchdog is applied to each raw member, retry wraps that, and fallback
	// wraps the members: `fallback(retry(idle(m0)), retry(idle(m1)), …)`. The
	// idle layer cannot sit outside retry, because its timer would then count a
	// legitimate backoff as provider silence. This order is not a
	// preference. Assembled the other way round — which is what a host gets if
	// it wraps its own chain and hands the result in, because this function
	// would then wrap THAT in retry — an exhausted chain gets restarted from
	// the head by the outer loop and a throttle on the last member is counted
	// by two budgets. Building it here is what makes the order unspellable
	// wrong.
	const chain: readonly ProviderChainMember[] = [
		{ provider: params.provider },
		...(params.fallbackProviders ?? []),
	]
	assertCostIsAttributable(chain, params.pricing)
	assertBudgetIsMeasurable(params)
	const withRecovery = (provider: LLMProvider): LLMProvider => {
		const withIdleBound = withStreamIdleTimeout(provider, {
			idleTimeoutMs: streamIdleTimeoutMs,
			log,
		})
		return params.retry === false
			? withIdleBound
			: withProviderRetry(withIdleBound, { config: params.retry, log })
	}
	// Who is serving right now, for the run RECORD rather than for the request.
	//
	// It starts at the head and moves only when the chain does, which is the
	// whole of the truth because the cursor never rewinds. The run cannot read
	// this off `resilientProvider`: that wrapper reports the head's `id` on
	// purpose, so asking it produces the declaration back — the defect this
	// record exists to fix.
	const serving: { current: ServingMember } = {
		current: { index: 0, providerId: params.provider.id },
	}
	const resilientProvider = withProviderFallback(
		chain.map((member) => ({ ...member, provider: withRecovery(member.provider) })),
		{
			log,
			onSwap: (to) => {
				serving.current = to
				// `ctx` is declared below and is initialized before anything can
				// call the provider: this fires from inside a `chatStream`, and
				// the first one is issued by the loop that `ctx` is built for.
				ctx.runMgr.setServingProvider(to.providerId)
			},
		},
	)

	// Asked ONCE, here, before the loop exists. Both readers are synchronous
	// and hot, so this can never move inside the iteration — and a driver
	// that rejects, or one that hangs until the run is cancelled, must not
	// take down a run the table could have served perfectly well. That is
	// why the failure path is a swallow with a log rather than a throw: the
	// window is an optimisation over a working default, not a prerequisite.
	const providerContextWindow = await resolveProviderContextWindow(
		resilientProvider,
		runConfig.model,
		params.signal,
		runConfig.timeoutMs,
		log,
	)

	// The mode this conversation was left in, when the run config names none.
	// Read once, before the loop exists, for the same reason the context
	// window is: the executor's resolver is synchronous and hot.
	//
	// A store that throws is not a run failure — the run falls back to the
	// config's answer, which is exactly what it did before this existed.
	const topicState = params.topicStateStore
		? await params.topicStateStore
				.getState(params.topicId, params.tenantId)
				.catch((err: unknown) => {
					log.debug('Could not read the topic state; using the run config', {
						'namzu.topic.id': params.topicId,
						'namzu.error.message': toErrorMessage(err),
					})
					return null
				})
		: null

	// Whatever a host left for "the next run", taken and cleared in one
	// compare-and-set write. Prepended to the messages this run starts from,
	// so it is in the FIRST request rather than arriving a turn late.
	//
	// Cleared as it is read: a queue read and cleared separately re-delivers
	// on a crash between the two, and "start with this" arriving twice is a
	// different instruction from the one that was left.
	const queuedForThisRun: readonly Message[] = params.topicStateStore
		? await drainQueuedMessages(params.topicStateStore, params.topicId, params.tenantId).catch(
				(err: unknown) => {
					log.debug('Could not drain the topic queue; starting without it', {
						'namzu.topic.id': params.topicId,
						'namzu.error.message': toErrorMessage(err),
					})
					return []
				},
			)
		: []

	// One effective list, used everywhere the run is seeded from. Three
	// branches below push from it, and computing it at each would be three
	// places to forget the queue.
	//
	// Stored attachments are resolved HERE, once, before the messages reach
	// the run record. Resolving later — at the provider boundary — would put
	// refs in the durable transcript and in every checkpoint, and a run
	// resumed against a store that had since forgotten a ref would fail
	// replaying its own history rather than at the moment somebody asked for
	// the bytes. Every failure refuses: a message that silently lost its
	// image is a model answering about a picture it never saw.
	const seeded: Message[] =
		queuedForThisRun.length > 0 ? [...queuedForThisRun, ...params.messages] : params.messages
	const resolvedInitialMessages: Message[] = [
		...(await resolveAttachments(seeded, params.attachmentStore)),
	]
	const pendingHistoryRepairs: PendingHistoryRepairEvent[] = []
	const projectedInitialMessages =
		params.resumeFromCheckpoint || params.continuationMode
			? resolvedInitialMessages
			: projectStateBearingHistory(resolvedInitialMessages, { pinCompaction: true })
	const initialRepair = params.resumeFromCheckpoint
		? { messages: projectedInitialMessages, report: undefined }
		: repairToolMessageHistory(projectedInitialMessages)
	const initialMessages = initialRepair.messages
	if (initialRepair.report && toolHistoryRepairChanged(initialRepair.report)) {
		pendingHistoryRepairs.push({ source: 'fresh-history', report: initialRepair.report })
		log.warn('Repaired provider-invalid tool history before starting the run', {
			[NAMZU.RUN_ID]: runId,
			'namzu.history.source': 'fresh-history',
			'namzu.history.duplicate_tool_results_removed':
				initialRepair.report.duplicateToolResultsRemoved,
			'namzu.history.orphaned_tool_results_removed':
				initialRepair.report.orphanedToolResultsRemoved,
			'namzu.history.synthetic_tool_results_inserted':
				initialRepair.report.syntheticToolResultsInserted,
		})
	}

	const ctx = RunContextFactory.build({
		...(topicState ? { topicPermissionMode: topicState.permissionMode } : {}),
		...(params.permissionModeRef ? { permissionModeRef: params.permissionModeRef } : {}),
		agentId: params.agentId,
		agentName: params.agentName,
		runConfig,
		provider: resilientProvider,
		workingDirectory: params.workingDirectory,
		pricing: params.pricing,
		enableActivityTracking: params.enableActivityTracking,
		messages: initialMessages,
		signal: params.signal,
		sessionId: params.sessionId,
		topicId: params.topicId,
		projectId: params.projectId,
		tenantId: params.tenantId,
		pathBuilder: params.pathBuilder,
		checkpointStore: params.checkpointStore,
		runStore: params.runStore,
		runId,
		parentRunId: params.parentRunId,
		depth: params.depth,
		log,
	})

	// Built here because the plan-approval closure below captures it, and
	// its `emit` resolves `eventTranslator` at CALL time — the translator is
	// a `const` some lines further down.
	//
	// The HANDOUT is therefore deliberately NOT here. A host given the box
	// at this point can call `set` synchronously, `emit` reaches
	// `eventTranslator` inside its temporal dead zone, and the run dies
	// before it starts. That is not hypothetical: it is what the first
	// version of this did, and the test that hands out the box and
	// immediately swaps the policy is the one that found it.
	const approvalPolicy = createRunApprovalPolicy({
		runId: ctx.runId,
		initial: {
			// By identity against the default, not by presence. `resumeHandler`
			// is REQUIRED on `QueryParams` — `drainQuery` substitutes
			// `autoApproveHandler` before calling here — so "is it set" is
			// always yes and would name every run `host`, including the ones
			// approving everything unattended. Identity is what actually
			// separates the two.
			name:
				params.approvalPolicyName ??
				(params.resumeHandler === autoApproveHandler ? AUTO_APPROVE_POLICY_NAME : 'host'),
			handler: params.resumeHandler,
		},
		emit: (event) => eventTranslator.emitEvent(event),
	})

	ctx.planManager.setApprovalHandler(async (request) => {
		// `.current.handler`, never a captured `params.resumeHandler`. That
		// capture is what made changing the policy mean ending the run.
		const decision = await approvalPolicy.current.handler({
			type: 'plan_approval',
			runId: ctx.runId,
			checkpointId: `cp_plan_${request.planId}` as import('../../types/ids/index.js').CheckpointId,
			plan: {
				planId: request.planId,
				title: request.title,
				steps: request.steps.map((s, i) => ({
					id: s.id,
					description: s.description,
					toolName: s.toolName,
					agentId: s.agentId,
					dependsOn: s.dependsOn,
					order: s.order ?? i + 1,
				})),
				summary: request.summary,
			},
		})

		if (decision.action === 'approve_plan') {
			// Optional approve-with-edits channel: the host may attach
			// feedback to an approval. `PlanApprovalResponse.feedback`
			// already exists on the type; threading it through lets the
			// coordinator's approve_plan tool surface the user's edits in
			// the same tool_result that unblocks the park. Bare approvals
			// stay byte-identical (`{ approved: true }`).
			return decision.feedback
				? { approved: true, feedback: decision.feedback }
				: { approved: true }
		}
		if (decision.action === 'reject_plan') {
			return { approved: false, feedback: decision.feedback }
		}

		return { approved: false, feedback: `Action: ${decision.action}` }
	})

	const eventTranslator = new EventTranslator(ctx.runMgr, undefined, ctx.log)
	eventTranslator.wireActivityStore(ctx.activityStore, ctx.runId)
	eventTranslator.wirePlanManager(ctx.planManager, ctx.runId)
	const unsubscribeTaskStore = params.taskStore
		? eventTranslator.wireTaskStore(params.taskStore, ctx.runId)
		: undefined

	if (params.taskStore) {
		const taskTools = buildTaskTools(params.taskStore, ctx.runId)
		const overrides = params.runtimeToolOverrides
		for (const tool of taskTools) {
			const override = overrides?.[tool.name]
			if (override === 'disabled') continue
			params.tools.register(tool, override ?? 'deferred')
		}
	}

	if (!params.tools.has(SearchToolsTool.name)) {
		const hasDeferred = params.tools
			.listNames()
			.some((n) => params.tools.getAvailability(n) === 'deferred')
		if (hasDeferred) {
			params.tools.register(SearchToolsTool)
		}
	}

	// Registered HERE, before the first turn, not when the model is nearly
	// done. Tools render at prefix position 0, so injecting one late would
	// invalidate the whole prompt cache for the rest of the run — the same
	// reason the forced-final turn keeps its tools array and uses
	// `toolChoice: 'none'` instead of dropping it.
	if (params.structuredOutput && !params.tools.has(STRUCTURED_OUTPUT_TOOL_NAME)) {
		params.tools.register(createStructuredOutputTool(params.structuredOutput.schema))
	}

	// ─── Provider capability negotiation (before tooling bootstrap) ────────
	// Compare what the request asks for with what the DRIVER declared it
	// does. Undeclared capabilities resolve permissively (today's behavior
	// for third-party providers); declared gaps degrade loudly instead of
	// silently.
	const capabilities = resolveProviderCapabilities(params.provider)
	const registeredToolCount = params.tools.listNames().length
	const stripToolSurfaces = !capabilities.supportsTools && registeredToolCount > 0
	// Counted separately because they are separate wire shapes: a driver can
	// map images and drop documents, and a vision warning would send the
	// reader looking at the wrong half.
	const carries = (m: (typeof params.messages)[number], kind: 'image' | 'document') =>
		m.role === 'user' && (m.attachments ?? []).some((a) => (a.type ?? 'image') === kind)

	const attachmentMessageCount = capabilities.supportsVision
		? 0
		: params.messages.filter((m) => carries(m, 'image')).length
	const documentMessageCount = capabilities.supportsDocuments
		? 0
		: params.messages.filter((m) => carries(m, 'document')).length

	if (stripToolSurfaces) {
		const message = `Provider '${params.provider.id}' declares supportsTools: false but ${registeredToolCount} tool(s) are registered — stripping all tool surfaces from the prompt and request so the model is never told about tools it cannot call. Pass strictCapabilities: true to fail instead, or use a tools-capable provider.`
		if (params.strictCapabilities) {
			throw new NamzuError({
				code: 'capability_unavailable',
				message,
				details: { providerId: params.provider.id, capability: 'tools', registeredToolCount },
			})
		}
		ctx.log.warn('Capability mismatch: the provider declares no tool support', {
			'namzu.capability.detail': message,
			[GENAI.SYSTEM]: params.provider.id,
			'namzu.runtime.registered_tool_count': registeredToolCount,
		})
	}

	if (attachmentMessageCount > 0) {
		const message = `Provider '${params.provider.id}' declares supportsVision: false but ${attachmentMessageCount} user message(s) carry image attachments — the driver will not map them, so the model never sees the images. Pass strictCapabilities: true to fail instead, or use a vision-capable provider.`
		if (params.strictCapabilities) {
			throw new NamzuError({
				code: 'capability_unavailable',
				message,
				details: { providerId: params.provider.id, capability: 'vision', attachmentMessageCount },
			})
		}
		ctx.log.warn('Capability mismatch: the provider declares no vision support', {
			'namzu.capability.detail': message,
			[GENAI.SYSTEM]: params.provider.id,
			'namzu.runtime.attachment_message_count': attachmentMessageCount,
		})
	}

	if (documentMessageCount > 0) {
		const message = `Provider '${params.provider.id}' declares supportsDocuments: false but ${documentMessageCount} user message(s) carry document attachments — the driver will not map them, so the model never sees the documents. Pass strictCapabilities: true to fail instead, or use a document-capable provider.`
		if (params.strictCapabilities) {
			throw new NamzuError({
				code: 'capability_unavailable',
				message,
				details: { providerId: params.provider.id, capability: 'documents', documentMessageCount },
			})
		}
		ctx.log.warn('Capability mismatch: the provider declares no document support', {
			'namzu.capability.detail': message,
			[GENAI.SYSTEM]: params.provider.id,
			'namzu.runtime.document_message_count': documentMessageCount,
		})
	}

	// Denied names are subtracted LAST, after the allow-list is resolved
	// against the registry — so a deny reaches a run that named no
	// allow-list at all, which is the ordinary case for a delegated child.
	// Applied to `effectiveAllowedTools`, which `query()` binds to both the
	// request tool list AND the `ToolExecutor`: narrowing only the request
	// shows the model fewer tools and lets it call any of them by name.
	const allowedBeforeDenial = stripToolSurfaces
		? []
		: withDeferredDiscoveryTool(params.tools, params.allowedTools)
	const denied = new Set(params.deniedTools ?? [])
	const effectiveAllowedTools: string[] | undefined =
		denied.size === 0
			? allowedBeforeDenial
			: // An absent allow-list means "every registered tool", so a deny
				// with no allow-list has to be resolved against the registry
				// here — otherwise the subtraction would be from an empty list
				// and would deny nothing, which is the shape a delegated child
				// arrives in.
				[...(allowedBeforeDenial ?? params.tools.listNames())].filter((name) => !denied.has(name))

	// The two halves of a durable pause, owned by the RUN when the host
	// does not own them.
	//
	// `SupervisorAgent` builds both before the run exists, because the
	// tools it builds close over them, and it passes them in. Nothing else
	// could: neither type is exported from `public-runtime.ts`, so a host
	// on `ReactiveAgent`, `drainQuery` or `resumeRun` had no way to supply
	// either — and `ToolContext.requestPause`, which every tool author is
	// handed, silently wrote no checkpoint and could receive no answer on
	// those surfaces. Which agent class the host happened to pick is not
	// visible at the call site, so the degradation was invisible too.
	//
	// A run-local pair is enough for the general seam because `query()`
	// builds its `createToolPause` itself, below, and can hand it the
	// run's own. Pinned by the "a pause is durable on any surface" cases
	// in `__tests__/tool-pause-resume.test.ts`.
	const questionParks = params.questionParks ?? new QuestionParkBinding()
	const pendingAnswers = params.pendingAnswers ?? new PendingAnswers()

	//  is null only when the run has no disk layout (tests,
	// in-memory hosts); the budget then degrades to middle-elision.
	const runDirForTools = ctx.runMgr.getRunDir()
	const toolOutputDir = runDirForTools ? join(runDirForTools, TOOL_OUTPUT_DIR_NAME) : undefined

	const toolExecutor = ToolingBootstrap.init(
		{
			tools: params.tools,
			runId: ctx.runId,
			workingDirectory: ctx.cwd,
			permissionMode: () => ctx.permissionMode.current,
			env: runConfig.env ?? {},
			abortSignal: ctx.abortController.signal,
			allowedTools: effectiveAllowedTools,
			invocationState: params.invocationState,
			pluginManager: params.pluginManager,
			...(params.backgroundJobs ? { backgroundJobs: params.backgroundJobs } : {}),
			// The `skill` tool's registry. Threaded from the run rather than
			// held by the tool, because a tool that reached for a module-level
			// registry would answer about whatever the last run configured.
			...(params.skillRegistry ? { skills: params.skillRegistry } : {}),
			...(params.web ? { web: params.web } : {}),
			...(params.toolTimeoutMs !== undefined ? { toolTimeoutMs: params.toolTimeoutMs } : {}),
			...(params.toolRetryBackoff !== undefined
				? { toolRetryBackoff: params.toolRetryBackoff }
				: {}),
			...(params.maxToolConcurrency !== undefined
				? { maxToolConcurrency: params.maxToolConcurrency }
				: {}),
			...(params.maxToolOutputChars !== undefined
				? { maxToolOutputChars: params.maxToolOutputChars }
				: {}),
			...(params.maxToolContentBytes !== undefined
				? { maxToolContentBytes: params.maxToolContentBytes }
				: {}),
			// Overflow lands beside the run's other artifacts, so it is
			// cleaned up with the run and reachable by the model's own
			// `read`/`grep` without a new affordance.
			...(toolOutputDir ? { toolOutputDir } : {}),
			...(params.repairToolCall ? { repairToolCall: params.repairToolCall } : {}),
			// The durable pause, reachable from any tool rather than from the
			// four kernel-owned points that used to own it. Built here from
			// the machinery the run already holds; the recorder binds a few
			// lines below, and until it does a pause is in-process only —
			// the same degradation the built-in question tool has.
			toolPause: (toolUseId) =>
				createToolPause({
					runId: ctx.runId,
					toolUseId,
					parkHandler: (request) => approvalPolicy.current.handler(request),
					recorder: questionParks,
					pendingAnswers,
				}),
		},
		ctx.activityStore,
		eventTranslator.emitEvent,
		ctx.log,
	)

	let workingStateManager: WorkingStateManager | undefined
	if (params.compactionConfig && params.compactionConfig.strategy !== 'disabled') {
		workingStateManager = new WorkingStateManager(params.compactionConfig)
		toolExecutor.setWorkingStateManager(workingStateManager)
	}

	const promptBuilder = new PromptBuilder({
		systemPrompt: params.systemPrompt,
		persona: params.persona,
		skills: params.skills,
		basePrompt: params.basePrompt,
		tools: params.tools,
		allowedTools: effectiveAllowedTools,
		runtimeContext: params.runtimeContext,
		...(params.promptContributions ? { contributions: params.promptContributions } : {}),
	})

	const guard = new GuardCoordinator({
		tokenBudget: runConfig.tokenBudget,
		timeoutMs: runConfig.timeoutMs,
		costLimitUsd: runConfig.costLimitUsd,
		maxIterations: runConfig.maxIterations,
	})

	const checkpointMgr = new CheckpointManager(
		ctx.runMgr.getCheckpointStore(),
		ctx.runMgr.getRunScope(),
	)

	// Every checkpoint carries compaction's accumulated state, so a run that
	// comes back in a new process can adopt it (see the restore block).
	// Without it, compaction's own justification for dropping the prior
	// `[COMPACTED CONTEXT]` block — that `serializeState` is cumulative —
	// holds within one process and fails across a resume.
	if (workingStateManager) {
		const manager = workingStateManager
		checkpointMgr.setWorkingStateSource(() => snapshotWorkingState(manager))
	}

	const resultAssembler = new ResultAssembler({
		runMgr: ctx.runMgr,
		planManager: ctx.planManager,
		activityStore: ctx.activityStore,
		log: ctx.log,
		emitEvent: eventTranslator.emitEvent,
		drainPending: () => eventTranslator.drainPending(),
		// Read at settle time, not now: checkpoints are written per
		// iteration, so the answer changes as the run proceeds.
		resumeCheckpointId: () => checkpointMgr.lastCheckpointId,
		// Read only to recover WHY a cancellation happened. The run loop
		// already knows THAT it was cancelled; the origin lives on the abort
		// reason and nothing else carries it this far.
		signal: ctx.abortController.signal,
	})

	let advisoryCtx: AdvisoryContext | undefined
	if (params.advisory && params.advisory.advisors.length > 0) {
		// Advisors are model calls owned by this run even when they use a
		// different provider. Sending the raw definitions into the registry
		// lets a triggered or model-requested consultation bypass both the
		// finite stream-silence bound and Stop. Bind every advisor provider at
		// the query boundary, where the effective timeout and run signal are
		// already known; standalone AdvisoryExecutor callers retain their
		// explicitly chosen provider/cancellation policy.
		const boundedAdvisors = params.advisory.advisors.map((advisor) => ({
			...advisor,
			provider: withStreamIdleTimeout(advisor.provider, {
				idleTimeoutMs: streamIdleTimeoutMs,
				log: ctx.log,
			}),
		}))
		const advisorRegistry = new AdvisorRegistry(boundedAdvisors, params.advisory.defaultAdvisorId)
		// A budget the runtime cannot measure is refused here rather than
		// silently ignored for the length of the run.
		assertBudgetEnforceable(params.advisory)
		const advisoryExecutor = new AdvisoryExecutor(
			ctx.log,
			params.advisory.budget,
			ctx.abortController.signal,
		)
		const triggerEvaluator = new TriggerEvaluator(
			params.advisory.triggers ?? [],
			params.advisory.budget,
		)
		advisoryCtx = new AdvisoryContext(
			advisorRegistry,
			advisoryExecutor,
			triggerEvaluator,
			params.advisory.budget,
		)

		// What the run looks like when the MODEL consults an advisor, as
		// opposed to when a trigger does. The trigger path has always passed
		// this; the tool path passed an empty context, so an advisor the model
		// asked for help saw the question and nothing else.
		//
		// `includeToolCatalog` and `useCompactedContext` are read here and
		// nowhere else. Both were declared on `AdvisoryConfig` /
		// `AdvisorDefinition` and consulted by nothing, so a host who turned
		// the catalogue off still paid for it in every advisory prompt.
		const advisoryConfig = params.advisory
		advisoryCtx.setCallContextProvider(() => {
			const summary =
				workingStateManager && advisoryConfig.advisors.some((a) => a.useCompactedContext)
					? serializeWorkingState(workingStateManager.getState())
					: undefined
			return {
				messages: ctx.runMgr.messages,
				...(summary !== undefined ? { workingStateSummary: summary } : {}),
				...(advisoryConfig.includeToolCatalog
					? { toolCatalog: params.tools.toLLMTools(effectiveAllowedTools) }
					: {}),
				iteration: ctx.runMgr.currentIteration,
			}
		})

		if (params.advisory.enableAgentTool) {
			const advisoryTools = buildAdvisoryTools({ advisoryCtx })
			const overrides = params.runtimeToolOverrides
			for (const tool of advisoryTools) {
				const override = overrides?.[tool.name]
				if (override === 'disabled') continue
				params.tools.register(tool, override ?? 'active')
			}
		}
	}

	const gateConfig = params.authorizationGate

	const verificationGate = gateConfig?.enabled
		? new AuthorizationGate(gateConfig, ctx.log)
		: undefined

	const iterationOrchestrator = new IterationOrchestrator({
		provider: resilientProvider,
		servingMember: () => serving.current,
		runConfig,
		...(params.stopWhen ? { stopWhen: params.stopWhen } : {}),
		...(params.prepareStep ? { prepareStep: params.prepareStep } : {}),
		...(params.beforeStep ? { beforeStep: params.beforeStep } : {}),
		...(params.onStepFinish ? { onStepFinish: params.onStepFinish } : {}),
		...(params.reviewAnswer ? { reviewAnswer: params.reviewAnswer } : {}),
		...(params.maxAnswerReviews !== undefined ? { maxAnswerReviews: params.maxAnswerReviews } : {}),
		...(params.structuredOutput ? { structuredOutput: params.structuredOutput } : {}),
		...(params.parkRecordDelayMs !== undefined
			? { parkRecordDelayMs: params.parkRecordDelayMs }
			: {}),
		tools: params.tools,
		allowedTools: effectiveAllowedTools,
		runMgr: ctx.runMgr,
		toolExecutor,
		guard,
		activityStore: ctx.activityStore,
		emitEvent: eventTranslator.emitEvent,
		drainPending: () => eventTranslator.drainPending(),
		abortController: ctx.abortController,
		log: ctx.log,
		// Read through the box on every call, so a swap lands on the next
		// question rather than the next run.
		resumeHandler: (request) => approvalPolicy.current.handler(request),
		takeApprovalPolicyChange: () => approvalPolicy.takeUnannouncedChange(),
		...(params.promptContributions ? { promptContributions: params.promptContributions } : {}),
		...(params.steering ? { steering: params.steering } : {}),
		checkpointMgr,
		planManager: ctx.planManager,
		taskGateway: taskScheduler,
		completionInbox: params.completionInbox,
		taskStore: params.taskStore,
		// Run-scoped. An approval is a statement about this run's work;
		// carrying one into a later run would be reuse nobody agreed to.
		toolGrants: new ToolGrantSet(),
		// Run-scoped for the same reason. A repeat count carried into a later
		// run is a claim about work nobody repeated, and a module-level map
		// would leak exactly that way.
		...(params.repeatCallAdvisory === false ? {} : { repeatCalls: new RepeatCallTracker() }),
		compactionConfig: params.compactionConfig,
		...(params.inboundMessages ? { inboundMessages: params.inboundMessages } : {}),
		...(providerContextWindow !== undefined ? { providerContextWindow } : {}),
		workingStateManager,
		taskRouter: params.taskRouter,
		contextReducer: params.contextReducer,
		workingMemoryProvider: params.workingMemoryProvider,
		advisoryCtx,
		agentBus: params.agentBus,
		verificationGate,
		pluginManager: params.pluginManager,
	})

	const tracer = getTracer()

	return yield* (async function* (): AsyncGenerator<RunEvent, Run> {
		// Parent explicitly when a caller supplied one. Without this every
		// run starts its OWN root trace, so a supervisor delegating to three
		// children produced four disconnected traces instead of one tree —
		// the same defect that made a 20-turn run show up as 21 roots before
		// iterations were parented, except across the spawn boundary, where
		// it is worse: the delegation structure is the thing you most want
		// to see.
		const runStartedAt = Date.now()

		// Read before the span is minted, because a parent can only be set
		// at creation. A resumed run used to start a brand-new trace with no
		// link to the one that crashed, so the failure and its recovery
		// could not be put on one timeline — the run id correlated them well
		// enough to find both by query and not well enough to see a single
		// waterfall, and for a replay fork (which mints a new run id) not
		// even that. An explicit caller-supplied parent still wins: it is
		// the more specific statement about where this run belongs.
		const resumedTrace = params.resumeFromCheckpoint
			? await checkpointMgr.readTraceContext(params.resumeFromCheckpoint)
			: undefined

		const rootSpan = tracer.startSpan(
			agentRunSpanName(params.agentName),
			{},
			parentContext(params.parentSpan ?? resumedTrace),
		)
		// Hand the run span to the loop so every iteration parents to it.
		iterationOrchestrator.setRootSpan(rootSpan)
		// Every checkpoint from here on records the trace it was taken
		// inside, so the next resume can join this one.
		checkpointMgr.setTraceSource(() => serializeSpan(rootSpan))
		// And every park it records carries an absolute deadline, so an
		// unanswered approval cannot outlive the worker that asked for it.
		checkpointMgr.setParkTtl(runConfig.hitlParkTtlMs)
		// The claim this worker holds, if it took one. Without this hop the
		// fence exists, the refusal exists, and no checkpoint a RUN writes ever
		// carries a number — so a stalled worker is refused nowhere.
		checkpointMgr.setClaimFence(params.claimFence)
		// And every EVENT it records carries the same fence as its generation,
		// so a consumer whose cursor was minted under an older holding is told
		// the sequence space changed rather than handed a splice from it.
		eventTranslator.setGeneration(params.claimFence)

		// A question raised from inside a tool becomes a real checkpoint
		// here. It used to park under a synthetic id nothing ever wrote, so
		// the checkpoint did not exist: nothing on disk said a human owed
		// this run an answer, and a remote host could not observe the
		// question at all.
		questionParks.bind({
			record: async (question) => {
				try {
					const checkpoint = await checkpointMgr.create(ctx.runMgr, ctx.runMgr.currentIteration)
					const parked = await checkpointMgr.park(checkpoint, {
						type: 'user_question',
						runId: ctx.runMgr.id,
						checkpointId: checkpoint.id,
						question,
					})
					await eventTranslator.emitEvent({
						type: 'user_question_asked',
						runId: ctx.runMgr.id,
						checkpointId: parked.id,
						questionId: question.questionId,
						question: question.question,
					})
					return parked.id
				} catch (err) {
					// A store that cannot record the park must not take the
					// tool down with it: the in-process await is still valid
					// and only the cross-process handoff is lost. Loudly,
					// because a host building an approval queue from durable
					// state will not see this question.
					ctx.log.error('Failed to record a question park — it is not resumable', {
						[NAMZU.RUN_ID]: ctx.runMgr.id,
						'namzu.runtime.question_id': question.questionId,
						'exception.message': err instanceof Error ? err.message : String(err),
					})
					return null
				}
			},
			resolve: async (checkpointId, decision) => {
				await checkpointMgr.unpark(checkpointId, decision).catch((err: unknown) => {
					ctx.log.error('Failed to clear a recorded question park', {
						[NAMZU.RUN_ID]: ctx.runMgr.id,
						'namzu.checkpoint.id': checkpointId,
						'exception.message': err instanceof Error ? err.message : String(err),
					})
					return null
				})
				await eventTranslator.emitEvent({
					type: 'user_question_answered',
					runId: ctx.runMgr.id,
					checkpointId,
					...(decision.action === 'answer_question' && decision.questionId !== undefined
						? { questionId: decision.questionId }
						: {}),
					answered: decision.action === 'answer_question',
				})
			},
		})
		rootSpan.setAttributes({
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			[GENAI.AGENT_NAME]: params.agentName,
			[GENAI.AGENT_ID]: params.agentId,
			[GENAI.REQUEST_MODEL]: runConfig.model,
			[GENAI.SYSTEM]: params.provider.id,
		})

		let sandbox: Sandbox | undefined
		// Decided during checkpoint restore, executed after the sandbox
		// exists — the approved tools may well need it.
		let pendingResume: PendingResumePlan | null = null
		/** Tool results recovered from the transcript; see the restore path. */
		let recoveredResults: ReadonlyMap<string, { result: string; isError: boolean }> = new Map()
		let emergencyManager: EmergencySaveManager | undefined

		try {
			await ctx.runMgr.init()

			// A consumer coming back gets what it missed BEFORE the run says
			// anything new, which is the only order that lets it fold one
			// stream into one state. It has to follow `init()` — that is what
			// binds the store and reads the log's head — and precede every
			// emit below.
			if (params.eventCursor) {
				yield* catchUpFromCursor(
					ctx.runMgr,
					params.eventCursor,
					params.onEventReplay,
					params.claimFence,
				)
			}

			// Handed over here, and the position is load-bearing in BOTH
			// directions. It has to follow `wirePlanManager`, or a host that
			// builds its plan in this callback — which is what the callback is
			// for — does it into silence: `plan_ready`, `plan_approved` and
			// every `plan_step_updated` are emitted with nothing subscribed,
			// and the host then watches a stream that never mentions the plan
			// it just created. It also has to follow `runMgr.init()`, because
			// emitting appends to the run store and an uninitialised store
			// throws — moving it up to the wiring alone traded a silent drop
			// for 25 unhandled rejections.
			//
			// Still before the iteration loop, which is the guarantee the
			// callback actually makes.
			params.onContextCreated?.({ planManager: ctx.planManager })

			ctx.log.info('Starting query', {
				[NAMZU.RUN_ID]: ctx.runMgr.id,
				'namzu.runtime.agent': params.agentName,
				[GENAI.REQUEST_MODEL]: runConfig.model,
				'namzu.runtime.token_budget': runConfig.tokenBudget,
				'namzu.runtime.activity_tracking': ctx.activityStore.enabled,
				'namzu.runtime.permission_mode': ctx.permissionMode.current,
				'namzu.runtime.resume_from_checkpoint': params.resumeFromCheckpoint ?? null,
			})

			const contextLevel = params.contextLevel ?? 'full'
			const cacheInput = {
				systemPrompt: params.systemPrompt,
				persona: params.persona,
				skills: params.skills,
				basePrompt: contextLevel === 'full' ? params.basePrompt : undefined,
				tools: params.tools,
				allowedTools: effectiveAllowedTools,
				runtimeContext: params.runtimeContext,
				...(params.promptContributions ? { contributions: params.promptContributions } : {}),
			}

			const segments: PromptSegments = promptCache
				? promptCache.getSystemPromptSegmented(cacheInput, contextLevel, params.workingDirectory)
				: promptBuilder.buildSegmented(contextLevel, params.workingDirectory)

			ctx.log.info('Prompt segments assembled', {
				'namzu.runtime.static_length': segments.static.length,
				'namzu.runtime.dynamic_length': segments.dynamic.length,
			})

			const pushSystemMessages = (): void => {
				ctx.runMgr.pushMessage(createSystemMessage(segments.static, 'cache'))
				if (segments.dynamic.length > 0) {
					ctx.runMgr.pushMessage(createSystemMessage(segments.dynamic, 'ephemeral'))
				}
			}

			if (params.resumeFromCheckpoint) {
				const checkpoint = await checkpointMgr.restore(params.resumeFromCheckpoint)
				const projectedCheckpoint = {
					...checkpoint,
					messages: projectStateBearingHistory(checkpoint.messages, { pinCompaction: false }),
				}
				await eventTranslator.emitEvent({
					type: 'run_resuming',
					runId: ctx.runMgr.id,
					fromCheckpointId: checkpoint.id,
				})
				yield* eventTranslator.drainPending()

				// Budgets are properties of the RUN, not of the process hosting
				// it. The checkpoint already carried all three; they were
				// written and then discarded on the way back in, so a run
				// recalled at $4.80 of a $5 cap came back with a fresh $5 and
				// a fresh timeout clock. Restore before the first iteration so
				// a resumed run that is already over budget stops immediately.
				ctx.runMgr.restoreUsage(
					checkpoint.tokenUsage,
					checkpoint.costInfo,
					checkpoint.guardState.iterationCount,
				)
				guard.restoreElapsed(checkpoint.guardState.elapsedMs)

				// Adopt the working state the earlier summary was built from.
				// The `[COMPACTED CONTEXT]` block below is preserved precisely
				// because it is the only surviving record of the history the
				// first pass deleted — and without this, the NEXT compaction
				// would drop it and replace it with a summary covering only
				// what happened after the resume, silently losing the run's
				// first hour.
				if (workingStateManager && checkpoint.workingState && params.compactionConfig) {
					const revived = restoreWorkingState(checkpoint.workingState, params.compactionConfig)
					workingStateManager.replaceState(revived.getState())
					ctx.log.info('Restored compaction working state from checkpoint', {
						[NAMZU.RUN_ID]: ctx.runMgr.id,
						'namzu.checkpoint.id': checkpoint.id,
						'namzu.runtime.slots': workingStateManager.slotCount(),
					})
				}
				ctx.log.info('Restored budgets from checkpoint', {
					[NAMZU.RUN_ID]: ctx.runMgr.id,
					'namzu.checkpoint.id': checkpoint.id,
					'namzu.usage.total_tokens': checkpoint.tokenUsage.totalTokens,
					'namzu.runtime.total_cost': checkpoint.costInfo.totalCost,
					[NAMZU.ITERATION]: checkpoint.guardState.iterationCount,
					'namzu.runtime.elapsed_ms': checkpoint.guardState.elapsedMs,
				})

				pushSystemMessages()

				// A human answered the park in a different process; apply that
				// answer to the tool calls they were actually shown. Without
				// this the repair below throws the approval away and the model
				// re-decides, so "yes, delete that row" degrades into "ask
				// again and hope it asks for the same thing".
				pendingResume =
					params.pendingDecision && projectedCheckpoint.pending
						? planPendingResume(projectedCheckpoint, params.pendingDecision, ctx.log)
						: null

				// Results of tools that finished before the process died. The
				// executor already emits one `tool_completed` per tool inline
				// and the transcript already persists it, so the record was
				// durable all along — it was simply never read back, and the
				// resumed run re-ran calls that had already charged a card or
				// sent an email.
				const unanswered = unansweredToolCalls(projectedCheckpoint.messages)
				recoveredResults =
					unanswered.length > 0
						? await recoverCompletedCalls(ctx.runMgr, unanswered, ctx.log)
						: new Map()

				// A batch caught MID-execution is a resume, not a fresh
				// decision: stripping the turn and letting the model re-decide
				// would re-run everything that already ran. Only taken when
				// the transcript proves execution had begun — a tool-review
				// park has no completions and keeps the cheap repair below.
				if (!pendingResume && recoveredResults.size > 0) {
					pendingResume = planCrashResume(projectedCheckpoint, recoveredResults, ctx.log)
				}

				// An incomplete turn with a durable owner is NOT abandoned. A
				// pending decision or crash-resume plan re-appends that exact
				// assistant with real/denied/recovered results below. Remove it
				// from the generic pass so no synthetic result competes with the
				// authority that still owns the call. Everything else is abandoned
				// history and is repaired conservatively rather than deleted.
				const abandonedCheckpointMessages = pendingResume
					? withoutOwnedResumeTurn(projectedCheckpoint.messages, pendingResume.assistant)
					: projectedCheckpoint.messages
				const checkpointRepair = repairToolMessageHistory(abandonedCheckpointMessages)
				const restoredMessages = checkpointRepair.messages
				if (toolHistoryRepairChanged(checkpointRepair.report)) {
					pendingHistoryRepairs.push({
						source: 'abandoned-checkpoint',
						report: checkpointRepair.report,
					})
					ctx.log.warn('Repaired abandoned tool history while restoring a checkpoint', {
						[NAMZU.RUN_ID]: ctx.runMgr.id,
						'namzu.checkpoint.id': checkpoint.id,
						'namzu.history.source': 'abandoned-checkpoint',
						'namzu.history.duplicate_tool_results_removed':
							checkpointRepair.report.duplicateToolResultsRemoved,
						'namzu.history.orphaned_tool_results_removed':
							checkpointRepair.report.orphanedToolResultsRemoved,
						'namzu.history.synthetic_tool_results_inserted':
							checkpointRepair.report.syntheticToolResultsInserted,
					})
				}

				for (const msg of restoredMessages) {
					if (msg.role === 'system') {
						// Re-push the FRESH static/dynamic floor (done above) but PRESERVE
						// the two system messages that carry irreplaceable run state: the
						// `[COMPACTED CONTEXT]` summary is the only surviving record of the
						// older history a compaction pass deleted, and the working-memory
						// slot pins the produced-artifact ledger. Dropping every system
						// message on restore silently lost both on resume.
						if (isCompactionMessage(msg.content) || isWorkingMemoryMessage(msg.content)) {
							ctx.runMgr.pushMessage(msg)
						}
						continue
					}
					ctx.runMgr.pushMessage(msg)
				}

				// The queue, on the resume path too. It is drained
				// unconditionally above, so leaving this out would take a
				// host's "start with this" off the record and deliver it
				// nowhere — the one outcome a durable queue must not have.
				//
				// AFTER the restored history rather than before it: on a
				// resume the conversation already exists, and a message left
				// for "the next run" is the newest thing said, not the oldest.
				for (const queued of queuedForThisRun) ctx.runMgr.pushMessage(queued)
			} else if (params.continuationMode) {
				for (const msg of initialMessages) {
					ctx.runMgr.pushMessage(msg)
				}
			} else {
				pushSystemMessages()
				let isFirstUserMessage = true
				for (const msg of initialMessages) {
					if (msg.role === 'system') {
						// A fresh run rebuilds its current static/dynamic prompt above,
						// so arbitrary historical system messages stay out. These two
						// are different: they are conversation STATE, and dropping them
						// deletes the only surviving record of compacted history or the
						// produced-artifact ledger. A compaction summary arriving from a
						// prior run is pinned because this new WorkingStateManager cannot
						// prove it has reconstructed equivalent state yet.
						if (isCompactionMessage(msg.content)) {
							ctx.runMgr.pushMessage({ ...msg, retain: true })
						} else if (isWorkingMemoryMessage(msg.content)) {
							ctx.runMgr.pushMessage(msg)
						}
						continue
					}
					ctx.runMgr.pushMessage(msg)

					if (workingStateManager && msg.role === 'user' && msg.content) {
						extractFromUserMessage(workingStateManager, msg.content, isFirstUserMessage)
						isFirstUserMessage = false
					}
				}
			}

			const assembledPrompt =
				segments.dynamic.length > 0
					? `${segments.static}\n\n---\n\n${segments.dynamic}`
					: segments.static

			ctx.runMgr.markRunning()
			await eventTranslator.emitEvent({
				type: 'run_started',
				runId: ctx.runMgr.id,
				systemPrompt: assembledPrompt,
			})
			yield* eventTranslator.drainPending()

			// The box is handed out HERE, after `run_started`, and the position
			// is load-bearing rather than tidy. It moved twice:
			//
			//  1. Beside the box's construction — a host that called `set`
			//     synchronously reached `eventTranslator` inside its temporal
			//     dead zone and killed the run before it started.
			//  2. Beside the translator's construction — the translator existed,
			//     but the run directory did not, so the durable append hit
			//     ENOENT on `transcript.jsonl`.
			//
			// Both were found by the test that takes the box and immediately
			// swaps the policy, which is not an exotic host: it is the shape of
			// "start unattended" wiring. A policy change is durably recorded
			// before it takes effect, so the handout cannot precede the run
			// being writable.
			params.onApprovalPolicy?.(approvalPolicy)

			// History repair happens before the run manager sees the first model
			// request, but its durable event cannot precede run_started: there is no
			// writable run log until that event initializes it. Emit the measured
			// counts here, still before any provider call, so hosts can tell that the
			// model received a repaired projection rather than the raw history.
			for (const repair of pendingHistoryRepairs) {
				await eventTranslator.emitEvent({
					type: 'message_history_repaired',
					runId: ctx.runMgr.id,
					source: repair.source,
					...repair.report,
				})
				yield* eventTranslator.drainPending()
			}

			// Surface capability degradation to the host as run events —
			// explicit, not silent (the log.warn above fires at setup time;
			// this is the machine-readable channel).
			if (stripToolSurfaces) {
				await eventTranslator.emitEvent({
					type: 'capability_warning',
					runId: ctx.runMgr.id,
					capability: 'tools',
					providerId: params.provider.id,
					message: `Provider '${params.provider.id}' does not support tools — ${registeredToolCount} registered tool(s) were stripped from the prompt and request.`,
				})
				yield* eventTranslator.drainPending()
			}
			if (attachmentMessageCount > 0) {
				await eventTranslator.emitEvent({
					type: 'capability_warning',
					runId: ctx.runMgr.id,
					capability: 'vision',
					providerId: params.provider.id,
					message: `Provider '${params.provider.id}' does not support vision — image attachments on ${attachmentMessageCount} user message(s) will not reach the model.`,
				})
				yield* eventTranslator.drainPending()
			}
			if (documentMessageCount > 0) {
				await eventTranslator.emitEvent({
					type: 'capability_warning',
					runId: ctx.runMgr.id,
					capability: 'documents',
					providerId: params.provider.id,
					message: `Provider '${params.provider.id}' does not support documents — document attachments on ${documentMessageCount} user message(s) will not reach the model.`,
				})
				yield* eventTranslator.drainPending()
			}

			if (params.pluginManager) {
				const hookResults = await params.pluginManager.executeHooks(
					'run_start',
					{ runId: ctx.runId },
					eventTranslator.emitEvent,
				)
				applyLifecycleHookResults('run_start', hookResults)
				yield* eventTranslator.drainPending()
			}

			// --- Sandbox lifecycle: create before iteration loop ---
			if (params.sandboxProvider) {
				const rootAtCwd = runConfig.sandbox?.workspace === 'working-directory'
				// Checked against what the CALLER passed, not against `ctx.cwd`.
				// `ctx.cwd` falls back to `process.cwd()`, so reading it here
				// would silently root the sandbox at whatever directory the
				// host process happens to be in — which is not the directory
				// anybody asked to confine, and is worse than the temp dir the
				// caller declined. Refused before the sandbox exists, and not
				// downgraded to ephemeral: a caller who asked for confinement
				// of a specific tree and quietly got an empty one has been
				// told their files are protected by something that is not
				// looking at them.
				if (rootAtCwd && params.workingDirectory === undefined) {
					throw new NamzuError({
						code: 'invalid_config',
						message:
							"sandbox.workspace is 'working-directory' but this run has no workingDirectory. Pass one, or use the default 'ephemeral' — the kernel will not fall back to a temp directory, because that would confine a directory you did not name.",
						details: { workspace: 'working-directory' },
					})
				}
				sandbox = await params.sandboxProvider.create({
					...(rootAtCwd ? { workingDirectory: ctx.cwd } : {}),
					timeoutMs: runConfig.sandbox?.timeoutMs,
					memoryLimitMb: runConfig.sandbox?.memoryLimitMb,
					maxProcesses: runConfig.sandbox?.maxProcesses,
				})
				toolExecutor.setSandbox(sandbox)

				await eventTranslator.emitEvent({
					type: 'sandbox_created',
					runId: ctx.runId,
					sandboxId: sandbox.id,
					environment: sandbox.environment,
				})
				yield* eventTranslator.drainPending()

				ctx.log.info('Sandbox created for run', {
					'namzu.sandbox.id': sandbox.id,
					'namzu.execution.environment': sandbox.environment,
					'namzu.runtime.root_dir': sandbox.rootDir,
				})
			}

			// Crash-save handlers live for exactly the run's lifetime, and are
			// removed in the `finally` below. Opt-in — see `emergencySave`.
			if (params.emergencySave) {
				const runDir = ctx.runMgr.getRunDir()
				if (runDir) {
					emergencyManager = EmergencySaveManager.instance(ctx.log)
					emergencyManager.attach(ctx.runMgr, runDir, ctx.log)
				} else {
					ctx.log.warn(
						'emergencySave requested but the run has no output directory — crash dumps disabled',
						{ [NAMZU.RUN_ID]: ctx.runId },
					)
				}
			}

			// Before the first model call: the cheapest place to refuse, since
			// nothing has been spent. Previously unreachable — `run_start`
			// fires with only `{ runId }` and `run_started` carries only the
			// system prompt, so no hook could see the user's message.
			const inputVerdict = await runInputGuardrails(
				params.inputGuardrails,
				{
					runId: ctx.runId,
					messages: ctx.runMgr.messages,
					...(segments?.static ? { systemPrompt: segments.static } : {}),
				},
				ctx.log,
			)
			if (inputVerdict.blocked) {
				await eventTranslator.emitEvent({
					type: 'guardrail_triggered',
					runId: ctx.runId,
					stage: 'input',
					action: 'block',
					...(inputVerdict.name ? { guardrail: inputVerdict.name } : {}),
					...(inputVerdict.reason ? { reason: inputVerdict.reason } : {}),
				})
				yield* eventTranslator.drainPending()
				// A guardrail block is a refusal — first-class in the audit trail
				// (LOG-14, design §5), not merely a RunEvent a host happens to be
				// subscribed to when it fires.
				await ctx.runMgr.recordAudit({
					what: { action: 'guardrail:input', resource: inputVerdict.name },
					outcome: 'refused',
					reason: inputVerdict.reason ?? 'blocked by an input guardrail',
					...(params.persona?.identity.role ? { persona: params.persona.identity.role } : {}),
				})
				ctx.runMgr.setStopReason('input_guardrail')
				ctx.runMgr.setLastError(inputVerdict.reason ?? 'blocked by an input guardrail')
				yield* resultAssembler.completeRun(rootSpan)
				return ctx.runMgr.getRun()
			}

			// Honor the approval a human already gave, before the loop's
			// first model call. The sandbox exists by now, so an approved
			// tool that needs one gets it.
			if (pendingResume) {
				ctx.log.info('Applying a pending HITL decision to the checkpointed tool calls', {
					[NAMZU.RUN_ID]: ctx.runId,
					'namzu.tool.names': pendingResume.response.message.toolCalls?.map(
						(tc) => tc.function.name,
					),
					'namzu.runtime.denied': pendingResume.denials.size,
				})
				// Hand the recorded answer to the already-built tool. The tool
				// closed over its registry when the agent was constructed,
				// long before this run existed, so the answers are copied in
				// rather than passed down.
				if (pendingResume.answers) {
					for (const [questionId, answer] of pendingResume.answers.entries()) {
						pendingAnswers.set(questionId, answer)
					}
				}

				await applyPendingResume(pendingResume, ctx.runMgr, toolExecutor, recoveredResults)
				yield* eventTranslator.drainPending()

				// The decision has now actually been carried out, so the park
				// is no longer outstanding. Without this the checkpoint keeps
				// reporting `pending` with no `resolvedAt`, and an approval
				// queue re-serves a destructive call that already ran — which
				// defeats the entire point of recording the park.
				const resolvedCheckpointId = pendingResume.checkpointId
				if (params.pendingDecision) {
					await checkpointMgr
						.unpark(resolvedCheckpointId, params.pendingDecision)
						.catch((err: unknown) => {
							ctx.log.error('Applied a pending decision but failed to clear the park', {
								[NAMZU.RUN_ID]: ctx.runId,
								'namzu.checkpoint.id': resolvedCheckpointId,
								'exception.message': err instanceof Error ? err.message : String(err),
							})
							return null
						})
				}
			}

			yield* iterationOrchestrator.runLoop()

			if (params.pluginManager) {
				const hookResults = await params.pluginManager.executeHooks(
					'run_end',
					{ runId: ctx.runId },
					eventTranslator.emitEvent,
				)
				applyLifecycleHookResults('run_end', hookResults)
				yield* eventTranslator.drainPending()
			}

			// Hand the step record to the run before it settles, so the
			// returned `Run` carries it.
			ctx.runMgr.setSteps(iterationOrchestrator.getSteps())

			// Gates the FINAL result, not the stream — `text_delta` already
			// reached the host as the model produced it. A rewrite is
			// therefore a correction, and the event says so; buffering every
			// token to gate the stream itself would trade the streaming UX
			// for the guarantee, which is the host's call, not the SDK's.
			if (params.outputGuardrails && params.outputGuardrails.length > 0) {
				// Read what the run produced WITHOUT settling it. This used to
				// call `markCompleted()` just to materialize the text, which
				// force-marked a cancelled or paused run `completed` merely
				// because a guardrail was configured — the presence of a
				// safety check silently rewrote the run's own outcome.
				const produced = ctx.runMgr.materializeResult()
				const outputVerdict = await runOutputGuardrails(
					params.outputGuardrails,
					{ runId: ctx.runId, output: produced, messages: ctx.runMgr.messages },
					ctx.log,
				)

				if (outputVerdict.blocked) {
					await eventTranslator.emitEvent({
						type: 'guardrail_triggered',
						runId: ctx.runId,
						stage: 'output',
						action: 'block',
						...(outputVerdict.name ? { guardrail: outputVerdict.name } : {}),
						...(outputVerdict.reason ? { reason: outputVerdict.reason } : {}),
					})
					yield* eventTranslator.drainPending()
					// Same reasoning as the input-guardrail branch above.
					await ctx.runMgr.recordAudit({
						what: { action: 'guardrail:output', resource: outputVerdict.name },
						outcome: 'refused',
						reason: outputVerdict.reason ?? 'blocked by an output guardrail',
						...(params.persona?.identity.role ? { persona: params.persona.identity.role } : {}),
					})
					ctx.runMgr.setStopReason('output_guardrail')
					ctx.runMgr.setLastError(outputVerdict.reason ?? 'blocked by an output guardrail')
					ctx.runMgr.setResult('')
				} else if (outputVerdict.rewritten !== undefined) {
					await eventTranslator.emitEvent({
						type: 'guardrail_triggered',
						runId: ctx.runId,
						stage: 'output',
						action: 'rewrite',
						...(outputVerdict.name ? { guardrail: outputVerdict.name } : {}),
						...(outputVerdict.reason ? { reason: outputVerdict.reason } : {}),
					})
					yield* eventTranslator.drainPending()
					ctx.runMgr.setResult(outputVerdict.rewritten)
				}
			}

			yield* resultAssembler.completeRun(rootSpan)
		} catch (err) {
			// A failed run still spent its steps; report them.
			ctx.runMgr.setSteps(iterationOrchestrator.getSteps())
			yield* resultAssembler.handleError(err, rootSpan)
		} finally {
			// Release the process's termination path as soon as this run is
			// done with it. Leaving the handlers installed would keep a
			// WeakRef'd, settled run as the crash target for the rest of the
			// process's life.
			emergencyManager?.detach()

			// A background job outlives the tool call that started it — that
			// is what it is for — so nothing but this stops it outliving the
			// RUN. Scoped to this run's id: a shared registry serving several
			// runs must not have one of them tear down another's work.
			//
			// Awaited, and its failure swallowed. A job that would not die is
			// worth a log line, and is not worth retracting a run's answer.
			if (params.backgroundJobs) {
				try {
					const stopped = await params.backgroundJobs.killOwner(ctx.runId)
					if (stopped.length > 0) {
						ctx.log.info('Background jobs stopped with the run', {
							[NAMZU.RUN_ID]: ctx.runId,
							'namzu.jobs.stopped': stopped.length,
						})
					}
				} catch (jobErr) {
					ctx.log.error('A background job did not stop cleanly', {
						[NAMZU.RUN_ID]: ctx.runId,
						...errorAttributes(jobErr),
					})
				}
			}

			// Same reasoning for the question channel: the tools outlive the
			// run that bound them, so leaving it attached would have a later
			// run's question written into this run's checkpoint store.
			questionParks.unbind()

			// Offer what the run learned to whoever decides what is worth
			// keeping. In `finally` and awaited: a run that failed still
			// discovered things, and a fire-and-forget write would race the
			// process exiting on a one-shot CLI run. A throw here is
			// swallowed — a memory that failed to form must not retract an
			// answer that was already produced.
			const candidate = memoryCandidateFor(ctx.runId, workingStateManager)
			if (params.promoteMemory && candidate) {
				try {
					await params.promoteMemory(candidate)
				} catch (promoteErr) {
					ctx.log.error('Memory promotion threw — the run is unaffected', {
						[NAMZU.RUN_ID]: ctx.runId,
						'exception.message':
							promoteErr instanceof Error ? promoteErr.message : String(promoteErr),
					})
				}
			}

			// --- Sandbox lifecycle: destroy after run ---
			if (sandbox) {
				const sandboxId = sandbox.id
				try {
					await sandbox.destroy()
					await eventTranslator.emitEvent({
						type: 'sandbox_destroyed',
						runId: ctx.runId,
						sandboxId,
					})
					ctx.log.info('Sandbox destroyed', { 'namzu.sandbox.id': sandboxId })
				} catch (destroyErr) {
					ctx.log.error('Sandbox destroy failed', {
						'namzu.sandbox.id': sandboxId,
						'exception.message':
							destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
					})
				}
			}

			unsubscribeTaskStore?.()
			// Keyed by HOW it settled, not just that it did: a run that was
			// cancelled and a run that hit its budget have very different
			// duration distributions, and averaging them together describes
			// neither.
			recordRunDuration(ctx.runMgr.getRun().status ?? 'unknown', Date.now() - runStartedAt)
			rootSpan.end()
		}

		return await resultAssembler.finalize()
	})()
}

/**
 * Hand a returning consumer what it missed, or tell it why it cannot have it.
 *
 * Yields NOTHING on a refusal. A partial catch-up is the failure this exists to
 * prevent: a consumer that receives some of the gap folds it into its state and
 * cannot tell the state is wrong, where one that receives an explicit
 * `unavailable` re-derives from the transcript and is right. The run continues
 * either way — a stale cursor belongs to the client, and must not be able to
 * stop the work.
 */
async function* catchUpFromCursor(
	runMgr: RunPersistence,
	cursor: RunEventCursor,
	onEventReplay: ((replay: RunEventReplay) => void) | undefined,
	generation: FencingToken | undefined,
): AsyncGenerator<RunEvent, void> {
	const missed = await runMgr.getRunStore().readEvents({ sinceSeq: cursor.sinceSeq })
	const replay = resolveRunEventReplay(
		cursor,
		{ lastSeq: runMgr.lastEventSeq, ...(generation !== undefined ? { generation } : {}) },
		missed,
	)

	onEventReplay?.(replay)

	if (replay.status !== 'replayed') return
	for (const event of replay.events) yield event
}

export async function drainQuery(
	params: Omit<QueryParams, 'resumeHandler'> & { resumeHandler?: ResumeHandler },
	listener?: RunEventListener,
): Promise<Run> {
	const fullParams: QueryParams = {
		...params,
		resumeHandler: params.resumeHandler ?? autoApproveHandler,
	}
	const gen = query(fullParams)
	let result = await gen.next()

	while (!result.done) {
		if (listener) {
			await listener(result.value)
		}
		result = await gen.next()
	}

	return result.value
}

function withDeferredDiscoveryTool(
	tools: ToolRegistryContract,
	allowedTools?: string[],
): string[] | undefined {
	if (!allowedTools) return undefined
	if (allowedTools.includes(SearchToolsTool.name)) return allowedTools

	const allowedHasDeferred = allowedTools.some(
		(name) => tools.has(name) && tools.getAvailability(name) === 'deferred',
	)
	if (!allowedHasDeferred) return allowedTools

	if (!tools.has(SearchToolsTool.name)) return allowedTools
	if (tools.getAvailability(SearchToolsTool.name) !== 'active') return allowedTools

	return [...allowedTools, SearchToolsTool.name]
}
