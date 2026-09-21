import {
	AdvisorRegistry,
	AdvisoryContext,
	AdvisoryExecutor,
	TriggerEvaluator,
	assertBudgetEnforceable,
} from '../../advisory/index.js'
import { AuthorizationGate } from '../../authorization/gate.js'
import { repairToolMessageHistory, toolHistoryRepairChanged } from '../../compaction/dangling.js'
import { extractFromUserMessage } from '../../compaction/extractor.js'
import { WorkingStateManager } from '../../compaction/manager.js'
import type { ContextReducer } from '../../compaction/reducer.js'
import { serializeState as serializeWorkingState } from '../../compaction/serializer.js'
import { restoreWorkingState, snapshotWorkingState } from '../../compaction/wire.js'
import { type CompactionConfig, CompactionConfigSchema } from '../../config/runtime.js'
import { childSessionLog } from '../../manager/agent/child-session.js'
import type { TurnRecorder } from '../../manager/session/turn-recorder.js'
import { PromptContributionRegistry } from '../../prompt/contributions.js'
import { resolveProviderCapabilities } from '../../provider/capabilities.js'
import type { ProviderChainMember } from '../../provider/fallback.js'
import { withStreamIdleTimeout } from '../../provider/idle-timeout.js'
import type { ProviderRetryConfig } from '../../provider/retry.js'
import { withTokenBudget } from '../../provider/token-budget.js'
// The session → turn surface QueryParams and query() are frozen against.
import type { SessionPaths } from '../../session/paths.js'
import type { SessionTokenBudget, SessionTokenBudgetStore } from '../../store/budget/index.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLease, SessionLog } from '../../store/session-log/index.js'
import {
	GENAI,
	NAMZU,
	agentTurnSpanName,
	parentContext,
	serializeSpan,
} from '../../telemetry/attributes.js'
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
import { isTerminalStatus } from '../../types/common/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { InputGuardrailSpec, OutputGuardrailSpec } from '../../types/guardrail/index.js'
import {
	type HITLResumeDecision,
	type ResumeHandler,
	autoApproveHandler,
} from '../../types/hitl/index.js'
import type { CheckpointId, MessageId, SessionId, TenantId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import type { MemoryStore } from '../../types/memory/index.js'
import {
	type AssistantMessage,
	type Message,
	createSystemMessage,
} from '../../types/message/index.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { TaskRouterConfig } from '../../types/router/index.js'
import type { Sandbox, SandboxProvider } from '../../types/sandbox/index.js'
import type { ReviewAnswer } from '../../types/session/answer-review.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type {
	BeforeStep,
	PrepareStepChain,
	StepResult,
	StopCondition,
} from '../../types/session/index.js'
import {
	type Origin,
	type SessionEvent,
	type SessionEventListener,
	type SessionLogCursor,
	type SessionLogReplay,
	type Turn,
	type TurnConfig,
	type TurnForkOrigin,
	type TurnId,
	isTurnInProgressError,
} from '../../types/session/index.js'
import type { PromoteMemory } from '../../types/session/memory-promotion.js'
import type { Skill } from '../../types/skills/index.js'
import type { StructuredOutputConfig } from '../../types/structured-output/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { RepairToolCall } from '../../types/tool/repair.js'
import type { BackoffPolicy } from '../../utils/backoff.js'
import type { ModelPricing } from '../../utils/cost.js'
import { toErrorMessage } from '../../utils/error.js'
import { errorAttributes } from '../../utils/log/exception.js'
import type { Logger } from '../../utils/logger.js'
import { AwaitedJobs } from '../jobs/awaited-jobs.js'
import type { BackgroundJobRegistry } from '../jobs/registry.js'
import { catchUpFromCursor, settlePreStartCancellation } from './cancelled-before-start.js'
import { CheckpointManager, findPendingCheckpoint } from './checkpoint.js'
import type { EventTranslator } from './events.js'
import { finalizeTurn } from './finalize-turn.js'
import { GuardCoordinator } from './guard.js'
import { runInputGuardrails } from './guardrails.js'
import { IterationOrchestrator } from './iteration/index.js'
import { isCompactionMessage } from './iteration/phases/compaction.js'
import { isWorkingMemoryMessage } from './iteration/phases/working-memory.js'
import { applyLifecycleHookResults } from './plugin-hooks.js'
import {
	type SelectedResumeState,
	prepareTurn,
	projectStateBearingHistory,
	resolveProviderContextWindow,
	selectedResumeStates,
} from './prepare-turn.js'
import type { ProjectInstructionContext } from './project-instructions.js'
import type { PromptCache } from './prompt-cache.js'
import { PromptBuilder } from './prompt.js'
import type { PromptSegments } from './prompt.js'
import { PendingAnswers, QuestionParkBinding } from './question-park.js'
import { releaseTurnResources } from './release-turn.js'
import { RepeatCallTracker } from './repeat-call.js'
import { ResultAssembler } from './result.js'
import {
	type PendingResumePlan,
	answersParkOf,
	applyPendingResume,
	interruptedToolCalls,
	planCrashResume,
	planPendingResume,
	recoverCompletedCalls,
	supersededByRecovery,
} from './resume-pending.js'
import { acquireSandbox } from './sandbox-lifecycle.js'
import { SteeringBinding, type SteeringChannel, isOperatorUserMessage } from './steering.js'
import { ToolGrantSet } from './tool-grants.js'
import { createToolPause } from './tool-pause.js'
import { ToolingBootstrap } from './tooling.js'

export interface QueryParams {
	/** Share observations across turns of one conversation and filesystem; otherwise run-local. */
	fileReadTracker?: import('../../types/tool/index.js').FileReadTracker
	/** One ledger shared with the task scheduler and descendant child sessions, keyed by (rootSessionId, rootTurnId). */
	budget?: SessionTokenBudget
	/**
	 * Where root-turn ledgers are kept (`<root-session-id>/budgets/<root-turn-id>.json`).
	 * Absent: beside the session under {@link QueryParams.paths}, or in memory
	 * for an in-memory {@link QueryParams.sessionLog}.
	 */
	tokenBudgetStore?: SessionTokenBudgetStore
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
	 * Which owner the run's background jobs belong to. Absent, the run id:
	 * jobs are stopped when the run ends. A host that wants a job to
	 * outlive the turn that started it — a dev server started in one turn
	 * and read in the next — passes its session id here and calls
	 * `backgroundJobs.killOwner(sessionId)` when the session ends; the run
	 * then stops nothing at its end and still tells the model when a job
	 * finishes.
	 */
	backgroundJobOwner?: string

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
	 * Maximum wall-clock time for resolving the run's stored attachments.
	 * Defaults to one minute; `0` retains the prior unbounded wait.
	 */
	attachmentResolveTimeoutMs?: number

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
	/** Per-run cumulative tool attempt limit, including nested calls and retries. Unset is unlimited. Re-supply on resume; durable reservations are never refunded. */
	maxToolCalls?: number

	/**
	 * Model-visible size cap for a single tool result. Over-budget output is
	 * spilled to the run directory and replaced with a head+tail preview
	 * naming the path, so nothing is lost and tokens are paid only if the
	 * agent decides the rest is worth re-reading. Set `0` to disable.
	 */
	maxToolOutputChars?: number
	/**
	 * Screens to run against every tool result, where the registry was not
	 * built with its own.
	 *
	 * This is the run's half of a boundary whose only other door is the
	 * registry constructor — and a registry is usually the HOST's, assembled
	 * before the run exists, so a run-config option is the only way a run
	 * screens a registry it did not build. A registry built WITH
	 * `resultGuardrails` states its own policy and wins, `[]` included.
	 *
	 * Absent installs {@link DEFAULT_TOOL_RESULT_GUARDRAILS}; an empty array
	 * installs none, which is how a caller turns the default off.
	 */
	toolResultGuardrails?: readonly import('../../types/guardrail/index.js').ToolResultGuardrailSpec[]
	/**
	 * Smaller preview for text that exceeded maxToolOutputChars, after its full
	 * host output and integrity manifest have been saved. Unset/0 keeps the old
	 * preview size. Does not change the spill threshold, rich blocks or ordinary
	 * results. A failed spill/manifest or a cap too small for its recovery path
	 * retains the ordinary output budget. Re-supply on resume.
	 */
	retainedToolPreviewChars?: number

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
	 * Exceptions or malformed verdicts fail the run; cancellation stops waiting.
	 */
	reviewAnswer?: ReviewAnswer

