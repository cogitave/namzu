import {
	AdvisorRegistry,
	AdvisoryContext,
	AdvisoryExecutor,
	TriggerEvaluator,
} from '../../advisory/index.js'
import { extractFromUserMessage } from '../../compaction/extractor.js'
import { WorkingStateManager } from '../../compaction/manager.js'
import type { CompactionConfig } from '../../config/runtime.js'
import { getTracer } from '../../provider/telemetry/setup.js'
import { GENAI, NAMZU, agentRunSpanName } from '../../telemetry/attributes.js'
import { buildAdvisoryTools } from '../../tools/advisory/index.js'
import { SearchToolsTool } from '../../tools/builtins/search-tools.js'
import { buildTaskTools } from '../../tools/task/index.js'
import type { AdvisoryConfig } from '../../types/advisory/index.js'
import type { RuntimeToolOverrides } from '../../types/agent/base.js'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import {
	type CheckpointId,
	type ResumeHandler,
	autoApproveHandler,
} from '../../types/hitl/index.js'
import type { RunId, ThreadId } from '../../types/ids/index.js'
import type { InvocationState } from '../../types/invocation/index.js'
import { type Message, createSystemMessage } from '../../types/message/index.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { TaskRouterConfig } from '../../types/router/index.js'
import type { AgentRun, AgentRunConfig, RunEvent, RunEventListener } from '../../types/run/index.js'
import type { Sandbox, SandboxProvider } from '../../types/sandbox/index.js'
import type { Skill } from '../../types/skills/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { VerificationGateConfig } from '../../types/verification/index.js'
import type { ModelPricing } from '../../utils/cost.js'
import { VerificationGate } from '../../verification/gate.js'
import { CheckpointManager } from './checkpoint.js'
import type { ContextCache } from './context-cache.js'
import { RunContextFactory } from './context.js'
import { EventTranslator } from './events.js'
import { GuardCoordinator } from './guard.js'
import { IterationOrchestrator } from './iteration/index.js'
import { PromptBuilder } from './prompt.js'
import type { PromptSegments } from './prompt.js'
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
	resumeHandler: ResumeHandler
	resumeFromCheckpoint?: CheckpointId

	threadId: ThreadId

	runId?: RunId

	parentRunId?: RunId

	depth?: number

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

export async function* query(params: QueryParams): AsyncGenerator<RunEvent, AgentRun> {
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
		threadId: params.threadId,
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

	const toolExecutor = ToolingBootstrap.init(
		{
			tools: params.tools,
			runId: ctx.runId,
			workingDirectory: ctx.cwd,
			permissionMode: ctx.permissionMode,
			env: params.runConfig.env ?? {},
			abortSignal: ctx.abortController.signal,
			invocationState: params.invocationState,
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

	const verificationGate = params.verificationGate?.enabled
		? new VerificationGate(params.verificationGate, ctx.log)
		: undefined

	const iterationOrchestrator = new IterationOrchestrator(
		{
			provider: params.provider,
			runConfig: params.runConfig,
			tools: params.tools,
			allowedTools: params.allowedTools,
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
		params.resumeHandler,
		checkpointMgr,
		ctx.planManager,
	)

	const tracer = getTracer()

	return yield* (async function* (): AsyncGenerator<RunEvent, AgentRun> {
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
				allowedTools: params.allowedTools,
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

				pushSystemMessages()
				for (const msg of checkpoint.messages) {
					if (msg.role === 'system') continue
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

			if (params.pluginManager) {
				await params.pluginManager.executeHooks('run_start', {
					runId: ctx.runId,
				})
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

			yield* iterationOrchestrator.runLoop()

			if (params.pluginManager) {
				await params.pluginManager.executeHooks('run_end', {
					runId: ctx.runId,
				})
			}

			yield* resultAssembler.completeRun(rootSpan)
		} catch (err) {
			yield* resultAssembler.handleError(err, rootSpan)
		} finally {
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
			rootSpan.end()
		}

		return await resultAssembler.finalize()
	})()
}

export async function drainQuery(
	params: Omit<QueryParams, 'resumeHandler'> & { resumeHandler?: ResumeHandler },
	listener?: RunEventListener,
): Promise<AgentRun> {
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
