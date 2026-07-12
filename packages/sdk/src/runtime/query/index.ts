import {
	AdvisorRegistry,
	AdvisoryContext,
	AdvisoryExecutor,
	TriggerEvaluator,
} from '../../advisory/index.js'
import { extractFromUserMessage } from '../../compaction/extractor.js'
import { WorkingStateManager } from '../../compaction/manager.js'
import type { CompactionConfig } from '../../config/runtime.js'
import type { PathBuilder } from '../../session/workspace/path-builder.js'
import { GENAI, NAMZU, agentRunSpanName } from '../../telemetry/attributes.js'
import { getTracer } from '../../telemetry/runtime-accessors.js'
import { buildAdvisoryTools } from '../../tools/advisory/index.js'
import { SearchToolsTool } from '../../tools/builtins/search-tools.js'
import { buildTaskTools } from '../../tools/task/index.js'
import type { AdvisoryConfig } from '../../types/advisory/index.js'
import type { RuntimeToolOverrides } from '../../types/agent/base.js'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import { isTerminalStatus } from '../../types/common/index.js'
import {
	type CheckpointId,
	type IterationCheckpoint,
	type ResumeHandler,
	autoApproveHandler,
	deferredReviewHandler,
} from '../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import { type Message, createSystemMessage } from '../../types/message/index.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { TaskRouterConfig } from '../../types/router/index.js'
import type {
	AgentRunConfig,
	ReplayAttribution,
	Run,
	RunDisposition,
	RunEvent,
	RunEventListener,
	RunLeaseOptions,
} from '../../types/run/index.js'
import { ForkTargetsSourceRunError } from '../../types/run/replay.js'
import type { Sandbox, SandboxProvider } from '../../types/sandbox/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import type { Skill } from '../../types/skills/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { VerificationGateConfig } from '../../types/verification/index.js'
import type { ModelPricing } from '../../utils/cost.js'
import { generateDecisionRequestId } from '../../utils/id.js'
import { VerificationGate } from '../../verification/gate.js'
import { CheckpointManager } from './checkpoint.js'
import type { ContextCache } from './context-cache.js'
import { RunContextFactory } from './context.js'
import { dispatchPendingDecision } from './decision/dispatch.js'
import { RunNotResumableError } from './decision/errors.js'
import { EventTranslator } from './events.js'
import { GuardCoordinator } from './guard.js'
import { IterationOrchestrator } from './iteration/index.js'
import { RunLeaseHolder } from './lease.js'
import { applyLifecycleHookResults } from './plugin-hooks.js'
import { PromptBuilder, buildFrameAuthentication } from './prompt.js'
import type { PromptSegments } from './prompt.js'
import { prepareResumeMessages } from './replay/prepare.js'
import { ResultAssembler } from './result.js'
import { ToolingBootstrap } from './tooling.js'

export interface QueryParams {
	systemPrompt?: string
	persona?: AgentPersona
	skills?: Skill[]
	basePrompt?: string
	provider: LLMProvider
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

	/**
	 * Who answers a HITL request, in-process, while the run waits.
	 *
	 * **Present** — the fast path, and it is unchanged. An embedder with a synchronous
	 * reviewer awaits here and gets exactly the behaviour it always had.
	 *
	 * **Absent** — nobody is there to answer, so nothing is approved:
	 * {@link deferredReviewHandler} takes over and a tool review **parks the run
	 * durably**, persisting the question on its checkpoint for an out-of-process answer
	 * ({@link import('./decision/resume.js').resumeDecision}). This is the fail-closed
	 * direction on purpose. An auto-approving default would make "I forgot to pass a
	 * handler" and "I authorized this batch" the same program.
	 *
	 * A present handler can hand a decision out-of-process at any time by answering
	 * `{ action: 'pause' }` — which is what `pause` has always meant, and now survives.
	 */
	resumeHandler?: ResumeHandler
	resumeFromCheckpoint?: CheckpointId

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

	runId?: RunId

	parentRunId?: RunId

	depth?: number

	/**
	 * Provenance of a **fork** — a NEW run seeded from another run's checkpoint. Build it
	 * with {@link import('./replay/fork.js').prepareForkState}, which also mints the new
	 * run id; it is persisted onto this run's `run.json`.
	 *
	 * Naming the source run in `runId` is refused
	 * ({@link import('../../types/run/replay.js').ForkTargetsSourceRunError}): a fork that
	 * runs under its source's id overwrites the record it forked from.
	 */
	replayOf?: ReplayAttribution