	/**
	 * Decide what this run should leave behind when it settles.
	 *
	 * See {@link PromoteMemory}. Absent means nothing is offered and the
	 * run behaves exactly as it did.
	 */
	promoteMemory?: PromoteMemory

	/** Corrections allowed before the run stops. Nonnegative safe integer; default 3. Consumed rejections survive checkpoints. */
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
	 * Produce a locally validated structured result. Defaults to an output tool;
	 * mode:'native' requests JSON Schema from an explicitly capable driver.
	 * Host review and bounded corrections apply before publication.
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
	turnConfig: TurnConfig
	allowedTools?: string[]
	agentId: string
	agentName: string
	workingDirectory?: string
	/**
	 * Directories besides the working directory the file tools may reach,
	 * absolute; a sandboxed run binds each read-write. See
	 * `ToolContext.additionalDirectories`.
	 */
	additionalDirectories?: readonly string[]
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
	 * Where the session lives on disk (`<NAMZU_HOME>/projects/<slug>/…`).
	 * Defaults to `SessionPaths` under `resolveNamzuHome()`. Namzu never writes
	 * under the working directory.
	 */
	paths?: SessionPaths

	/**
	 * Optional checkpoint persistence override. Absent: checkpoint documents go
	 * to `<session-id>/checkpoints/`, or stay in memory for an in-memory
	 * {@link QueryParams.sessionLog}.
	 */
	checkpointStore?: SessionCheckpointStore

	/**
	 * The lease this worker holds on the session, from `claimSession`. Every
	 * record the turn appends carries its fence (`gen`), so a worker that
	 * stalled past its lease is refused rather than writing into a session
	 * somebody else has taken over. Absent: `query()` claims the lease itself
	 * and releases it when the turn settles or parks.
	 */
	lease?: SessionLease

	/**
	 * The session log this turn appends to. Defaults to the log at
	 * {@link QueryParams.paths}. An `InMemorySessionLog` with no `paths` keeps
	 * the whole session in memory: its checkpoints, its ledger and its child
	 * sessions.
	 */
	sessionLog?: SessionLog

	/**
	 * Where a reconnecting consumer left off, so this run's stream can start by
	 * handing back what it missed.
	 *
	 * The case this serves is the one that exists without a network hop: the
	 * process holding the run died, and the consumer watching it is coming back
	 * to a run that has to be resumed. Pair it with `resumeFromCheckpoint` — or
	 * reach it through {@link import('./resume-session.js').resumeSession}, which is the
	 * surface that does both — and the missed durable events are yielded, in
	 * order, before the resumed run emits anything of its own.
	 *
	 * On a run with no log to catch up on the cursor is answered honestly rather
	 * than ignored: a `sinceSeq` above what exists is `cursor_ahead`, not
	 * silence.
	 *
	 * What comes back is message-granular. Streaming deltas are never persisted
	 * — see {@link import('../../types/session/events.js').isEphemeralEvent} —
	 * so a late subscriber recovers the assistant text, the tool results and the
	 * lifecycle, not the keystroke cadence that produced them.
	 */
	eventCursor?: SessionLogCursor

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
	onEventReplay?: (replay: SessionLogReplay) => void

	/**
	 * Continue this turn (with `resumeFromCheckpoint`). Absent: a new turn is
	 * begun, and refused with `TurnInProgressError` when the session already
	 * has an active one.
	 */
	turnId?: TurnId

	/**
	 * Close an `interrupted` active turn — one whose process is gone — with
	 * `turn_failed{interrupted}` before this turn begins, instead of refusing
	 * with `TurnInProgressError`. A running or paused turn is never closed
	 * this way. An interactive host that never resumes an interrupted turn
	 * sets it.
	 */
	abandonInterrupted?: boolean

	/**
	 * Which protocol opened this turn, and the caller-side ids it used
	 * (`turn_started.origin`). A protocol adapter records the client's own
	 * turn id here (`externalTurnId`) rather than making it a namzu id.
	 */
	origin?: Origin

	/**
	 * Present when this session was forked from another session's checkpoint:
	 * written into `session_started.forkedFrom` when the log is started, and
	 * carried on the returned turn. See `prepareReplayState`.
	 */
	forkedFrom?: TurnForkOrigin

	/** Present on a child session: the session that delegated it. */
	parentSessionId?: SessionId

	/** Present on a child session: the parent turn whose tool call spawned it. */
	parentTurnId?: TurnId

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
	 * Wake a background-task hold when operator input is available, without draining it.
	 * Resolve immediately if input is already pending. Otherwise wait for its arrival;
	 * the supplied signal ends the wait and must release any listeners. Messages are
	 * still consumed only through `inboundMessages` at a provider-valid boundary.
	 */
	waitForInbound?: (signal: AbortSignal) => Promise<void>

	/**
	 * Live project policy for this run. Unlike `inboundMessages`, snapshot
	 * replacement is durable state and never implies another model turn.
	 */
	projectInstructionContext?: ProjectInstructionContext

	/**
	 * Where this conversation's durable state lives.
	 *
	 * Supplies the permission mode when `turnConfig.permissionMode` names
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
	permissionModeRef?: {
		current: import('../../types/permission/index.js').PermissionMode
	}

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
	onApprovalPolicy?: (policy: import('../../types/hitl/policy.js').SessionApprovalPolicy) => void

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
	 * Where what the run learned is written when it ends: its decisions,
	 * discoveries and failures, as one entry tagged `learning`. Episodic
	 * memory (the working state) dies with the run; this is the bridge to
	 * the semantic store a later run searches. Absent means nothing is
	 * written. A store that fails is logged and never fails the run.
	 */
	consolidateInto?: MemoryStore

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

	/**
	 * Maximum time the run waits for sandbox teardown, in milliseconds.
	 *
	 * Defaults to 30 seconds. A fresh private signal is passed to `destroy()`;
	 * the run also races the returned promise so an implementation that ignores
	 * cancellation cannot pin `drainQuery()`. Set `0` to retain an unbounded
	 * teardown wait.
	 */
	sandboxTeardownTimeoutMs?: number

	invocationState?: InvocationState

