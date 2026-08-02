import { join } from 'node:path'
import {
	AdvisorRegistry,
	AdvisoryContext,
	AdvisoryExecutor,
	TriggerEvaluator,
} from '../../advisory/index.js'
import { findDanglingMessages, removeDanglingMessages } from '../../compaction/dangling.js'
import { extractFromUserMessage } from '../../compaction/extractor.js'
import { WorkingStateManager } from '../../compaction/manager.js'
import { restoreWorkingState, snapshotWorkingState } from '../../compaction/wire.js'
import type { CompactionConfig } from '../../config/runtime.js'
import { TOOL_OUTPUT_DIR_NAME } from '../../constants/tools/index.js'
import { EmergencySaveManager } from '../../manager/run/emergency.js'
import { resolveProviderCapabilities } from '../../provider/capabilities.js'
import { type ProviderRetryConfig, withProviderRetry } from '../../provider/retry.js'
import type { PathBuilder } from '../../session/workspace/path-builder.js'
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
import { type Message, createSystemMessage } from '../../types/message/index.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { TaskRouterConfig } from '../../types/router/index.js'
import type { ReviewAnswer } from '../../types/run/answer-review.js'
import type { CheckpointStore } from '../../types/run/checkpoint-store.js'
import type {
	AgentRunConfig,
	PrepareStep,
	Run,
	RunEvent,
	RunEventListener,
	StepResult,
	StopCondition,
} from '../../types/run/index.js'
import type { Sandbox, SandboxProvider } from '../../types/sandbox/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { Skill } from '../../types/skills/index.js'
import type { StructuredOutputConfig } from '../../types/structured-output/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { RepairToolCall } from '../../types/tool/repair.js'
import type { VerificationGateConfig } from '../../types/verification/index.js'
import type { ModelPricing } from '../../utils/cost.js'
import { getRootLogger } from '../../utils/logger.js'
import { VerificationGate } from '../../verification/gate.js'
import { CheckpointManager } from './checkpoint.js'
import type { ContextCache } from './context-cache.js'
import { RunContextFactory } from './context.js'
import { EventTranslator } from './events.js'
import { GuardCoordinator } from './guard.js'
import { runInputGuardrails, runOutputGuardrails } from './guardrails.js'
import { IterationOrchestrator } from './iteration/index.js'
import { isCompactionMessage } from './iteration/phases/compaction.js'
import { isWorkingMemoryMessage } from './iteration/phases/working-memory.js'
import { applyLifecycleHookResults } from './plugin-hooks.js'
import { PromptBuilder } from './prompt.js'
import type { PromptSegments } from './prompt.js'
import type { PendingAnswers, QuestionParkBinding } from './question-park.js'
import { ResultAssembler } from './result.js'
import {
	type PendingResumePlan,
	applyPendingResume,
	planCrashResume,
	planPendingResume,
	recoverCompletedCalls,
	unansweredToolCalls,
} from './resume-pending.js'
import { ToolGrantSet } from './tool-grants.js'
import { ToolingBootstrap } from './tooling.js'

export interface QueryParams {
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
	 * Durability for questions raised from inside a tool.
	 *
	 * The tool that asks is built before the run exists, so the binding is
	 * created by whoever builds the tools and attached here — that is what
	 * lets one tool instance be durable inside a run and inert outside one.
	 * Without it, a question park exists only as a suspended `await`: kill
	 * the process while somebody is looking at the card and the answer can
	 * never be applied.
	 */
	questionParks?: QuestionParkBinding

	/**
	 * The registry a re-entered `ask_user_question` reads its answer from.
	 *
	 * Same shape as {@link questionParks}: the tool is built before the run
	 * exists, so the instance is created by whoever builds the tools and
	 * filled here on the resume path. Without it a resumed run re-asks a
	 * question the user already answered.
	 */
	pendingAnswers?: PendingAnswers

	/** Default per-tool execution deadline. See {@link ToolDefinition.timeoutMs}. */
	toolTimeoutMs?: number

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
	prepareStep?: PrepareStep

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
	 * Topic the Session lives under. Required in 0.3.0 — every run carries
	 * the full five-layer scope (Tenant → Project → Thread → Session →
	 * Run). Denormalized from `session.threadId`; callers build this
	 * alongside `sessionId` so the query pipeline never needs a second
	 * SessionStore round-trip to recover it.
	 */
	threadId: ThreadId

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

	runId?: RunId

	parentRunId?: RunId

	depth?: number

	contextCache?: ContextCache

	contextLevel?: AgentContextLevel