	/**
	 * How this segment holds the run's lease — TTL, heartbeat, holder id (ses_017 G1).
	 *
	 * **The lease is not optional.** Every segment takes it, and a segment that cannot take
	 * it does not run: one run is driven by one segment at a time, or two of them write
	 * `run.json` and `messages.json` and the last writer wins. These options tune it; they
	 * do not switch it off.
	 */
	lease?: RunLeaseOptions

	contextCache?: ContextCache

	contextLevel?: AgentContextLevel

	continuationMode?: boolean

	taskStore?: TaskStore

	runtimeToolOverrides?: RuntimeToolOverrides

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

	agentBus?: import('../../bus/index.js').AgentBus

	verificationGate?: VerificationGateConfig

	pluginManager?: import('../../plugin/lifecycle.js').PluginLifecycleManager

	sandboxProvider?: SandboxProvider

	invocationState?: InvocationState
}

/**
 * May this segment drive this run, and under what lease?
 *
 * Everything here is a **read plus the lease**, and nothing here writes the run's record.
 * That is the contract: a segment that is refused admission must leave the run exactly as
 * it found it. (The one thing it does create is the run's directory and its `leases/`
 * folder — a `mkdir`, not a record.)
 *
 * The order is load-bearing, twice over:
 *
 *   1. **The lease first, the status check under it.** Reading the status and *then*
 *      taking the lease is a check-then-act race: the run's live segment could complete
 *      between the two, and a second segment would take the freed lease and re-drive a run
 *      that had just finished. Under the lease, the status this reads is the status that
 *      holds for as long as this segment holds it.
 *   2. **Hydration before `init()`.** `init()` writes `run.json` from RunPersistence's
 *      in-memory state, so hydrating after it would stamp a zeroed usage and iteration
 *      record over the real one on disk. A resumed run continues the SAME logical run and
 *      therefore the same ledger — `tokenBudget`, `costLimitUsd` and `maxIterations` are
 *      LIFETIME limits, and `timeoutMs` measures ACTIVE execution time, so an hour of
 *      human thinking costs the run nothing (`GuardCoordinator.restoreElapsed`).
 *
 * **What a resume refuses.** A TERMINAL run — `completed`, `failed` or `cancelled`. Only
 * `cancelled` was refused before, so `query({ resumeFromCheckpoint })` would happily
 * re-drive a finished run under its own id and overwrite its record with the second
 * drive's. Re-driving a finished run from a checkpoint is a legitimate thing to want; it
 * is called a **fork**, it gets a new id, and it has its own entry point
 * ({@link import('./replay/fork.js').prepareForkState}).
 *
 * **What it still allows, deliberately:** a NON-terminal run with no decision on it —
 * `idle`, `running`, or an `awaiting_input` whose decision is already `settled`. Those are
 * crashed segments, and resuming them from a checkpoint is the crash recovery this entry
 * point existed for before durable pause was built on top of it. Restricting resume to
 * "parked with a live decision" would brick every run that died mid-loop.
 */
async function admitSegment(
	params: QueryParams,
	ctx: import('./context.js').RunContext,
	checkpointMgr: CheckpointManager,
	guard: GuardCoordinator,
): Promise<{ lease: RunLeaseHolder; resumeCheckpoint?: IterationCheckpoint }> {
	// A fork under its source's id is an overwrite with a provenance stamp on it. The
	// fork entry point refuses it too; this is the door that cannot be walked around.
	if (params.replayOf && params.replayOf.sourceRunId === ctx.runMgr.id) {
		throw new ForkTargetsSourceRunError(ctx.runMgr.id)
	}

	await ctx.runMgr.openRunDir()

	const lease = await RunLeaseHolder.acquire({
		...params.lease,
		runId: ctx.runId,
		store: ctx.runMgr.getRunStore(),
		log: ctx.log,
		// A segment that loses its lease mid-run has been superseded: every write it makes
		// from here is fenced off, so the work it is doing is work nobody will accept.
		// Stopping it is the difference between wasting one provider call and wasting the
		// rest of the run.
		onLost: (err) => ctx.abortController.abort(err),
	})

	try {
		if (!params.resumeFromCheckpoint) return { lease }

		const persisted = await ctx.runMgr.getRunStore().readRunMeta()
		if (persisted && isTerminalStatus(persisted.status)) {
			throw new RunNotResumableError(ctx.runMgr.id, persisted.status)
		}

		const resumeCheckpoint = await checkpointMgr.restore(params.resumeFromCheckpoint)
		ctx.runMgr.restoreFromCheckpoint(resumeCheckpoint)
		guard.restoreElapsed(resumeCheckpoint.guardState?.elapsedMs ?? 0)
		return { lease, resumeCheckpoint }
	} catch (err) {
		// Refused after the lease was taken. Hand it straight back, or a run that merely
		// declined one bad resume would look held for a full TTL to the next one.
		await lease.release()
		throw err
	}
}