	/**
	 * Capability-mismatch handling. Default `false`: when the request asks
	 * for something the provider driver declared it cannot do (tools
	 * registered against a `supportsTools: false` driver, image
	 * attachments against a `supportsVision: false` driver), the runtime
	 * warns loudly, emits a `capability_warning` run event, and degrades
	 * explicitly (tool surfaces stripped from prompt + request;
	 * attachments left unmapped by the driver). The same policy is checked
	 * immediately before every request for image/document blocks produced by a
	 * tool, because those do not exist at run setup. `true`: throw instead of
	 * degrading.
	 */
	strictCapabilities?: boolean
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

/**
 * The history plus the part of the owned resume turn that already RAN, for the
 * observation ledger to be seeded from.
 *
 * `withoutOwnedResumeTurn` takes that turn out so generic repair cannot answer
 * it, and the plan re-appends it much later — after the sandbox exists, after
 * the input guardrails, immediately before the loop. Seeding from the list the
 * model finally sees would therefore have to happen after `applyPendingResume`,
 * and that is the wrong seam for a reason that is not about ordering: the plan
 * does not merely re-append the turn, it EXECUTES the calls in it that never
 * started. Those tools read the ledger this seeding builds, so a seed placed
 * after them would refuse the very write the resume exists to carry out — no
 * `hasRead` for a file the conversation had read three turns earlier.
 *
 * So the turn is folded in here instead, and only as far as it actually got.
 * A call `recoverCompletedCalls` found an outcome for is one that ran: its
 * receipt goes in beside it, and the walk reads it exactly as it reads any
 * other — a completed `write` restores the body it put there, and the
 * unknown-outcome result the recovery writes for an interrupted one withdraws
 * the path instead. A call ABSENT from that map is absent because a complete
 * scan proved it has no recorded start, so the file it names is untouched and
 * the claim history established for it still stands; leaving it out is what
 * lets it execute in a moment. Without any of this the seed never saw the
 * turn at all, and an executed write inside it left the pre-write body standing
 * as a claim until the next mutation's drift check happened to catch it.
 */
function withOwnedResumeOutcomes(
	messages: readonly Message[],
	assistant: AssistantMessage,
	recovered: ReadonlyMap<string, { result: string; isError: boolean }>,
): Message[] {
	const ran = (assistant.toolCalls ?? []).flatMap((call) => {
		const outcome = recovered.get(call.id)
		return outcome ? [{ call, outcome }] : []
	})
	if (ran.length === 0) return [...messages]
	return [
		...messages,
		{ ...assistant, toolCalls: ran.map(({ call }) => call) },
		...ran.map(
			({ call, outcome }): Message => ({
				role: 'tool',
				toolCallId: call.id,
				content: outcome.result,
				isError: outcome.isError,
			}),
		),
	]
}

export async function* query(params: QueryParams): AsyncGenerator<SessionEvent, Turn> {
	const prepared = await prepareTurn(params)
	const {
		turnConfig,
		budget,
		log,
		ctx,
		resilientProvider,
		serving,
		providerContextWindow,
		modelContextWindows,
		approvalPolicy,
		eventTranslator,
		executeUserInterruptHooks,
		pendingHistoryRepairs,
		initialMessages,
		historyIds,
		queuedForThisRun,
		selectedResumeState,
		attachmentResolutionCancelled,
		streamIdleTimeoutMs,
		sandboxTeardownTimeoutMs,
		promptCache,
		taskScheduler,
	} = prepared

	if (attachmentResolutionCancelled) {
		try {
			return yield* settlePreStartCancellation(params, prepared)
		} finally {
			await ctx.recorder.release()
		}
	}

	// Everything from here to the turn body can refuse (a capability the
	// provider lacks, a sandbox mode it does not offer); the lease the
	// prelude took is given back on the way out.
	let unsubscribeChildSessions: (() => void) | undefined
	try {
		const unsubscribeTaskStore = params.taskStore
			? eventTranslator.wireTaskStore(params.taskStore, ctx.sessionId)
			: undefined
		// The children this turn delegates to are recorded in this session's
		// log: `child_session_spawned` when one starts, `child_session_ended`
		// (read from the child's own log) when it goes idle. That is what lets
		// the parent list and replay its children once the process is gone.
		unsubscribeChildSessions = taskScheduler?.onChildSessionEvent?.((event) => {
			// Looked up now, while the manager still holds the child's spawn record.
			const childLog =
				event.type === 'child_session_idled' ? childSessionLog(event.childSessionId) : undefined
			void ctx.recorder.recordChildSessionEvent(event, childLog).catch((err: unknown) => {
				ctx.log.warn('A child session record could not be appended', {
					[NAMZU.TURN_ID]: ctx.turnId,
					'namzu.child_session.id': event.childSessionId,
					'exception.message': err instanceof Error ? err.message : String(err),
				})
			})
		})

		if (params.taskStore) {
			const taskTools = buildTaskTools(params.taskStore, {
				sessionId: ctx.sessionId,
				turnId: ctx.turnId,
				turnStartedAt: ctx.recorder.getTurn().startedAt,
			})
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
		if (
			params.structuredOutput &&
			params.structuredOutput.mode !== 'native' &&
			!params.tools.has(STRUCTURED_OUTPUT_TOOL_NAME)
		) {
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
					details: {
						providerId: params.provider.id,
						capability: 'tools',
						registeredToolCount,
					},
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
					details: {
						providerId: params.provider.id,
						capability: 'vision',
						attachmentMessageCount,
					},
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
					details: {
						providerId: params.provider.id,
						capability: 'documents',
						documentMessageCount,
					},
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
		// on `ReactiveAgent`, `drainQuery` or `resumeSession` had no way to supply
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

		// One gate instance owns both model-issued calls and calls dispatched by
		// another tool. Constructing it only inside the iteration review left the
		// nested registry path outside the operator's policy entirely.
		const gateConfig = params.authorizationGate
		const verificationGate = gateConfig?.enabled
			? new AuthorizationGate(gateConfig, ctx.log)
			: undefined

		// Oversized tool output is spilled beside the session log
		// (`<session-id>/tool-results/`). An in-memory session has nowhere to
		// spill it, so the ordinary output budget applies.
		const toolOutputDir = () => ctx.toolResultsDir
		// The same invocation-owned capability serves tools and optional preparation.
		// Local cancellation cannot override the run's cancellation or settled state.
		const captureSessionEvidence = async (maxReadBytes?: number, signal?: AbortSignal) => {
			const combined = signal
				? AbortSignal.any([ctx.abortController.signal, signal])
				: ctx.abortController.signal
			combined.throwIfAborted()
			const source = await eventTranslator.captureSessionEvidence(maxReadBytes, combined)
			combined.throwIfAborted()
			return source
		}

		// Whose jobs this run speaks for: its own by default, the session's when
		// the host said so. Resolved before the tools are built, because the
		// wait-intent recorder below is bound into them.
		const jobOwner = params.backgroundJobOwner ?? ctx.turnId
		// What the model reads when a job ends. Built up here, ahead of the
		// subscription that fills it below, because the wait-intent recorder needs
		// to ask whether its text has been read yet.
		const jobNotices = params.backgroundJobs ? new SteeringBinding() : undefined
		// Jobs the model told `wait_for_job` it is waiting on, which is the only
		// thing that can hold this run open for a job. Built only where there is a
		// registry, so a host with no background mode carries no recorder and the
		// bound ref has no `markAwaited` to offer.
		const awaitedJobs = params.backgroundJobs
			? new AwaitedJobs(params.backgroundJobs, jobOwner, () => jobNotices?.pending ?? false)
			: undefined
		awaitedJobs?.attach()

		const toolExecutor = ToolingBootstrap.init(
			{
				tools: params.tools,
				sessionId: ctx.sessionId,
				turnId: ctx.turnId,
				workingDirectory: ctx.cwd,
				...(params.additionalDirectories?.length
					? { additionalDirectories: params.additionalDirectories }
					: {}),
				permissionMode: () => ctx.permissionMode.current,
				env: turnConfig.env ?? {},
				abortSignal: ctx.abortController.signal,
				allowedTools: effectiveAllowedTools,
				invocationState: params.invocationState,
				pluginManager: params.pluginManager,
				...(params.backgroundJobs ? { backgroundJobs: params.backgroundJobs } : {}),
				...(params.backgroundJobOwner ? { backgroundJobOwner: params.backgroundJobOwner } : {}),
				...(awaitedJobs ? { onJobAwaited: (id: string) => awaitedJobs.expect(id) } : {}),
				// The `skill` tool's registry. Threaded from the run rather than
				// held by the tool, because a tool that reached for a module-level
				// registry would answer about whatever the last run configured.
				...(params.skillRegistry ? { skills: params.skillRegistry } : {}),
				...(params.web ? { web: params.web } : {}),
				...(params.fileReadTracker ? { fileReadTracker: params.fileReadTracker } : {}),
				...(params.toolTimeoutMs !== undefined ? { toolTimeoutMs: params.toolTimeoutMs } : {}),
				...(params.toolRetryBackoff !== undefined
					? { toolRetryBackoff: params.toolRetryBackoff }
					: {}),
				...(params.maxToolCalls !== undefined
					? {
							maxToolCalls: params.maxToolCalls,
							readToolCallBudgetRecords: () => eventTranslator.readRecords({ mode: 'strict' }),
						}
					: {}),
				...(params.maxToolConcurrency !== undefined
					? { maxToolConcurrency: params.maxToolConcurrency }
					: {}),
				...(params.maxToolOutputChars !== undefined
					? { maxToolOutputChars: params.maxToolOutputChars }
					: {}),
				...(params.toolResultGuardrails !== undefined
					? { toolResultGuardrails: params.toolResultGuardrails }
					: {}),
				...(params.retainedToolPreviewChars !== undefined
					? { retainedToolPreviewChars: params.retainedToolPreviewChars }
					: {}),
				...(params.maxToolContentBytes !== undefined
					? { maxToolContentBytes: params.maxToolContentBytes }
					: {}),
				// Overflow lands beside the run's other artifacts, so it is
				// cleaned up with the run and reachable by the model's own
				// `read`/`grep` without a new affordance.
				toolOutputDir,
				captureSessionEvidence,
				...(params.repairToolCall ? { repairToolCall: params.repairToolCall } : {}),
				...(verificationGate ? { authorizationGate: verificationGate } : {}),
				recordAudit: (input) => ctx.recorder.recordAudit(input),
				// The durable pause, reachable from any tool rather than from the
				// four kernel-owned points that used to own it. Built here from
				// the machinery the run already holds; the recorder binds a few
				// lines below, and until it does a pause is in-process only —
				// the same degradation the built-in question tool has.
				toolPause: (toolUseId) =>
					createToolPause({
						sessionId: ctx.sessionId,
						turnId: ctx.turnId,
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

		// A background job's exit reaches the model as a notice on its next tool
		// result, and the host as an event — without either polling. Subscribed
		// for the owner the run's jobs are bound to, so a session-owned job that
		// ends during this run is reported here too.
		const unsubscribeJobExits = params.backgroundJobs?.onExit((job) => {
			if (job.owner !== jobOwner) return
			const outcome =
				job.status === 'killed'
					? 'was stopped'
					: `exited with code ${job.exitCode ?? 'unknown'}${job.signal ? ` (${job.signal})` : ''}`
			jobNotices?.steer(
				`Background job ${job.id} (${job.command}) ${outcome}. Read its output with the job tool if you need it.`,
			)
			void eventTranslator
				.emitEvent({
					type: 'background_job_exited',
					turnId: ctx.turnId,
					jobId: job.id,
					command: job.command,
					status: job.status === 'killed' ? 'killed' : 'exited',
					...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
					...(job.signal ? { signal: job.signal } : {}),
				})
				.catch(() => {})
		})
		let workingStateManager: WorkingStateManager | undefined
		// Normalised once, defaults applied. A host that passes a partial
		// object — a strategy and a window, nothing else — used to reach the
		// phase with `triggerThreshold` undefined, and `usage < undefined` is
		// false: the pass ran on every iteration and the salience strategy fell
		// through to the stale-result clearing it exists to replace. The eval
		// suite that passed exactly that object found it.
		const compactionConfig = params.compactionConfig
			? CompactionConfigSchema.parse(params.compactionConfig)
			: undefined
		if (compactionConfig && compactionConfig.strategy !== 'disabled') {
			workingStateManager = new WorkingStateManager(compactionConfig)
			toolExecutor.setWorkingStateManager(workingStateManager)
		}

		// The run's own registry when the host passed none, so a hook's
		// annotation has somewhere to land.
		const promptContributions = params.promptContributions ?? new PromptContributionRegistry()

		const promptBuilder = new PromptBuilder({
			systemPrompt: params.systemPrompt,
			persona: params.persona,
			skills: params.skills,
			basePrompt: params.basePrompt,
			tools: params.tools,
			allowedTools: effectiveAllowedTools,
			runtimeContext: params.runtimeContext,
			contributions: promptContributions,
		})

		const guard = new GuardCoordinator({
			tokenBudget: turnConfig.tokenBudget,
			timeoutMs: turnConfig.timeoutMs,
			costLimitUsd: turnConfig.costLimitUsd,
			maxIterations: turnConfig.maxIterations,
		})

		const checkpointMgr = new CheckpointManager(ctx.recorder, ctx.storage.checkpoints, {
			tenantId: ctx.tenantId,
			projectId: ctx.projectId,
			sessionId: ctx.sessionId,
			turnId: ctx.turnId,
		})

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
			recorder: ctx.recorder,
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
				provider: withTokenBudget(
					withStreamIdleTimeout(advisor.provider, {
						idleTimeoutMs: streamIdleTimeoutMs,
						log: ctx.log,
					}),
					budget,
				),
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
					messages: ctx.recorder.messages,
					turn: iterationOrchestrator.getAdvisoryTurnContext(),
					...(summary !== undefined ? { workingStateSummary: summary } : {}),
					...(advisoryConfig.includeToolCatalog
						? { toolCatalog: params.tools.toLLMTools(effectiveAllowedTools) }
						: {}),
					iteration: ctx.recorder.currentIteration,
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

		const iterationOrchestrator = new IterationOrchestrator({
			captureSessionEvidence,
			provider: resilientProvider,
			providerCapabilities: capabilities,
			strictCapabilities: params.strictCapabilities === true,
			servingMember: () => serving.current,
			turnConfig,
			...(params.stopWhen ? { stopWhen: params.stopWhen } : {}),
			...(params.prepareStep ? { prepareStep: params.prepareStep } : {}),
			...(params.beforeStep ? { beforeStep: params.beforeStep } : {}),
			...(params.onStepFinish ? { onStepFinish: params.onStepFinish } : {}),
			...(params.reviewAnswer ? { reviewAnswer: params.reviewAnswer } : {}),
			...(params.maxAnswerReviews !== undefined
				? { maxAnswerReviews: params.maxAnswerReviews }
				: {}),
			...(params.structuredOutput ? { structuredOutput: params.structuredOutput } : {}),
			...(params.parkRecordDelayMs !== undefined
				? { parkRecordDelayMs: params.parkRecordDelayMs }
				: {}),
			tools: params.tools,
			allowedTools: effectiveAllowedTools,
			recorder: ctx.recorder,
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
			promptContributions,
			...(params.steering ? { steering: params.steering } : {}),
			...(jobNotices ? { jobNotices } : {}),
			...(awaitedJobs ? { awaitedJobs } : {}),
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
			compactionConfig,
			...(params.inboundMessages ? { inboundMessages: params.inboundMessages } : {}),
			...(params.resumeFromCheckpoint ? { resumedInput: queuedForThisRun } : {}),
			...(params.waitForInbound ? { waitForInbound: params.waitForInbound } : {}),
			...(params.projectInstructionContext
				? { projectInstructionContext: params.projectInstructionContext }
				: {}),
			...(providerContextWindow !== undefined ? { providerContextWindow } : {}),
			resolveModelContextWindow: async (model) => {
				if (!modelContextWindows.has(model)) {
					modelContextWindows.set(
						model,
						await resolveProviderContextWindow(
							resilientProvider,
							model,
							ctx.abortController.signal,
							turnConfig.timeoutMs,
							log,
						),
					)
				}
				return modelContextWindows.get(model)
			},
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

		// Whether the run reached its settle. Read by the `finally` below, and
		// the only thing that distinguishes a run that finished from one whose
		// consumer walked away — see `settleAbandonedTurn`.
		let settled = false

		const runBody = (async function* (): AsyncGenerator<SessionEvent, Turn> {
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
			const resumedTrace = selectedResumeState
				? selectedResumeState.traceContext
				: params.resumeFromCheckpoint
					? await checkpointMgr.readTraceContext(params.resumeFromCheckpoint)
					: undefined

			const rootSpan = tracer.startSpan(
				agentTurnSpanName(params.agentName),
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
			checkpointMgr.setParkTtl(turnConfig.hitlParkTtlMs)
			// A question raised from inside a tool becomes a real checkpoint
			// here. It used to park under a synthetic id nothing ever wrote, so
			// the checkpoint did not exist: nothing on disk said a human owed
			// this run an answer, and a remote host could not observe the
			// question at all.
			questionParks.bind({
				record: async (question) => {
					try {
						const checkpoint = await checkpointMgr.create(
							ctx.recorder,
							ctx.recorder.currentIteration,
						)
						await checkpointMgr.park(checkpoint, {
							type: 'user_question',
							sessionId: ctx.sessionId,
							turnId: ctx.turnId,
							checkpointId: checkpoint.id,
							question,
						})
						await eventTranslator.emitEvent({
							type: 'user_question_asked',
							checkpointId: checkpoint.id,
							questionId: question.questionId,
							question: question.question,
						})
						return checkpoint.id
					} catch (err) {
						// A store that cannot record the park must not take the
						// tool down with it: the in-process await is still valid
						// and only the cross-process handoff is lost. Loudly,
						// because a host building an approval queue from durable
						// state will not see this question.
						ctx.log.error('Failed to record a question park — it is not resumable', {
							[NAMZU.TURN_ID]: ctx.recorder.turnId,
							'namzu.runtime.question_id': question.questionId,
							'exception.message': err instanceof Error ? err.message : String(err),
						})
						return null
					}
				},
				resolve: async (checkpointId, decision) => {
					await checkpointMgr.unpark(checkpointId, decision).catch((err: unknown) => {
						ctx.log.error('Failed to clear a recorded question park', {
							[NAMZU.TURN_ID]: ctx.recorder.turnId,
							'namzu.checkpoint.id': checkpointId,
							'exception.message': err instanceof Error ? err.message : String(err),
						})
						return null
					})
					await eventTranslator.emitEvent({
						type: 'user_question_answered',
						checkpointId,
						...(decision.action === 'answer_question' && decision.questionId !== undefined
							? { questionId: decision.questionId }
							: {}),
						answered: decision.action === 'answer_question',
					})
				},
			})
			rootSpan.setAttributes({
				[GENAI.CONVERSATION_ID]: ctx.sessionId,
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				...(params.parentSessionId !== undefined && {
					[NAMZU.SESSION_PARENT_ID]: params.parentSessionId,
				}),
				[GENAI.AGENT_NAME]: params.agentName,
				[GENAI.AGENT_ID]: params.agentId,
				[GENAI.REQUEST_MODEL]: turnConfig.model,
				[GENAI.SYSTEM]: params.provider.id,
			})

			let sandbox: Sandbox | undefined
			// Decided during checkpoint restore, executed after the sandbox
			// exists — the approved tools may well need it.
			let pendingResume: PendingResumePlan | null = null
			/** The record id of the parked assistant message the plan re-appends. */
			let pendingResumeAssistantId: MessageId | undefined
			/**
			 * The cadence park this resume answered, when the decision is one the
			 * ordinary continue path carries out. See the restore path below.
			 */
			let answeredParkId: CheckpointId | undefined
			/** Tool results recovered from the transcript; see the restore path. */
			let recoveredResults: ReadonlyMap<string, { result: string; isError: boolean }> = new Map()

			try {
				// A consumer coming back gets what it missed BEFORE the turn says
				// anything new, which is the only order that lets it fold one
				// stream into one state. It follows the prelude's `open()` — which
				// took the lease and read the log's head — and precedes every emit
				// below.
				if (params.eventCursor) {
					yield* catchUpFromCursor(
						ctx.recorder,
						params.eventCursor,
						params.onEventReplay,
						(error) => {
							ctx.log.warn('Replay observer failed', {
								'exception.message': toErrorMessage(error),
							})
						},
					)
				}

				ctx.log.info('Starting query', {
					[NAMZU.TURN_ID]: ctx.recorder.turnId,
					'namzu.runtime.agent': params.agentName,
					[GENAI.REQUEST_MODEL]: turnConfig.model,
					'namzu.runtime.token_budget': turnConfig.tokenBudget,
					'namzu.runtime.activity_tracking': ctx.activityStore.enabled,
					'namzu.runtime.permission_mode': ctx.permissionMode.current,
					'namzu.runtime.resume_from_checkpoint': params.resumeFromCheckpoint ?? null,
				})

				// The operator's prompt, before the model sees it. A hook may
				// refuse it — the run ends here, before a prompt is built — or add
				// to what the model is told; the addition rides the prompt as a
				// dynamic contribution so every iteration of the run carries it.
				if (params.pluginManager) {
					const hookResults = await params.pluginManager.executeHooks(
						'user_prompt_submit',
						{
							turnId: ctx.turnId,
							sessionId: params.sessionId,
							prompt: lastUserPrompt(initialMessages),
							signal: ctx.abortController.signal,
						},
						eventTranslator.emitEvent,
					)
					const annotations = applyLifecycleHookResults('user_prompt_submit', hookResults)
					if (annotations.length > 0) {
						promptContributions.replace({
							id: 'hooks:user_prompt_submit',
							placement: 'dynamic',
							render: () => `Context from the operator's hooks:\n\n${annotations.join('\n\n')}`,
						})
					}
					yield* eventTranslator.drainPending()
				}

				const contextLevel = params.contextLevel ?? 'full'
				const cacheInput = {
					systemPrompt: params.systemPrompt,
					persona: params.persona,
					skills: params.skills,
					basePrompt: contextLevel === 'full' ? params.basePrompt : undefined,
					tools: params.tools,
					allowedTools: effectiveAllowedTools,
					runtimeContext: params.runtimeContext,
					contributions: promptContributions,
				}

				const segments: PromptSegments = promptCache
					? promptCache.getSystemPromptSegmented(cacheInput, contextLevel, params.workingDirectory)
					: promptBuilder.buildSegmented(contextLevel, params.workingDirectory)

				ctx.log.info('Prompt segments assembled', {
					'namzu.runtime.static_length': segments.static.length,
					'namzu.runtime.dynamic_length': segments.dynamic.length,
				})

				// The prompt floor is rebuilt every turn and never recorded:
				// `turn_started.systemPrompt` carries it.
				const pushSystemMessages = (): void => {
					ctx.recorder.pushMessage(createSystemMessage(segments.static, 'cache'), {
						transient: true,
					})
					if (segments.dynamic.length > 0) {
						ctx.recorder.pushMessage(createSystemMessage(segments.dynamic, 'ephemeral'), {
							transient: true,
						})
					}
				}
				const pushRestored = (message: Message, ids: ReadonlyMap<Message, MessageId>): void => {
					const messageId = ids.get(message)
					ctx.recorder.pushMessage(message, messageId ? { messageId } : {})
				}

				if (params.resumeFromCheckpoint) {
					const checkpoint = await checkpointMgr.restore(params.resumeFromCheckpoint)
					const projectedCheckpoint = {
						...checkpoint,
						messages: projectStateBearingHistory(checkpoint.messages, {
							pinCompaction: false,
						}),
					}
					await eventTranslator.resumeTurn(checkpoint.id)
					yield* eventTranslator.drainPending()

					// Budgets are properties of the RUN, not of the process hosting
					// it. The checkpoint already carried all three; they were
					// written and then discarded on the way back in, so a run
					// recalled at $4.80 of a $5 cap came back with a fresh $5 and
					// a fresh timeout clock. Restore before the first iteration so
					// a resumed run that is already over budget stops immediately.
					ctx.recorder.restoreUsage(
						checkpoint.document.tokenUsage,
						checkpoint.document.costInfo,
						checkpoint.document.guards.iteration,
					)
					guard.restoreElapsed(checkpoint.document.guards.elapsedMs)

					// Adopt the working state the earlier summary was built from.
					// The `[COMPACTED CONTEXT]` block below is preserved precisely
					// because it is the only surviving record of the history the
					// first pass deleted — and without this, the NEXT compaction
					// would drop it and replace it with a summary covering only
					// what happened after the resume, silently losing the run's
					// first hour.
					if (workingStateManager && checkpoint.document.workingState && compactionConfig) {
						const revived = restoreWorkingState(checkpoint.document.workingState, compactionConfig)
						workingStateManager.replaceState(revived.getState())
						ctx.log.info('Restored compaction working state from checkpoint', {
							[NAMZU.TURN_ID]: ctx.recorder.turnId,
							'namzu.checkpoint.id': checkpoint.id,
							'namzu.runtime.slots': workingStateManager.slotCount(),
						})
					}
					ctx.log.info('Restored budgets from checkpoint', {
						[NAMZU.TURN_ID]: ctx.recorder.turnId,
						'namzu.checkpoint.id': checkpoint.id,
						'namzu.usage.total_tokens': checkpoint.document.tokenUsage.totalTokens,
						'namzu.runtime.total_cost': checkpoint.document.costInfo.totalCost,
						[NAMZU.ITERATION]: checkpoint.document.guards.iteration,
						'namzu.runtime.elapsed_ms': checkpoint.document.guards.elapsedMs,
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

					// The park this resume ANSWERS even though there is no plan to
					// carry the decision out through.
					//
					// `planPendingResume` covers the two arms whose decision has to
					// reach something — the calls a `tool_review` park is about, the
					// tool a `user_question` park is inside. An `iteration_checkpoint`
					// park has neither, so it returns no plan, and the unpark further
					// down — which ran only when there was one — never fired for it.
					// A run that parked on the cadence, was resumed with
					// `{action: 'continue'}` and went on to finish its work therefore
					// kept reporting an OUTSTANDING park to `findPendingCheckpoint`,
					// so a second resume of the finished run was refused with
					// `awaiting-decision` for a decision already taken, and because
					// `prune` skips an unresolved park the row could no longer be
					// collected by anything.
					//
					// The decision IS carried out here — continuing is exactly what
					// the loop below does, and a plan verdict is the answer to the
					// question the plan park asked — so the park is resolved at the
					// same point and with the same meaning "resolved" carries
					// everywhere else: the record stays, and only its pending state
					// ends. A `pause` is deliberately not resolved: it holds the
					// park rather than answering it, which is how the live path
					// treats it too. `answersParkOf` is the whole map, park type to
					// answering decision, so an arm cannot go missing by being
					// absent from a condition again — which is how the plan arm
					// leaked a finished run's park.
					//
					// Resolving it does not depend on the resumed process being able
					// to act on it, and that is deliberate: the plan's own fate is a
					// separate defect (nothing restores a plan on the resume path at
					// all, so the new process has none to approve, execute or
					// reject) and making the resolution wait for it would leave the
					// row outstanding for exactly the runs that need it cleared.
					const parked = projectedCheckpoint.pending
					answeredParkId =
						params.pendingDecision &&
						parked !== undefined &&
						parked.resolvedAt === undefined &&
						answersParkOf(parked.request.type, params.pendingDecision)
							? projectedCheckpoint.id
							: undefined

					// Recover completed observations and explicitly unknown outcomes.
					// A recorded start is not proof that its external effect failed.
					const unanswered = interruptedToolCalls(projectedCheckpoint.messages)
					recoveredResults =
						unanswered.length > 0
							? await recoverCompletedCalls(ctx.recorder, unanswered, ctx.log, {
									answers: pendingResume?.answers,
									signal: ctx.abortController.signal,
								})
							: new Map()

					// Preserve both known and unknown outcomes before continuing calls
					// whose absence of a start was established by a complete scan.
					if (!pendingResume && recoveredResults.size > 0) {
						pendingResume = planCrashResume(projectedCheckpoint, recoveredResults, ctx.log)
					}

					// An incomplete turn with a durable owner is NOT abandoned. A
					// pending decision or crash-resume plan re-appends that exact
					// assistant with real/denied/recovered results below. Remove it
					// from the generic pass so no synthetic result competes with the
					// authority that still owns the call. Everything else is abandoned
					// history and is repaired conservatively rather than deleted.
					pendingResumeAssistantId = pendingResume
						? checkpoint.messageIds.get(pendingResume.assistant)
						: undefined
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
							[NAMZU.TURN_ID]: ctx.recorder.turnId,
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

					// The ledger is process state and a resumed run starts with an empty
					// one, so until something reads a file again this run knows nothing
					// about files the conversation already wrote in full — and re-reads
					// them. Rebuilt from the REPAIRED history, which is what the model
					// is about to be shown, rather than from the checkpoint's own
					// messages — plus whatever of the owned resume turn actually ran,
					// which the repaired list does not carry; see
					// `withOwnedResumeOutcomes`. Reads no file's content: every
					// fingerprint recovered here is still checked against the real one
					// at mutation time.
					try {
						await toolExecutor.seedFileObservations(
							pendingResume
								? withOwnedResumeOutcomes(
										restoredMessages,
										pendingResume.assistant,
										recoveredResults,
									)
								: restoredMessages,
							params.sandboxProvider !== undefined,
						)
					} catch (err: unknown) {
						// A ledger that could not be rebuilt is the empty one every resume
						// used to get, so the run continues without its witnesses and the
						// model reads what it needs. Failing the resume over it would trade
						// a conversation that works for one that does not, to protect an
						// optimisation. Said out loud all the same, because a seeding that
						// failed and one that found nothing are otherwise the same silence.
						ctx.log.debug('Could not rebuild the file observation ledger on resume', {
							[NAMZU.TURN_ID]: ctx.recorder.turnId,
							'namzu.checkpoint.id': checkpoint.id,
							'exception.message': err instanceof Error ? err.message : String(err),
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
								pushRestored(msg, checkpoint.messageIds)
							}
							continue
						}
						pushRestored(msg, checkpoint.messageIds)
					}

					// The queue, on the resume path too. It is drained
					// unconditionally above, so leaving this out would take a
					// host's "start with this" off the record and deliver it
					// nowhere — the one outcome a durable queue must not have.
					//
					// AFTER the restored history rather than before it: on a
					// resume the conversation already exists, and a message left
					// for "the next run" is the newest thing said, not the oldest.
					for (const queued of queuedForThisRun) ctx.recorder.pushMessage(queued)
				} else if (params.continuationMode) {
					for (const msg of initialMessages) pushRestored(msg, historyIds)
				} else {
					pushSystemMessages()
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
								// Pinned by the prelude already; a copy would lose its record id.
								pushRestored(msg.retain ? msg : { ...msg, retain: true }, historyIds)
							} else if (isWorkingMemoryMessage(msg.content)) {
								pushRestored(msg, historyIds)
							}
							continue
						}
						pushRestored(msg, historyIds)
					}
				}
				// Fresh and continuation histories seed the same operator state.
				// A worker report or project-policy message may have role `user`,
				// but it must not become the task or an operator requirement.
				// Resume restores this state and adopts only its newer queue arrivals.
				if (!params.resumeFromCheckpoint && workingStateManager) {
					let isFirstUserMessage = true
					for (const message of initialMessages) {
						if (!isOperatorUserMessage(message) || !message.content.trim()) continue
						extractFromUserMessage(workingStateManager, message.content, isFirstUserMessage)
						isFirstUserMessage = false
					}
				}

				const assembledPrompt =
					segments.dynamic.length > 0
						? `${segments.static}\n\n---\n\n${segments.dynamic}`
						: segments.static

				ctx.recorder.markRunning()
				// A resumed turn already began; `turn_resuming` above continued it.
				if (!params.resumeFromCheckpoint) {
					await eventTranslator.beginTurn({
						systemPrompt: assembledPrompt,
						...(params.origin ? { origin: params.origin } : {}),
						...(params.abandonInterrupted ? { abandonInterrupted: true } : {}),
					})
				}
				yield* eventTranslator.drainPending()

				// Pre-run materialization can observe cancellation before TurnContext
				// exists. The exact input has now been seeded and the run is writable;
				// hand the cancellation to the normal terminal path before invoking
				// any host callback, guardrail, plugin, sandbox, or provider. Those
				// boundaries are not all cooperative and must not regain withdrawn
				// authority merely because the run record still had to be created.
				ctx.abortController.signal.throwIfAborted()

				// Handed over here, and the position is load-bearing in three
				// directions. It has to follow `wirePlanManager`, or a host that
				// builds its plan in this callback does it into silence. It has to
				// follow `recorder.init()` and `turn_started`, because plan events append
				// to that durable run. It also has to follow the pre-model abort fence:
				// a callback invoked after attachment resolution observed cancellation
				// would regain withdrawn authority and could replace the cancellation
				// with its own failure. This is still before the iteration loop, which
				// is the guarantee the callback makes.
				params.onContextCreated?.({ planManager: ctx.planManager })

				// The box is handed out HERE, after `turn_started`, and the position
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
				// request, but its durable event cannot precede turn_started: there is no
				// writable run log until that event initializes it. Emit the measured
				// counts here, still before any provider call, so hosts can tell that the
				// model received a repaired projection rather than the raw history.
				for (const repair of pendingHistoryRepairs) {
					await eventTranslator.emitEvent({
						type: 'message_history_repaired',
						turnId: ctx.recorder.turnId,
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
						turnId: ctx.recorder.turnId,
						capability: 'tools',
						providerId: params.provider.id,
						message: `Provider '${params.provider.id}' does not support tools — ${registeredToolCount} registered tool(s) were stripped from the prompt and request.`,
					})
					yield* eventTranslator.drainPending()
				}
				if (attachmentMessageCount > 0) {
					await eventTranslator.emitEvent({
						type: 'capability_warning',
						turnId: ctx.recorder.turnId,
						capability: 'vision',
						providerId: params.provider.id,
						message: `Provider '${params.provider.id}' does not support vision — image attachments on ${attachmentMessageCount} user message(s) will not reach the model.`,
					})
					yield* eventTranslator.drainPending()
				}
				if (documentMessageCount > 0) {
					await eventTranslator.emitEvent({
						type: 'capability_warning',
						turnId: ctx.recorder.turnId,
						capability: 'documents',
						providerId: params.provider.id,
						message: `Provider '${params.provider.id}' does not support documents — document attachments on ${documentMessageCount} user message(s) will not reach the model.`,
					})
					yield* eventTranslator.drainPending()
				}

				if (params.pluginManager) {
					const hookResults = await params.pluginManager.executeHooks(
						'turn_start',
						{ sessionId: ctx.sessionId, turnId: ctx.turnId, signal: ctx.abortController.signal },
						eventTranslator.emitEvent,
					)
					applyLifecycleHookResults('turn_start', hookResults)
					yield* eventTranslator.drainPending()
				}

				// --- Sandbox lifecycle: create before iteration loop ---
				if (params.sandboxProvider) {
					const rootAtCwd = turnConfig.sandbox?.workspace === 'working-directory'
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
					if (rootAtCwd && !params.sandboxProvider.workspaceModes?.includes('working-directory')) {
						throw new NamzuError({
							code: 'invalid_config',
							message: `Sandbox provider '${params.sandboxProvider.id}' does not advertise working-directory workspace support. Refusing instead of passing a project path the provider may ignore.`,
							details: {
								providerId: params.sandboxProvider.id,
								workspace: 'working-directory',
							},
						})
					}
					const acquisition = await acquireSandbox({
						provider: params.sandboxProvider,
						config: {
							...(rootAtCwd ? { workingDirectory: ctx.cwd } : {}),
							...(rootAtCwd && params.additionalDirectories?.length
								? { additionalDirectories: params.additionalDirectories }
								: {}),
							timeoutMs: turnConfig.sandbox?.timeoutMs,
							memoryLimitMb: turnConfig.sandbox?.memoryLimitMb,
							maxProcesses: turnConfig.sandbox?.maxProcesses,
						},
						signal: ctx.abortController.signal,
						timeoutMs: guard.remainingUntilTimeoutMs(),
						teardownTimeoutMs: sandboxTeardownTimeoutMs,
						onLateTeardown: (result) => {
							if (result.kind === 'destroyed') {
								ctx.log.info('Late sandbox allocation was destroyed after the run stopped', {
									[NAMZU.TURN_ID]: ctx.turnId,
								})
								return
							}
							ctx.log.error('Late sandbox allocation did not stop cleanly', {
								[NAMZU.TURN_ID]: ctx.turnId,
								...errorAttributes(result.error),
							})
						},
					})
					if (acquisition.kind !== 'created') {
						if (acquisition.createPending) {
							ctx.log.warn(
								'Sandbox creation was unsettled when the run stopped; any returned handle will be released, but a remote allocation hidden behind a lost response requires provider-side reconciliation or a fleet reaper',
								{
									[NAMZU.TURN_ID]: ctx.turnId,
									'namzu.sandbox.provider_id': params.sandboxProvider.id,
								},
							)
						}
						if (acquisition.kind === 'cancelled') {
							ctx.recorder.markCancelled()
						} else {
							ctx.recorder.setStopReason('timeout')
							ctx.log.warn('Sandbox creation exhausted the run timeout', {
								[NAMZU.TURN_ID]: ctx.turnId,
								'namzu.sandbox.provider_id': params.sandboxProvider.id,
								...errorAttributes(acquisition.error),
							})
						}
						yield* resultAssembler.completeTurn(rootSpan)
						// The run HAS settled, so the outer `finally` must not read
						// this as an abandonment — it would persist a second time.
						settled = true
						return await resultAssembler.finalize()
					}
					sandbox = acquisition.sandbox
					toolExecutor.setSandbox(sandbox)

					await eventTranslator.emitEvent({
						type: 'sandbox_created',
						turnId: ctx.turnId,
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

				// Before the first model call: the cheapest place to refuse, since
				// nothing has been spent. Previously unreachable — `turn_start`
				// fires with only `{ sessionId, turnId }` and `turn_started` carries only the
				// system prompt, so no hook could see the user's message.
				const inputVerdict = await runInputGuardrails(
					params.inputGuardrails,
					{
						sessionId: ctx.sessionId,
						turnId: ctx.turnId,
						messages: ctx.recorder.messages,
						...(segments?.static ? { systemPrompt: segments.static } : {}),
					},
					ctx.log,
				)
				if (inputVerdict.blocked) {
					await eventTranslator.emitEvent({
						type: 'guardrail_triggered',
						turnId: ctx.turnId,
						stage: 'input',
						action: 'block',
						...(inputVerdict.name ? { guardrail: inputVerdict.name } : {}),
						...(inputVerdict.reason ? { reason: inputVerdict.reason } : {}),
					})
					yield* eventTranslator.drainPending()
					// A guardrail block is a refusal — first-class in the audit trail
					// (LOG-14, design §5), not merely a SessionEvent a host happens to be
					// subscribed to when it fires.
					await ctx.recorder.recordAudit({
						what: { action: 'guardrail:input', resource: inputVerdict.name },
						outcome: 'refused',
						reason: inputVerdict.reason ?? 'blocked by an input guardrail',
						...(params.persona?.identity.role ? { persona: params.persona.identity.role } : {}),
					})
					ctx.recorder.setStopReason('input_guardrail')
					ctx.recorder.setLastError(inputVerdict.reason ?? 'blocked by an input guardrail')
					yield* resultAssembler.completeTurn(rootSpan)
					// Same two lines as the sandbox path above, and for the same
					// reasons — with one that path does not have. This return used to
					// hand back `getRun()` without persisting, so the terminal state
					// reached the disk only because the abandonment path found
					// `settled` false and settled it a second time. A branch that
					// exists for runs which did NOT settle must not be the reason a
					// settled one is written down.
					settled = true
					return await resultAssembler.finalize()
				}

				// Honor the approval a human already gave, before the loop's
				// first model call. The sandbox exists by now, so an approved
				// tool that needs one gets it.
				if (pendingResume) {
					ctx.log.info('Applying a pending HITL decision to the checkpointed tool calls', {
						[NAMZU.TURN_ID]: ctx.turnId,
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

					await applyPendingResume(
						pendingResume,
						ctx.recorder,
						toolExecutor,
						recoveredResults,
						pendingResumeAssistantId,
					)
					yield* eventTranslator.drainPending()
				}

				// The decision has now actually been carried out, so the park it
				// answered is no longer outstanding. Without this the checkpoint
				// keeps reporting `pending` with no `resolvedAt`, and an approval
				// queue re-serves a call that already ran — or a question already
				// answered — which defeats the entire point of recording the park.
				//
				// Two arms reach this point, and being outside `if (pendingResume)`
				// is what the second one needs. One is a plan whose decision was
				// applied to a batch above. The other is the cadence arm, for which
				// `planPendingResume` rightly produces no plan because the loop
				// resuming IS its decision being carried out (`answeredParkId`, set
				// on the restore path). Resolving only the first left a finished run
				// reporting `awaiting-decision` forever.
				//
				// What is RECORDED depends on which of the two produced the plan. A
				// recovery plan means the batch was answered by the crash path
				// rather than by the decision — the calls the human was asked about
				// were closed with explicitly unknown outcomes — so the human's
				// answer must not be written down as what ended the park. The park is
				// still resolved: the question is moot, and leaving it outstanding
				// would have `findPendingCheckpoint` serve it as the newest
				// outstanding park, so a host resuming it would rewind this run to
				// the checkpoint the crash happened on and re-execute a batch the run
				// has long since moved past.
				const resolvedCheckpointId = pendingResume?.checkpointId ?? answeredParkId
				const recordedDecision =
					pendingResume?.source === 'recovery' && params.pendingDecision
						? supersededByRecovery(params.pendingDecision)
						: params.pendingDecision
				if (recordedDecision && resolvedCheckpointId) {
					await checkpointMgr
						.unpark(resolvedCheckpointId, recordedDecision)
						.catch((err: unknown) => {
							ctx.log.error('Applied a pending decision but failed to clear the park', {
								[NAMZU.TURN_ID]: ctx.turnId,
								'namzu.checkpoint.id': resolvedCheckpointId,
								'exception.message': err instanceof Error ? err.message : String(err),
							})
							return null
						})
				}

				yield* iterationOrchestrator.runLoop()

				yield* finalizeTurn({
					ctx,
					params,
					eventTranslator,
					takeSteps: () => iterationOrchestrator.getSteps(),
					workingStateManager,
					resultAssembler,
					rootSpan,
				})
			} catch (err) {
				// Another turn is active in this session: nothing of this turn was
				// written, so there is nothing to settle. The caller gets the
				// refusal itself.
				if (isTurnInProgressError(err) && !ctx.recorder.isActive) throw err
				// A failed turn still spent its steps; report them.
				ctx.recorder.setSteps(iterationOrchestrator.getSteps())
				await executeUserInterruptHooks(err)
				yield* eventTranslator.drainPending()
				yield* resultAssembler.handleError(err, rootSpan)
			} finally {
				yield* releaseTurnResources({
					ctx,
					eventTranslator,
					unsubscribeJobExits,
					unsubscribeTaskStore,
					awaitedJobs,
					backgroundJobs: params.backgroundJobs,
					backgroundJobOwner: params.backgroundJobOwner,
					questionParks,
					workingStateManager,
					promoteMemory: params.promoteMemory,
					sandbox,
					sandboxTeardownTimeoutMs,
					runStartedAt,
					rootSpan,
				})
			}

			// Reached only by a run that settled on its own terms. `finalize()` is
			// the only thing in this body that writes the durable half of the run,
			// and a `return` completion arriving from a consumer (`break` out of
			// `for await`, `gen.return()`) runs the `finally` above and stops short
			// of here. The flag is what tells the two apart, and this is one of
			// three sites that set it — the sandbox-acquisition and input-guardrail
			// returns settle early and set it there. Set before the await rather
			// than after, because a store that throws on the way out must not send
			// the abandonment path over the same broken ground.
			settled = true
			return await resultAssembler.finalize()
		})()

		try {
			return yield* runBody
		} finally {
			if (!settled) await settleAbandonedTurn(ctx.recorder, eventTranslator, ctx.log)
		}
	} finally {
		unsubscribeChildSessions?.()
		// The lease `open()` took in the prelude; a caller-supplied lease is the
		// caller's to give back.
		await ctx.recorder.release()
	}
}

/**
 * Write a durable record for a turn whose consumer walked away.
 *
 * `for await (… ) break` and an explicit `gen.return()` both end the turn
 * body early. Everything the body's `finally` owns still happens — jobs are
 * killed, the sandbox is destroyed, the span ends — and then the generator
 * stops without settling. Without this the log would end mid-turn, and the
 * turn would read as `interrupted` for a process that is gone.
 *
 * - A turn that already settled, or already paused, is left as it stands.
 * - A turn parked on a decision (an open `decision_requested`) is PAUSED on
 *   that checkpoint: a park is a promise to a human that outlives the
 *   consumer, and `resumeSession` continues it once the answer arrives.
 * - Any other turn is settled `cancelled` (`turn_completed`): it did not
 *   complete and nothing failed; its consumer stopped reading.
 *
 * Never throws. It runs while an exception may already be unwinding, and a
 * log that cannot be written must not replace the turn's real failure.
 */
async function settleAbandonedTurn(
	recorder: TurnRecorder,
	eventTranslator: EventTranslator,
	log: Logger,
): Promise<void> {
	try {
		if (recorder.isClosed || recorder.isPaused || !recorder.isActive) return
		await recorder.flush()
		const parked = await findPendingCheckpoint(recorder.log, { turnId: recorder.turnId })
		if (parked) {
			recorder.setStopReason('paused')
			await eventTranslator.emitEvent({
				type: 'turn_paused',
				checkpointId: parked.checkpointId,
				reason: 'The consumer stopped reading while the turn was awaiting a decision.',
			})
			await recorder.persist()
			log.info('Abandoned turn left paused for a human to answer', {
				[NAMZU.TURN_ID]: recorder.turnId,
				'namzu.checkpoint.id': parked.checkpointId,
				'namzu.runtime.park_type': parked.pending.request.type,
			})
			return
		}
		if (!isTerminalStatus(recorder.status)) recorder.markCancelled()
		await eventTranslator.emitEvent({
			type: 'turn_completed',
			result: recorder.getTurn().result ?? '',
			...(recorder.stopReason ? { stopReason: recorder.stopReason } : {}),
			settlement: recorder.settlement(recorder.status === 'cancelled' ? 'cancelled' : 'completed'),
		})
		await recorder.persist()
		log.info('Abandoned turn recorded as cancelled', {
			[NAMZU.TURN_ID]: recorder.turnId,
		})
	} catch (err) {
		log.error('Failed to record the end of an abandoned turn', {
			[NAMZU.TURN_ID]: recorder.turnId,
			'exception.message': err instanceof Error ? err.message : String(err),
		})
	}
}

/** The text of the newest user turn, which is what a prompt hook is asked about. */
function lastUserPrompt(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m?.role === 'user' && typeof m.content === 'string') return m.content
	}
	return ''
}

type DrainQueryParams = Omit<QueryParams, 'resumeHandler'> & {
	resumeHandler?: ResumeHandler
}

async function drainPreparedQuery(
	fullParams: QueryParams,
	listener?: SessionEventListener,
): Promise<Turn> {
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

export async function drainQuery(
	params: Omit<QueryParams, 'resumeHandler'> & {
		resumeHandler?: ResumeHandler
	},
	listener?: SessionEventListener,
): Promise<Turn> {
	const fullParams: QueryParams = {
		...params,
		resumeHandler: params.resumeHandler ?? autoApproveHandler,
	}
	return await drainPreparedQuery(fullParams, listener)
}

/** @internal Canonical resume state already selected by `resumeSession`. */
export async function drainQueryWithSelectedResumeState(
	params: DrainQueryParams,
	state: SelectedResumeState,
	listener?: SessionEventListener,
): Promise<Turn> {
	const fullParams: QueryParams = {
		...params,
		resumeHandler: params.resumeHandler ?? autoApproveHandler,
	}
	if (fullParams.resumeFromCheckpoint !== state.checkpointId) {
		throw new Error('The selected resume state does not match the requested checkpoint.')
	}
	assertSelectedResumeAttribution(fullParams, state)
	selectedResumeStates.set(fullParams, state)
	return await drainPreparedQuery(fullParams, listener)
}

function assertSelectedResumeAttribution(params: QueryParams, state: SelectedResumeState): void {
	const mismatchedFields: string[] = []
	if (params.turnId !== state.turnId) mismatchedFields.push('turnId')
	if (params.sessionId !== state.sessionId) mismatchedFields.push('sessionId')
	if (params.topicId !== state.topicId) mismatchedFields.push('topicId')
	if (params.projectId !== state.projectId) mismatchedFields.push('projectId')
	if (params.tenantId !== state.tenantId) mismatchedFields.push('tenantId')
	if (params.parentSessionId !== state.parentSessionId) mismatchedFields.push('parentSessionId')
	if (mismatchedFields.length === 0) return

	throw new NamzuError({
		code: 'invalid_config',
		message: 'The selected resume state does not match the turn attribution supplied to the query.',
		details: { fields: mismatchedFields },
	})
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