	continuationMode?: boolean

	taskStore?: TaskStore

	runtimeToolOverrides?: RuntimeToolOverrides

	runtimeContext?: AgentRuntimeContext

	taskGateway?: import('../../types/agent/gateway.js').TaskGateway

	launchedTasks?: Map<
		import('../../types/ids/index.js').TaskId,
		import('./iteration/phases/context.js').LaunchedTaskMeta
	>

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

	agentBus?: import('../../bus/index.js').AgentBus

	verificationGate?: VerificationGateConfig

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

export async function* query(params: QueryParams): AsyncGenerator<RunEvent, Run> {
	// Boot-time filesystem migration (session-hierarchy.md §13.4.1). First
	// call per process per root actually runs; subsequent calls short-circuit
	// via the in-memory guard in `context.ts`. Kept here rather than inside
	// the synchronous `RunContextFactory.build` so the factory signature stays
	// sync for tests / non-async call sites.
	const cwdForMigration = params.workingDirectory ?? process.cwd()
	await RunContextFactory.ensureMigrated(`${cwdForMigration}/.namzu`)

	// Every model call in the run — the loop's turns, the forced-final
	// summary, advisory and compaction side calls — goes through this one
	// wrapped provider, so the retry policy cannot be bypassed by a code
	// path that happens to hold the raw driver.
	// The logger is passed on purpose: `withProviderRetry` guards every one
	// of its warns behind `options.log`, and this is its only production
	// call site — so without it the "failed, retrying" and "failed, giving
	// up" lines were dead code and a backoff left no trace anywhere.
	const resilientProvider =
		params.retry === false
			? params.provider
			: withProviderRetry(params.provider, { config: params.retry, log: getRootLogger() })

	const ctx = RunContextFactory.build({
		agentId: params.agentId,
		agentName: params.agentName,
		runConfig: params.runConfig,
		provider: resilientProvider,
		workingDirectory: params.workingDirectory,
		pricing: params.pricing,
		enableActivityTracking: params.enableActivityTracking,
		messages: params.messages,
		signal: params.signal,
		sessionId: params.sessionId,
		threadId: params.threadId,
		projectId: params.projectId,
		tenantId: params.tenantId,
		pathBuilder: params.pathBuilder,
		checkpointStore: params.checkpointStore,
		runId: params.runId,
		parentRunId: params.parentRunId,
		depth: params.depth,
	})

	ctx.planManager.setApprovalHandler(async (request) => {
		const decision = await params.resumeHandler({
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

	params.onContextCreated?.({ planManager: ctx.planManager })

	const eventTranslator = new EventTranslator(ctx.runMgr)
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
	const attachmentMessageCount = capabilities.supportsVision
		? 0
		: params.messages.filter(
				(m) => m.role === 'user' && m.attachments !== undefined && m.attachments.length > 0,
			).length

	if (stripToolSurfaces) {
		const message = `Provider '${params.provider.id}' declares supportsTools: false but ${registeredToolCount} tool(s) are registered — stripping all tool surfaces from the prompt and request so the model is never told about tools it cannot call. Pass strictCapabilities: true to fail instead, or use a tools-capable provider.`
		if (params.strictCapabilities) {
			throw new NamzuError({
				code: 'capability_unavailable',
				message,
				details: { providerId: params.provider.id, capability: 'tools', registeredToolCount },
			})
		}
		ctx.log.warn(`CAPABILITY MISMATCH: ${message}`, {
			providerId: params.provider.id,
			registeredToolCount,
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
		ctx.log.warn(`CAPABILITY MISMATCH: ${message}`, {
			providerId: params.provider.id,
			attachmentMessageCount,
		})
	}

	const effectiveAllowedTools = stripToolSurfaces
		? []
		: withDeferredDiscoveryTool(params.tools, params.allowedTools)

	//  is null only when the run has no disk layout (tests,
	// in-memory hosts); the budget then degrades to middle-elision.
	const runDirForTools = ctx.runMgr.getRunDir()
	const toolOutputDir = runDirForTools ? join(runDirForTools, TOOL_OUTPUT_DIR_NAME) : undefined

	const toolExecutor = ToolingBootstrap.init(
		{
			tools: params.tools,
			runId: ctx.runId,
			workingDirectory: ctx.cwd,
			permissionMode: ctx.permissionMode,
			env: params.runConfig.env ?? {},
			abortSignal: ctx.abortController.signal,
			allowedTools: effectiveAllowedTools,
			invocationState: params.invocationState,
			pluginManager: params.pluginManager,
			...(params.toolTimeoutMs !== undefined ? { toolTimeoutMs: params.toolTimeoutMs } : {}),
			...(params.maxToolConcurrency !== undefined
				? { maxToolConcurrency: params.maxToolConcurrency }
				: {}),
			...(params.maxToolOutputChars !== undefined
				? { maxToolOutputChars: params.maxToolOutputChars }
				: {}),
			// Overflow lands beside the run's other artifacts, so it is
			// cleaned up with the run and reachable by the model's own
			// `read`/`grep` without a new affordance.
			...(toolOutputDir ? { toolOutputDir } : {}),
			...(params.repairToolCall ? { repairToolCall: params.repairToolCall } : {}),
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
	})

	const guard = new GuardCoordinator({
		tokenBudget: params.runConfig.tokenBudget,
		timeoutMs: params.runConfig.timeoutMs,
		costLimitUsd: params.runConfig.costLimitUsd,
		maxIterations: params.runConfig.maxIterations,
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
	})

	let advisoryCtx: AdvisoryContext | undefined
	if (params.advisory && params.advisory.advisors.length > 0) {
		const advisorRegistry = new AdvisorRegistry(
			params.advisory.advisors,
			params.advisory.defaultAdvisorId,
		)
		const advisoryExecutor = new AdvisoryExecutor(ctx.log)
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

	const verificationGate = params.verificationGate?.enabled
		? new VerificationGate(params.verificationGate, ctx.log)
		: undefined

	const iterationOrchestrator = new IterationOrchestrator({
		provider: resilientProvider,
		runConfig: params.runConfig,
		...(params.stopWhen ? { stopWhen: params.stopWhen } : {}),
		...(params.prepareStep ? { prepareStep: params.prepareStep } : {}),
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
		resumeHandler: params.resumeHandler,
		checkpointMgr,
		planManager: ctx.planManager,
		taskGateway: params.taskGateway,
		taskStore: params.taskStore,
		launchedTasks: params.launchedTasks ?? new Map(),
		// Run-scoped. An approval is a statement about this run's work;
		// carrying one into a later run would be reuse nobody agreed to.
		toolGrants: new ToolGrantSet(),
		compactionConfig: params.compactionConfig,
		workingStateManager,
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
		checkpointMgr.setParkTtl(params.runConfig.hitlParkTtlMs)

		// A question raised from inside a tool becomes a real checkpoint
		// here. It used to park under a synthetic id nothing ever wrote, so
		// the checkpoint did not exist: nothing on disk said a human owed
		// this run an answer, and a remote host could not observe the
		// question at all.
		params.questionParks?.bind({
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
						runId: ctx.runMgr.id,
						questionId: question.questionId,
						error: err instanceof Error ? err.message : String(err),
					})
					return null
				}
			},
			resolve: async (checkpointId, decision) => {
				await checkpointMgr.unpark(checkpointId, decision).catch((err: unknown) => {
					ctx.log.error('Failed to clear a recorded question park', {
						runId: ctx.runMgr.id,
						checkpointId,
						error: err instanceof Error ? err.message : String(err),
					})
					return null
				})
				await eventTranslator.emitEvent({
					type: 'user_question_answered',
					runId: ctx.runMgr.id,
					checkpointId,
					answered: decision.action === 'answer_question',
				})
			},
		})
		rootSpan.setAttributes({
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			[GENAI.AGENT_NAME]: params.agentName,
			[GENAI.AGENT_ID]: params.agentId,
			[GENAI.REQUEST_MODEL]: params.runConfig.model,
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

			ctx.log.info('Starting query', {
				runId: ctx.runMgr.id,
				agent: params.agentName,
				model: params.runConfig.model,
				tokenBudget: params.runConfig.tokenBudget,
				activityTracking: ctx.activityStore.enabled,
				permissionMode: ctx.permissionMode,
				resumeFromCheckpoint: params.resumeFromCheckpoint ?? null,
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
			}

			const segments: PromptSegments = params.contextCache
				? params.contextCache.getSystemPromptSegmented(
						cacheInput,
						contextLevel,
						params.workingDirectory,
					)
				: promptBuilder.buildSegmented(contextLevel, params.workingDirectory)

			ctx.log.info('Prompt segments assembled', {
				staticLength: segments.static.length,
				dynamicLength: segments.dynamic.length,
			})

			const pushSystemMessages = (): void => {
				ctx.runMgr.pushMessage(createSystemMessage(segments.static, 'cache'))
				if (segments.dynamic.length > 0) {
					ctx.runMgr.pushMessage(createSystemMessage(segments.dynamic, 'ephemeral'))
				}
			}

			if (params.resumeFromCheckpoint) {
				const checkpoint = await checkpointMgr.restore(params.resumeFromCheckpoint)
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
						runId: ctx.runMgr.id,
						checkpointId: checkpoint.id,
						slots: workingStateManager.slotCount(),
					})
				}
				ctx.log.info('Restored budgets from checkpoint', {
					runId: ctx.runMgr.id,
					checkpointId: checkpoint.id,
					totalTokens: checkpoint.tokenUsage.totalTokens,
					totalCost: checkpoint.costInfo.totalCost,
					iteration: checkpoint.guardState.iterationCount,
					elapsedMs: checkpoint.guardState.elapsedMs,
				})

				pushSystemMessages()

				// A human answered the park in a different process; apply that
				// answer to the tool calls they were actually shown. Without
				// this the repair below throws the approval away and the model
				// re-decides, so "yes, delete that row" degrades into "ask
				// again and hope it asks for the same thing".
				pendingResume =
					params.pendingDecision && checkpoint.pending
						? planPendingResume(checkpoint, params.pendingDecision, ctx.log)
						: null

				// Results of tools that finished before the process died. The
				// executor already emits one `tool_completed` per tool inline
				// and the transcript already persists it, so the record was
				// durable all along — it was simply never read back, and the
				// resumed run re-ran calls that had already charged a card or
				// sent an email.
				const unanswered = unansweredToolCalls(checkpoint.messages)
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
					pendingResume = planCrashResume(checkpoint, recoveredResults, ctx.log)
				}

				// A checkpoint taken at a tool-review park snapshots the
				// assistant turn AFTER its `tool_use` blocks but BEFORE any
				// `tool_result` exists, so replaying it verbatim would send a
				// malformed request on the first model call of the resumed
				// run. Repair the incomplete turn rather than inheriting it:
				// the model re-decides from the last valid state.
				//
				// The pending-decision path uses the SAME repair: it strips
				// the unanswered turn here and `applyPendingResume` re-appends
				// it together with the results that answer it, so the history
				// stays well-formed either way.
				const dangling = findDanglingMessages(checkpoint.messages)
				const restoredMessages = dangling.isValid
					? checkpoint.messages
					: removeDanglingMessages(checkpoint.messages)
				if (!dangling.isValid && !pendingResume) {
					ctx.log.warn('Checkpoint contained unanswered tool calls — repaired on restore', {
						runId: ctx.runMgr.id,
						checkpointId: checkpoint.id,
						unansweredAssistantTurns: dangling.assistantsWithUnmatchedCalls.length,
						orphanedToolMessages: dangling.orphanedToolMessages.length,
						removed: checkpoint.messages.length - restoredMessages.length,
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
			} else if (params.continuationMode) {
				for (const msg of params.messages) {
					ctx.runMgr.pushMessage(msg)
				}
			} else {
				pushSystemMessages()
				let isFirstUserMessage = true
				for (const msg of params.messages) {
					if (msg.role === 'system') continue
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
				sandbox = await params.sandboxProvider.create({
					timeoutMs: params.runConfig.sandbox?.timeoutMs,
					memoryLimitMb: params.runConfig.sandbox?.memoryLimitMb,
					maxProcesses: params.runConfig.sandbox?.maxProcesses,
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
					sandboxId: sandbox.id,
					environment: sandbox.environment,
					rootDir: sandbox.rootDir,
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
						{ runId: ctx.runId },
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
					runId: ctx.runId,
					tools: pendingResume.response.message.toolCalls?.map((tc) => tc.function.name),
					denied: pendingResume.denials.size,
				})
				// Hand the recorded answer to the already-built tool. The tool
				// closed over its registry when the agent was constructed,
				// long before this run existed, so the answers are copied in
				// rather than passed down.
				if (pendingResume.answers && params.pendingAnswers) {
					for (const [questionId, answer] of pendingResume.answers.entries()) {
						params.pendingAnswers.set(questionId, answer)
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
								runId: ctx.runId,
								checkpointId: resolvedCheckpointId,
								error: err instanceof Error ? err.message : String(err),
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

			// Same reasoning for the question channel: the tools outlive the
			// run that bound them, so leaving it attached would have a later
			// run's question written into this run's checkpoint store.
			params.questionParks?.unbind()

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
					ctx.log.info('Sandbox destroyed', { sandboxId })
				} catch (destroyErr) {
					ctx.log.error('Sandbox destroy failed', {
						sandboxId,
						error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
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
