import { join } from 'node:path'
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
import { TOOL_OUTPUT_DIR_NAME } from '../../constants/tools/index.js'
import { EmergencySaveManager } from '../../manager/run/emergency.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import { PromptContributionRegistry } from '../../prompt/contributions.js'
import { resolveProviderCapabilities } from '../../provider/capabilities.js'
import type { ProviderChainMember } from '../../provider/fallback.js'
import { withStreamIdleTimeout } from '../../provider/idle-timeout.js'
import type { ProviderRetryConfig } from '../../provider/retry.js'
import { withTokenBudget } from '../../provider/token-budget.js'
import type { TokenBudget } from '../../run/token-budget.js'
import type { PathBuilder } from '../../session/workspace/path-builder.js'
import {
	GENAI,
	NAMZU,
	agentRunSpanName,
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
import type { CheckpointId, RunId, SessionId, TenantId } from '../../types/ids/index.js'
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
import type { ReviewAnswer } from '../../types/run/answer-review.js'
import type { CheckpointStore, FencingToken } from '../../types/run/checkpoint-store.js'
import type { RunEventCursor, RunEventReplay } from '../../types/run/event-cursor.js'
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
import type { RunStore } from '../../types/run/store.js'
import type { TokenBudgetStore } from '../../types/run/token-budget-store.js'
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
import { errorAttributes } from '../../utils/log/exception.js'
import type { Logger } from '../../utils/logger.js'
import { AwaitedJobs } from '../jobs/awaited-jobs.js'
import type { BackgroundJobRegistry } from '../jobs/registry.js'
import { catchUpFromCursor, settlePreStartCancellation } from './cancelled-before-start.js'
import { CheckpointManager, findPendingCheckpoint } from './checkpoint.js'
import { finalizeRun } from './finalize-run.js'
import { GuardCoordinator } from './guard.js'
import { runInputGuardrails } from './guardrails.js'
import { IterationOrchestrator } from './iteration/index.js'
import { isCompactionMessage } from './iteration/phases/compaction.js'
import { isWorkingMemoryMessage } from './iteration/phases/working-memory.js'
import { applyLifecycleHookResults } from './plugin-hooks.js'
import {
	type SelectedResumeState,
	prepareRun,
	projectStateBearingHistory,
	resolveProviderContextWindow,
	selectedResumeStates,
} from './prepare-run.js'
import type { ProjectInstructionContext } from './project-instructions.js'
import type { PromptCache } from './prompt-cache.js'
import { PromptBuilder } from './prompt.js'
import type { PromptSegments } from './prompt.js'
import { PendingAnswers, QuestionParkBinding } from './question-park.js'
import { releaseRunResources } from './release-run.js'
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
	/** One account shared with the task scheduler and descendant runs. */
	budget?: TokenBudget
	/** Canonical tree ledger; defaults to disk beside the root run. */
	tokenBudgetStore?: TokenBudgetStore
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
	 * A crash dump this run continues, removed when the run completes.
	 *
	 * `prepareReplayState({ fromCheckpoint: 'emergency' })` returns it as
	 * `emergencySavePath`. The replay is a new run with its own id, so the
	 * cleanup a run does for its OWN dump (`<runDir>/../emergency/<runId>.json`)
	 * never reaches the dump it forked from; this names it. Removed only when
	 * the run settles `completed` — a replay that fails or pauses leaves the
	 * dump, which is still the only record of the moment the original run
	 * died.
	 */
	supersedesEmergencySave?: string

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
	runConfig: AgentRunConfig
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
	 * Optional path layout override. Defaults to a {@link DefaultPathBuilder}
	 * rooted at `{workingDirectory}/.namzu`. First-call filesystem migration
	 * runs against this builder's root too, so an injected layout never touches
	 * the fallback working-directory store as a side effect.
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

export async function* query(params: QueryParams): AsyncGenerator<RunEvent, Run> {
	const prepared = await prepareRun(params)
	const {
		runConfig,
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
		queuedForThisRun,
		selectedResumeState,
		attachmentResolutionCancelled,
		streamIdleTimeoutMs,
		sandboxTeardownTimeoutMs,
		promptCache,
		taskScheduler,
	} = prepared

	if (attachmentResolutionCancelled) {
		return yield* settlePreStartCancellation(params, prepared)
	}

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

	// One gate instance owns both model-issued calls and calls dispatched by
	// another tool. Constructing it only inside the iteration review left the
	// nested registry path outside the operator's policy entirely.
	const gateConfig = params.authorizationGate
	const verificationGate = gateConfig?.enabled
		? new AuthorizationGate(gateConfig, ctx.log)
		: undefined

	// The store is initialized when the async query starts, after tooling is
	// composed. Resolve lazily at execution time: capturing getRunDir() here
	// permanently disabled retention for fresh disk-backed invocations.
	const toolOutputDir = () => {
		const runDir = ctx.runMgr.getRunDir()
		return runDir ? join(runDir, TOOL_OUTPUT_DIR_NAME) : undefined
	}
	// The same invocation-owned capability serves tools and optional preparation.
	// Local cancellation cannot override the run's cancellation or settled state.
	const captureRunEvidence = async (maxReadBytes?: number, signal?: AbortSignal) => {
		const combined = signal
			? AbortSignal.any([ctx.abortController.signal, signal])
			: ctx.abortController.signal
		combined.throwIfAborted()
		const source = await eventTranslator.captureRunEvidence(maxReadBytes, combined)
		combined.throwIfAborted()
		return source
	}

	// Whose jobs this run speaks for: its own by default, the session's when
	// the host said so. Resolved before the tools are built, because the
	// wait-intent recorder below is bound into them.
	const jobOwner = params.backgroundJobOwner ?? ctx.runId
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
			runId: ctx.runId,
			workingDirectory: ctx.cwd,
			...(params.additionalDirectories?.length
				? { additionalDirectories: params.additionalDirectories }
				: {}),
			permissionMode: () => ctx.permissionMode.current,
			env: runConfig.env ?? {},
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
						readToolCallBudgetEvents: () => eventTranslator.readEvents({ integrity: 'strict' }),
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
			captureRunEvidence,
			...(params.repairToolCall ? { repairToolCall: params.repairToolCall } : {}),
			...(verificationGate ? { authorizationGate: verificationGate } : {}),
			recordAudit: (input) => ctx.runMgr.recordAudit(input),
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
				runId: ctx.runId,
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
		...(params.supersedesEmergencySave !== undefined
			? { supersedesEmergencySave: params.supersedesEmergencySave }
			: {}),
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
				messages: ctx.runMgr.messages,
				turn: iterationOrchestrator.getAdvisoryTurnContext(),
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

	const iterationOrchestrator = new IterationOrchestrator({
		captureRunEvidence,
		provider: resilientProvider,
		providerCapabilities: capabilities,
		strictCapabilities: params.strictCapabilities === true,
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
						runConfig.timeoutMs,
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
	// consumer walked away — see `settleAbandonedRun`.
	let settled = false

	const runBody = (async function* (): AsyncGenerator<RunEvent, Run> {
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
		/**
		 * The cadence park this resume answered, when the decision is one the
		 * ordinary continue path carries out. See the restore path below.
		 */
		let answeredParkId: CheckpointId | undefined
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
					(error) => {
						ctx.log.warn('Replay observer failed', {
							'exception.message': toErrorMessage(error),
						})
					},
				)
			}

			ctx.log.info('Starting query', {
				[NAMZU.RUN_ID]: ctx.runMgr.id,
				'namzu.runtime.agent': params.agentName,
				[GENAI.REQUEST_MODEL]: runConfig.model,
				'namzu.runtime.token_budget': runConfig.tokenBudget,
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
						runId: ctx.runId,
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
					messages: projectStateBearingHistory(checkpoint.messages, {
						pinCompaction: false,
					}),
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
				if (workingStateManager && checkpoint.workingState && compactionConfig) {
					const revived = restoreWorkingState(checkpoint.workingState, compactionConfig)
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
						? await recoverCompletedCalls(ctx.runMgr, unanswered, ctx.log, {
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
							? withOwnedResumeOutcomes(restoredMessages, pendingResume.assistant, recoveredResults)
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
						[NAMZU.RUN_ID]: ctx.runMgr.id,
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

			ctx.runMgr.markRunning()
			await eventTranslator.emitEvent({
				type: 'run_started',
				runId: ctx.runMgr.id,
				systemPrompt: assembledPrompt,
			})
			yield* eventTranslator.drainPending()

			// Pre-run materialization can observe cancellation before RunContext
			// exists. The exact input has now been seeded and the run is writable;
			// hand the cancellation to the normal terminal path before invoking
			// any host callback, guardrail, plugin, sandbox, or provider. Those
			// boundaries are not all cooperative and must not regain withdrawn
			// authority merely because the run record still had to be created.
			ctx.abortController.signal.throwIfAborted()

			// Handed over here, and the position is load-bearing in three
			// directions. It has to follow `wirePlanManager`, or a host that
			// builds its plan in this callback does it into silence. It has to
			// follow `runMgr.init()` and `run_started`, because plan events append
			// to that durable run. It also has to follow the pre-model abort fence:
			// a callback invoked after attachment resolution observed cancellation
			// would regain withdrawn authority and could replace the cancellation
			// with its own failure. This is still before the iteration loop, which
			// is the guarantee the callback makes.
			params.onContextCreated?.({ planManager: ctx.planManager })

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
					{ runId: ctx.runId, signal: ctx.abortController.signal },
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
						timeoutMs: runConfig.sandbox?.timeoutMs,
						memoryLimitMb: runConfig.sandbox?.memoryLimitMb,
						maxProcesses: runConfig.sandbox?.maxProcesses,
					},
					signal: ctx.abortController.signal,
					timeoutMs: guard.remainingUntilTimeoutMs(),
					teardownTimeoutMs: sandboxTeardownTimeoutMs,
					onLateTeardown: (result) => {
						if (result.kind === 'destroyed') {
							ctx.log.info('Late sandbox allocation was destroyed after the run stopped', {
								[NAMZU.RUN_ID]: ctx.runId,
							})
							return
						}
						ctx.log.error('Late sandbox allocation did not stop cleanly', {
							[NAMZU.RUN_ID]: ctx.runId,
							...errorAttributes(result.error),
						})
					},
				})
				if (acquisition.kind !== 'created') {
					if (acquisition.createPending) {
						ctx.log.warn(
							'Sandbox creation was unsettled when the run stopped; any returned handle will be released, but a remote allocation hidden behind a lost response requires provider-side reconciliation or a fleet reaper',
							{
								[NAMZU.RUN_ID]: ctx.runId,
								'namzu.sandbox.provider_id': params.sandboxProvider.id,
							},
						)
					}
					if (acquisition.kind === 'cancelled') {
						ctx.runMgr.markCancelled()
					} else {
						ctx.runMgr.setStopReason('timeout')
						ctx.log.warn('Sandbox creation exhausted the run timeout', {
							[NAMZU.RUN_ID]: ctx.runId,
							'namzu.sandbox.provider_id': params.sandboxProvider.id,
							...errorAttributes(acquisition.error),
						})
					}
					yield* resultAssembler.completeRun(rootSpan)
					// The run HAS settled, so the outer `finally` must not read
					// this as an abandonment — it would persist a second time.
					settled = true
					return await resultAssembler.finalize()
				}
				sandbox = acquisition.sandbox
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
				await checkpointMgr.unpark(resolvedCheckpointId, recordedDecision).catch((err: unknown) => {
					ctx.log.error('Applied a pending decision but failed to clear the park', {
						[NAMZU.RUN_ID]: ctx.runId,
						'namzu.checkpoint.id': resolvedCheckpointId,
						'exception.message': err instanceof Error ? err.message : String(err),
					})
					return null
				})
			}

			yield* iterationOrchestrator.runLoop()

			yield* finalizeRun({
				ctx,
				params,
				eventTranslator,
				takeSteps: () => iterationOrchestrator.getSteps(),
				workingStateManager,
				resultAssembler,
				rootSpan,
			})
		} catch (err) {
			// A failed run still spent its steps; report them.
			ctx.runMgr.setSteps(iterationOrchestrator.getSteps())
			await executeUserInterruptHooks(err)
			yield* eventTranslator.drainPending()
			yield* resultAssembler.handleError(err, rootSpan)
		} finally {
			yield* releaseRunResources({
				ctx,
				eventTranslator,
				emergencyManager,
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
		if (!settled) await settleAbandonedRun(ctx.runMgr, ctx.log)
	}
}

/**
 * Write a terminal durable record for a run whose consumer walked away.
 *
 * `for await (… ) break` and an explicit `gen.return()` both end the run
 * body early. Everything the run's `finally` owns still happens — background
 * jobs are killed, the sandbox is destroyed, the span ends, the duration is
 * recorded — and then the generator stops. `finalize()` never runs, so
 * `persist()` never runs, and the store keeps whatever `init()` wrote: a
 * non-terminal status for a run that no longer exists. `deriveRunStatus`
 * reads that record back as `queued`, work waiting to start, and a host
 * rebuilding its view from the store believes it.
 *
 * There is nothing to emit here and nothing to emit it to: the consumer
 * that would have received the events is the one that left. This is about
 * the durable record only.
 *
 * `cancelled` is the verdict, and it is chosen from the existing vocabulary
 * because it is the one that is true. The run did not complete — no result
 * was produced and no terminal event was ever delivered — and nothing
 * failed, so `failed` would name an error that never happened; a run whose
 * consumer stopped reading and whose processes were torn down under it is
 * the same fact `markCancelled` already records when a run abort tears one
 * down. It needs no new `RunExecutionStatus` and no new `StopReason`.
 *
 * A verdict the run already reached is left standing. A run that failed,
 * or was cancelled, before the consumer left still says so; what the
 * abandonment adds is that the record reaches the disk at all.
 *
 * Neither is a verdict written over a PARK. A park is a promise to a human
 * that outlives the consumer: the run is resumable and somebody is still owed
 * an answer, and `deriveRunStatus` reads a terminal status BEFORE it reads the
 * park — so recording `cancelled` turns `awaiting_hitl` into `cancelled` for a
 * run nobody answered for, while the unanswered question stays on the record
 * and the checkpoint it belongs to stays the place a resume starts from. The
 * durable state is asked rather than the in-memory one because the in-memory
 * one is the misleading half here: `handleHITLDecision` emits `run_paused` and
 * drains it BEFORE it calls `setStopReason('paused')`, so a consumer that
 * leaves on that event leaves a run whose status is `running` and whose stop
 * reason is unset at the exact instant its park is already durable.
 * `findPendingCheckpoint` is the same read an approval queue is built from,
 * expired parks included in its judgement: a park nobody answered in time is
 * not somebody still being asked.
 *
 * Never throws. It runs while an exception may already be unwinding, and a
 * store that cannot be written must not replace the run's real failure with
 * its own.
 */
async function settleAbandonedRun(runMgr: RunPersistence, log: Logger): Promise<void> {
	try {
		// A terminal verdict is written whatever the park says: `deriveRunStatus`
		// settles a run that finished, failed or was cancelled BEFORE it looks at
		// a park ("terminal beats parked"), so a settled run is not waiting for
		// anybody and the row it already wrote must reach the disk. This ordering
		// is also what keeps a stale park from suppressing the write.
		if (!isTerminalStatus(runMgr.status)) {
			const parked = await findPendingCheckpoint(runMgr.getCheckpointStore(), runMgr.getRunScope())
			if (parked) {
				// Left exactly as it stands: no verdict, no write. The park row is
				// this run's durable state, and `persist()` here would add a
				// second claim — `running`, for a process that is gone — beside it.
				log.info('Abandoned run left parked for a human to answer', {
					[NAMZU.RUN_ID]: runMgr.id,
					'namzu.checkpoint.id': parked.id,
					'namzu.runtime.park_type': parked.pending?.request.type,
				})
				return
			}
			runMgr.markCancelled()
		}
		// Once: the `finally` that calls this runs once, and every site in the
		// run body that settles through `finalize()` sets `settled` before it
		// returns, so the two can never both write.
		await runMgr.persist()
		log.info('Abandoned run recorded as cancelled', {
			[NAMZU.RUN_ID]: runMgr.id,
		})
	} catch (err) {
		log.error('Failed to record the terminal state of an abandoned run', {
			[NAMZU.RUN_ID]: runMgr.id,
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
	listener?: RunEventListener,
): Promise<Run> {
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
	listener?: RunEventListener,
): Promise<Run> {
	const fullParams: QueryParams = {
		...params,
		resumeHandler: params.resumeHandler ?? autoApproveHandler,
	}
	return await drainPreparedQuery(fullParams, listener)
}

/** @internal Canonical resume state already selected by `resumeRun`. */
export async function drainQueryWithSelectedResumeState(
	params: DrainQueryParams,
	state: SelectedResumeState,
	listener?: RunEventListener,
): Promise<Run> {
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
	if (params.runId !== state.runId) mismatchedFields.push('runId')
	if (params.sessionId !== state.sessionId) mismatchedFields.push('sessionId')
	if (params.topicId !== state.topicId) mismatchedFields.push('topicId')
	if (params.projectId !== state.projectId) mismatchedFields.push('projectId')
	if (params.tenantId !== state.tenantId) mismatchedFields.push('tenantId')
	if (params.parentRunId !== state.parentRunId) mismatchedFields.push('parentRunId')
	if (mismatchedFields.length === 0) return

	throw new NamzuError({
		code: 'invalid_config',
		message: 'The selected resume state does not match the run attribution supplied to the query.',
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