export async function* query(params: QueryParams): AsyncGenerator<RunEvent, Run> {
	// Boot-time filesystem migration (session-hierarchy.md §13.4.1). First
	// call per process per root actually runs; subsequent calls short-circuit
	// via the in-memory guard in `context.ts`. Kept here rather than inside
	// the synchronous `RunContextFactory.build` so the factory signature stays
	// sync for tests / non-async call sites.
	const cwdForMigration = params.workingDirectory ?? process.cwd()
	await RunContextFactory.ensureMigrated(`${cwdForMigration}/.namzu`)

	const resumeHandler = params.resumeHandler ?? deferredReviewHandler

	const ctx = RunContextFactory.build({
		agentId: params.agentId,
		agentName: params.agentName,
		runConfig: params.runConfig,
		provider: params.provider,
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
		runId: params.runId,
		parentRunId: params.parentRunId,
		depth: params.depth,
		replayOf: params.replayOf,
	})

	ctx.planManager.setApprovalHandler(async (request) => {
		const decision = await resumeHandler({
			type: 'plan_approval',
			requestId: generateDecisionRequestId(),
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
			return { approved: true }
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

	const verificationGate = params.verificationGate?.enabled
		? new VerificationGate(params.verificationGate, ctx.log)
		: undefined

	const toolExecutor = ToolingBootstrap.init(
		{
			tools: params.tools,
			runId: ctx.runId,
			workingDirectory: ctx.cwd,
			permissionMode: ctx.permissionMode,
			env: params.runConfig.env ?? {},
			abortSignal: ctx.abortController.signal,
			invocationState: params.invocationState,
			pluginManager: params.pluginManager,
			// The same gate the review phase consults, handed to the executor as a
			// bare decision so the deny plane is re-applied to the FINAL input — the
			// one that survived every human and plugin rewrite. See `denyFinalInput`.
			denyCheck: verificationGate ? (call) => verificationGate.evaluate(call) : undefined,
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
		allowedTools: params.allowedTools,
	})

	const guard = new GuardCoordinator({
		tokenBudget: params.runConfig.tokenBudget,
		timeoutMs: params.runConfig.timeoutMs,
		costLimitUsd: params.runConfig.costLimitUsd,
		maxIterations: params.runConfig.maxIterations,
	})

	const checkpointMgr = new CheckpointManager(ctx.runMgr.getRunStore())

	const resultAssembler = new ResultAssembler({
		runMgr: ctx.runMgr,
		planManager: ctx.planManager,
		activityStore: ctx.activityStore,
		log: ctx.log,
		emitEvent: eventTranslator.emitEvent,
		drainPending: () => eventTranslator.drainPending(),
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

	const iterationOrchestrator = new IterationOrchestrator(
		{
			provider: params.provider,
			runConfig: params.runConfig,
			tools: params.tools,
			allowedTools: params.allowedTools,
			frameNonce: ctx.frameNonce,
			taskGateway: params.taskGateway,
			taskStore: params.taskStore,
			launchedTasks: params.launchedTasks,
			advisoryCtx,
			compactionConfig: params.compactionConfig,
			workingStateManager,
			agentBus: params.agentBus,
			verificationGate: verificationGate,
			pluginManager: params.pluginManager,
		},
		ctx.runMgr,
		toolExecutor,
		guard,
		ctx.activityStore,
		eventTranslator.emitEvent,
		() => eventTranslator.drainPending(),
		ctx.abortController,
		ctx.log,
		resumeHandler,
		checkpointMgr,
		ctx.planManager,
	)

	const tracer = getTracer()

	return yield* (async function* (): AsyncGenerator<RunEvent, Run> {
		// ─── Admission (ses_017 G1/G2) ───────────────────────────────────────────
		//
		// Take the run's lease and decide whether this segment may drive it AT ALL —
		// **outside the try, before the span, before the first write.** The placement is
		// the whole guarantee, not a style choice: everything inside the try is funnelled
		// into `resultAssembler.handleError`, which marks the run FAILED, and
		// `finalize()` then PERSISTS that. A refusal raised in there would write
		// `status: 'failed'`, `messageCount: 0` and an **empty `messages.json`** over the
		// record it was refusing to touch — destroying the run it exists to protect. A
		// refusal must throw out of `query()` having written nothing, and from here it
		// does.
		const { lease, resumeCheckpoint } = await admitSegment(params, ctx, checkpointMgr, guard)

		const rootSpan = tracer.startSpan(agentRunSpanName(params.agentName))
		rootSpan.setAttributes({
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			[GENAI.AGENT_NAME]: params.agentName,
			[GENAI.AGENT_ID]: params.agentId,
			[GENAI.REQUEST_MODEL]: params.runConfig.model,
			[GENAI.SYSTEM]: params.provider.id,
		})

		let sandbox: Sandbox | undefined

		try {
			try {
				await ctx.runMgr.init()

				// The ActivityStore deliberately starts EMPTY on resume: a checkpoint carries
				// no per-activity history, so there is nothing to hydrate it from. Acceptable
				// because activities are observability, not accounting — no limit is enforced
				// against them — so a resumed run's activity feed shows only this segment's
				// work. Same for the PlanManager and the WorkingStateManager; both are
				// rebuilt empty. None of them meters a budget; all of them are the durable-
				// pause programme's problem, not this one's.

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
					allowedTools: params.allowedTools,
				}

				const segments: PromptSegments = params.contextCache
					? params.contextCache.getSystemPromptSegmented(
							cacheInput,
							contextLevel,
							params.workingDirectory,
							ctx.frameNonce,
						)
					: promptBuilder.buildSegmented(contextLevel, params.workingDirectory, ctx.frameNonce)

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

				if (resumeCheckpoint) {
					await eventTranslator.emitEvent({
						type: 'run_resuming',
						runId: ctx.runMgr.id,
						fromCheckpointId: resumeCheckpoint.id,
					})
					yield* eventTranslator.drainPending()

					pushSystemMessages()
					// The pending decision is what tells the repair apart from the destruction.
					// Without it, `prepareResumeMessages` rewrites the still-unexecuted tool call
					// the human was asked to approve into a "tool result missing" placeholder —
					// correct for a crash, catastrophic for a pause. Passing the decision is not
					// optional politeness; it is the fix.
					for (const msg of prepareResumeMessages(
						resumeCheckpoint.messages,
						resumeCheckpoint.pendingDecision,
					)) {
						ctx.runMgr.pushMessage(msg)
					}
				} else if (params.continuationMode) {
					// The caller owns the whole history here, system prompt included — so
					// nothing installs a system message for this run, and the frame nonce is
					// freshly minted per run. Without the declaration below, every frame this
					// run emits would carry a token the model was never told to trust, which
					// is the same as emitting no token at all (ses_016 pre-freeze M5).
					// It is spliced in after the caller's own leading system run rather than
					// prepended, so the cached static prefix keeps its position. A stale
					// declaration from the previous run may sit alongside it; the wording is
					// positive-only, so two live tokens read as two things the framework
					// wrote, not as a contradiction.
					const provided = [...params.messages]
					let insertAt = 0
					while (insertAt < provided.length && provided[insertAt]?.role === 'system') insertAt++
					provided.splice(
						insertAt,
						0,
						createSystemMessage(buildFrameAuthentication(ctx.frameNonce), 'ephemeral'),
					)
					for (const msg of provided) {
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

				// --- The resume dispatcher (ses_017 D2) ---
				//
				// WHERE THIS SITS IS THE DESIGN. It runs OUTSIDE `runLoop`, after the checkpoint
				// is restored, the accounting hydrated, the deps built and the sandbox created —
				// and BEFORE compaction and before any model call. Everything that used to touch
				// a resumed history first destroyed it:
				//
				//   1. `prepareResumeMessages` REPAIRED it, rewriting the pending tool call into
				//      "[SYSTEM] Tool result missing" (now suppressed while a decision owns it);
				//   2. `runCompactionCheck`, at the top of every iteration inside `runLoop`, can
				//      summarise or drop it;
				//   3. the model call then ships whatever is left.
				//
				// The dispatcher runs before all three, so the decision is applied to the block
				// while the block still exists. Nothing between the seeding above and this line
				// can touch the history: `pushSystemMessages` only prepends, and the `run_start`
				// lifecycle hooks carry no mutable payload (`applyLifecycleHookResults` accepts
				// only `continue` / `error`). There is no path from a restored pending decision
				// to a provider that does not pass through here.
				let disposition: RunDisposition | undefined

				if (resumeCheckpoint?.pendingDecision) {
					const signal = yield* dispatchPendingDecision(
						iterationOrchestrator.context,
						resumeCheckpoint,
						// The sandbox this batch is about to run in was built moments ago, by the
						// block above. It is NOT the one the iterations before the pause worked in —
						// that one was destroyed when the run parked, because a Sandbox cannot
						// outlive its process. The model is told, rather than left to reason from a
						// filesystem that no longer exists.
						{ freshSandbox: sandbox !== undefined },
					)
					// `suspend` — the decision was still unanswered, so it was re-emitted and the
					// run parked again. `stop` — the decision was `abort`, and the run is over.
					// Either way the loop must not run: there is nothing left for it to do, and
					// entering it would start a fresh iteration on a run that just ended.
					if (signal === 'suspend') disposition = 'suspended'
					else if (signal === 'stop') disposition = 'completed'
				}

				// The decision was applied and the interrupted iteration finished. Now the loop
				// picks up at iteration N+1, exactly where it would have been had nobody paused.
				if (disposition === undefined) {
					disposition = yield* iterationOrchestrator.runLoop()
				}

				// The loop TELLS us why it returned; we do not guess. A suspended run is
				// not finished — it has more to do the moment a decision arrives — so it
				// gets none of the end-of-run treatment: no `run_end` hooks (they would
				// fire again on resume, and a plugin that tears down on `run_end` would
				// tear down a live run), no `run_completed`, no `endedAt`, no result.
				// `persist()` in `finalize()` still runs, and writes the suspension.
				if (disposition === 'suspended') {
					yield* resultAssembler.suspendRun(rootSpan)
				} else {
					if (params.pluginManager) {
						const hookResults = await params.pluginManager.executeHooks(
							'run_end',
							{ runId: ctx.runId },
							eventTranslator.emitEvent,
						)
						applyLifecycleHookResults('run_end', hookResults)
						yield* eventTranslator.drainPending()
					}

					yield* resultAssembler.completeRun(rootSpan)
				}
			} catch (err) {
				yield* resultAssembler.handleError(err, rootSpan)
			} finally {
				// --- Sandbox lifecycle: destroy at the end of the SEGMENT ---
				//
				// **A sandbox is per-segment, and a suspended run's sandbox goes with the rest
				// of them.** It cannot be otherwise: `SandboxProvider.create()` mints a fresh
				// root and `destroy()` removes it, and nothing in the contract can re-attach to
				// an existing one — so a pause that is *meant* to outlive the process cannot
				// carry it across. The alternative, holding it open, strands a temp tree and its
				// processes for as long as a human takes to answer and STILL does not survive
				// the redeploy the durable pause exists to survive. It goes.
				//
				// What must not happen is for it to go silently: the batch a human approves then
				// runs in a fresh, empty sandbox, and a model told only "no such file" debugs a
				// phantom. The resumed run says so, in the history, right after the results —
				// see `FRESH_SANDBOX_NOTE` in the dispatcher.
				if (sandbox) {
					const sandboxId = sandbox.id
					if (ctx.runMgr.status === 'awaiting_input') {
						ctx.log.warn(
							'Run parked with a sandbox — destroying it. A Sandbox cannot be reattached, so the resumed run gets a NEW, EMPTY one and any sandbox-local state this segment built is gone. A tool whose effect depends on that state must not be parked for review.',
							{ sandboxId, runId: ctx.runId },
						)
					}
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
				rootSpan.end()
			}

			return await resultAssembler.finalize()
		} finally {
			// The run is handed back — parked, finished or failed. A parked run must be
			// resumable AT ONCE, and it is only free once this runs; a lease left outstanding
			// would make every clean pause look like a crash for a full TTL. A segment that
			// was FENCED (taken over while it ran) releases nothing: the current lease is not
			// its lease to hand back.
			await lease.release()
		}
	})()
}

/**
 * Drive a run to a stopping point and hand back the {@link Run}.
 *
 * **Its handler default is `autoApproveHandler`, and it stays that way** — deliberately
 * different from `query()`, whose absent handler parks the run. The asymmetry is the
 * conservative choice, not an oversight: `drainQuery` has *always* substituted
 * auto-approve for a missing handler, so flipping it to park would silently convert
 * every existing caller's run from "approve and finish" into "wait forever for a
 * decision nobody is coming to make". A caller that wants a durable pause here asks for
 * one, by passing {@link deferredReviewHandler} or a handler that answers `pause`.
 *
 * Note that a `drainQuery` that parks still returns — the Run comes back
 * `awaiting_input`, and is resumed out of band via
 * {@link import('./decision/resume.js').resumeDecision}.
 */
export async function drainQuery(params: QueryParams, listener?: RunEventListener): Promise<Run> {
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
