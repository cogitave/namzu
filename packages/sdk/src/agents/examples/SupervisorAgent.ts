import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { drainQuery } from '../../runtime/query/index.js'
import { PendingAnswers, QuestionParkBinding } from '../../runtime/query/question-park.js'
import { CompletionInbox } from '../../scheduler/completion-inbox.js'
import { LocalTaskScheduler } from '../../scheduler/local.js'
import {
	ASK_USER_QUESTION_TOOL_NAME,
	buildCoordinatorTools,
} from '../../tools/coordinator/index.js'
import { toolset } from '../../toolsets/toolset.js'
import { deferred, filtered } from '../../toolsets/wrappers.js'
import type {
	AgentInput,
	AgentMetadata,
	AgentTaskResult,
	SupervisorAgentConfig,
	SupervisorAgentResult,
} from '../../types/agent/index.js'
import type { TaskHandle, TaskScheduler } from '../../types/agent/scheduler.js'
import type { AgentTaskContext } from '../../types/agent/task.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import { deriveChildState } from '../../types/invocation/index.js'
import type { ActorRef } from '../../types/session/actor.js'
import type { SessionEventListener } from '../../types/session/events.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { ZERO_COST } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import { AbstractAgent } from '../AbstractAgent.js'
import { resolveAgentBudget } from '../budget.js'
import { childSessionStorage } from '../storage.js'

/**
 * Build the authoritative per-task ledger from the gateway's task handles.
 *
 * A handle carries a `result` only when its worker actually produced one. A
 * handle with NO result never produced a verifiable outcome, so it MUST NOT be
 * synthesized as a success: the synthesized status is always the terminal
 * `'failed'`, regardless of the handle's reported `state` (which may itself be
 * `'completed'`).
 *
 * The earlier implementation cast `handle.state` onto the synthesized result's
 * status, letting a worker that ended without a result count toward
 * `completedTasks`. That produced fabricated "done" workers with empty outputs
 * (observed in a live supervised session): the supervisor reported "3 workers done, 40KB
 * reports" when the workers never started. Real workers (those with a present
 * `result`) are unaffected — their `result` is preserved verbatim.
 */
export function synthesizeTaskResults(
	taskHandles: readonly TaskHandle[],
	turn: { readonly sessionId: SessionId; readonly turnId: TurnId },
	now: number = Date.now(),
): AgentTaskResult[] {
	return taskHandles.map((handle, index) => ({
		agentId: handle.agentId,
		result: handle.result ?? {
			sessionId: turn.sessionId,
			turnId: turn.turnId,
			status: 'failed' as const,
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: now - handle.createdAt,
			messages: [],
		},
		taskIndex: index,
	}))
}

/** Count only the task results that genuinely completed. */
export function countCompletedTasks(taskResults: readonly AgentTaskResult[]): number {
	return taskResults.filter((t) => t.result.status === 'completed').length
}

/** @deprecated Example of supervised delegation; hosts can compose their own agent. */
export class SupervisorAgent extends AbstractAgent<SupervisorAgentConfig, SupervisorAgentResult> {
	readonly type = 'supervisor' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>, log?: Logger) {
		super(
			{
				...metadata,
				type: 'supervisor',
				capabilities: {
					supportsTools: true,
					supportsStreaming: true,
					supportsConcurrency: true,
					supportsSubAgents: true,
				},
			},
			log,
		)
	}

	/**
	 * One turn at a time per instance.
	 *
	 * `abortController` and `currentSessionId` are instance state, so two
	 * overlapping turns share one abort controller — cancelling either kills
	 * both — and the second clobbers the first's session, so a later
	 * `cancel()` cancels the wrong children. Neither failure announces itself.
	 * A host that wants parallelism constructs a second instance.
	 */
	async run(
		input: AgentInput,
		config: SupervisorAgentConfig,
		listener?: SessionEventListener,
	): Promise<SupervisorAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: SupervisorAgentConfig,
		listener?: SessionEventListener,
	): Promise<SupervisorAgentResult> {
		const startTime = Date.now()
		if (!config.sessionId || !config.topicId || !config.projectId || !config.tenantId) {
			throw new Error(
				'SupervisorAgent requires sessionId, topicId, projectId, and tenantId in config (session-hierarchy.md §12.1).',
			)
		}
		const sessionId = config.sessionId
		const turnId = this.createTurnId()
		this.bindTurn(sessionId, turnId, config.logger)
		const topicId = config.topicId
		const projectId = config.projectId
		const tenantId = config.tenantId

		const parentActor: ActorRef = {
			kind: 'agent',
			agentId: this.metadata.id,
			tenantId,
		}

		// One resolve for the two spellings. Read at each of the three sites
		// instead, a host that set only `scheduler` would get a working one
		// on one path and `undefined` on another — a half-migration that
		// fails silently, which is worse than not renaming the field.
		const configuredScheduler = config.scheduler
		const budget = await resolveAgentBudget(
			input,
			{ ...config, budget: config.budget ?? configuredScheduler?.budget },
			{ sessionId, turnId },
		)
		if (configuredScheduler && configuredScheduler.budget !== budget) {
			throw new Error('Injected task scheduler must share the supervisor token budget authority')
		}

		const childStorage = await childSessionStorage(config, input.workingDirectory)

		let gateway: TaskScheduler
		if (configuredScheduler) {
			gateway = configuredScheduler
		} else if (config.agentManager) {
			const mergedFactoryOptions = config.factoryOptions
				? {
						...config.factoryOptions,
						taskRouter: config.taskRouter ?? config.factoryOptions.taskRouter,
					}
				: config.taskRouter
					? ({
							taskRouter: config.taskRouter,
						} as import('../../types/agent/index.js').AgentFactoryOptions)
					: undefined

			const taskContext: AgentTaskContext = {
				parentSessionId: sessionId,
				parentTurnId: turnId,
				parentAgentId: this.metadata.id,
				parentAbortController: this.abortController,
				// This context describes the CURRENT supervisor. AgentManager owns
				// the increment when it constructs the child. Resetting a delegated
				// supervisor to zero here made every grandchild depth one again.
				depth: config.depth ?? 0,
				budget,
				factoryOptions: mergedFactoryOptions,
				// The supervisor already hands this to its OWN turn. Handing it to
				// the spawn context makes a worker's REVIEW-tier calls reach the
				// same person. It does not grant the root-only question tool.
				// Without the handler, workers silently auto-approved themselves.
				...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
				// And the switch that sends batches the handler would otherwise
				// never see to it (plan mode), so a worker's rule-allowed or
				// grant-covered call is refused where the supervisor's would be.
				...(config.reviewAllowedCalls ? { reviewAllowedCalls: config.reviewAllowedCalls } : {}),
				// Handed down for the same reason: a worker is a fresh turn whose
				// executor installs the shipped screens unless the spawn says
				// otherwise, so the supervisor's own choice — including an
				// empty list, which `config.toolResultGuardrails` distinguishes
				// from absent by being an array at all.
				...(config.toolResultGuardrails
					? { toolResultGuardrails: config.toolResultGuardrails }
					: {}),
				tenantId,
				topicId,
				sessionId,
				projectId,
				parentActor,
				// A supervisor held in memory delegates to workers held in
				// memory; without this each worker wrote a disk log under
				// `NAMZU_HOME` its supervisor never asked for.
				...(childStorage ? { childStorage } : {}),
			}
			// The only hop between the config and the gateway's policy. Omit it
			// and the field is settable, documented, and read by nothing —
			// which is exactly the state it was in before.
			gateway = new LocalTaskScheduler(config.agentManager, taskContext, listener, input, {
				...(config.siblingFailurePolicy
					? { siblingFailurePolicy: config.siblingFailurePolicy }
					: {}),
				log: this.log,
			})
		} else {
			// Names `scheduler`, not `gateway`. An error message is a piece of
			// documentation delivered at the worst moment, and one that names
			// a field being retired teaches the name on its way out.
			throw new Error("SupervisorAgentConfig requires either 'scheduler' or 'agentManager'")
		}

		let planManagerRef: import('../../manager/plan/lifecycle.js').PlanManager | undefined

		// Created here because the TOOLS are created here: the durability
		// channel has to reach the tool instance, and the turn that supplies
		// it does not exist yet. `query` binds them once it does.
		const questionParks = new QuestionParkBinding()
		const pendingAnswers = new PendingAnswers()

		// Created here for the same reason: both ends are here. The tools claim
		// a completion when they deliver it as a `tool_result`, and the loop
		// drains whatever is left over into the transcript — so the inbox has
		// to be the same object on both sides, and this is the only place that
		// sees both.
		//
		// It attaches through `onTaskCompleted`, which every gateway already
		// implements, so a host gateway needs no change to take part.
		const completionInbox = new CompletionInbox(this.log)
		completionInbox.attach(gateway)

		// From here to the return in a try/finally, so the listener is released
		// on every way out. The registration loop below can throw
		// ToolNameCollisionError, and a host that hits that fixes its config and
		// runs again — which is how a leak of one listener per turn becomes a leak
		// of one per ATTEMPT.
		try {
			const isRootAgent = (config.depth ?? 0) === 0
			const coordinatorToolDefs = buildCoordinatorTools({
				gateway,
				completionInbox,
				workingDirectory: input.workingDirectory,
				runtimeContext: input.runtimeContext,
				allowedAgentIds: config.agentIds,
				// The only hop between the config and the decision. Omit it and
				// everything still compiles: the field is settable, documented, and
				// read by nothing — which is the shape of a declaration this repo
				// has had to go and delete before.
				allowDelegation: config.allowDelegation,
				taskStore: input.taskStore,
				sessionId,
				turnId,
				getPlanManager: () => planManagerRef,
				// A human-question tool belongs only to the root agent. The handler
				// itself still reaches `drainQuery` below: delegated REVIEW-tier
				// tool calls must keep asking the operator instead of falling back
				// to unattended auto-approval.
				...(isRootAgent && config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
				questionParks,
				pendingAnswers,
				...(config.onPlanApproved ? { onPlanApproved: config.onPlanApproved } : {}),
			})

			// The boundary is semantic, not an implementation detail of the
			// built-in builder. A host toolset containing the same capability
			// must not reopen it for a delegated agent.
			const callerToolsets = (config.toolsets ?? []).map((ts) =>
				isRootAgent ? ts : filtered(ts, (tool) => tool.name !== ASK_USER_QUESTION_TOOL_NAME),
			)

			// The coordinator tools are just another toolset now, honouring
			// `runtimeToolOverrides` the way every other kernel-mounted tool
			// family does (task tools, advisory tools) — both halves were
			// missing here and nowhere else, so `{ create_task: 'disabled' }`
			// was honoured everywhere except the one surface a host would most
			// want to decline, and a turn that must not delegate had prompt
			// text and a gateway refusal as its only defences.
			//
			// A name the host's OWN toolsets already used is refused, not
			// silently shadowed: `drainQuery` combines `callerToolsets` and
			// this toolset into one `ToolManager` (plan.md v3 §2), which
			// throws `ToolsetConflictError`, naming both sources, on any
			// collision at construction — the same mechanism any two
			// colliding toolsets hit, replacing this file's own hand-written
			// `ToolNameCollisionError` check. The principle is complete
			// mediation rather than fail-safe defaults: "proposals to gain
			// performance by remembering the result of an authority check
			// [must] be examined skeptically. If a change in authority
			// occurs, such remembered results must be systematically
			// updated" (Saltzer & Schroeder 1975, §I.A.3(c)) — a silent
			// overwrite is a remembered binding going stale unnoticed.
			const overrides = input.runtimeToolOverrides
			const coordinatorActiveTools: ToolDefinition[] = []
			const coordinatorDeferredTools: ToolDefinition[] = []
			for (const tool of coordinatorToolDefs) {
				const override = overrides?.[tool.name]
				if (override === 'disabled') continue
				;(override === 'active' || override === undefined
					? coordinatorActiveTools
					: coordinatorDeferredTools
				).push(tool)
			}
			// Two SEPARATE toolsets, not `combineToolsets`'d into one — see
			// `runtime/query/index.ts`'s identical fix: a merged toolset has no
			// single `availability` of its own, so `ToolManager` would read
			// EVERY coordinator tool back as `'active'`, silently dropping
			// `runtimeToolOverrides`' deferred half.
			const toolsets = [
				...callerToolsets,
				toolset('supervisor:coordinator:active', coordinatorActiveTools),
				deferred(toolset('supervisor:coordinator:deferred', coordinatorDeferredTools)),
			]

			const childInvocationState = deriveChildState(
				config.invocationState ?? { tenantId },
				this.metadata.id,
			)

			const turn = await drainQuery(
				{
					systemPrompt: config.systemPrompt,
					skills: config.skills,
					provider: config.provider,
					toolsets,
					...(config.toolResultGuardrails !== undefined
						? { toolResultGuardrails: config.toolResultGuardrails }
						: {}),
					...(input.attachmentStore ? { attachmentStore: input.attachmentStore } : {}),
					...(config.attachmentResolveTimeoutMs !== undefined
						? { attachmentResolveTimeoutMs: config.attachmentResolveTimeoutMs }
						: {}),
					turnConfig: {
						model: config.model,
						tokenBudget: config.tokenBudget,
						timeoutMs: config.timeoutMs,
						...(config.sandbox ? { sandbox: config.sandbox } : {}),
						...(config.streamIdleTimeoutMs !== undefined
							? { streamIdleTimeoutMs: config.streamIdleTimeoutMs }
							: {}),
						...(config.maxRequestRichContentBytes !== undefined
							? {
									maxRequestRichContentBytes: config.maxRequestRichContentBytes,
								}
							: {}),
						maxIterations: config.maxIterations,
						temperature: config.temperature,
						env: config.env,
						...(config.pruneKeepLast !== undefined ? { pruneKeepLast: config.pruneKeepLast } : {}),
						logger: this.log,
						// See ReactiveAgent: a hand-listed literal drops what nobody
						// remembered to add, and reports nothing when it does.
						...(config.thinking ? { thinking: config.thinking } : {}),
						...(config.effort ? { effort: config.effort } : {}),
					},
					questionParks,
					pendingAnswers,
					// How wide a fan-out actually runs. Absent leaves the kernel
					// default — the same forwarding ReactiveAgent has always done,
					// missing from the one agent whose job is delegation.
					...(config.maxToolConcurrency !== undefined
						? { maxToolConcurrency: config.maxToolConcurrency }
						: {}),
					agentId: this.metadata.id,
					agentName: this.metadata.name,
					workingDirectory: input.workingDirectory,
					messages: input.messages,
					signal: input.signal,
					sessionId,
					topicId,
					projectId,
					tenantId,
					turnId,
					...(config.parentSessionId ? { parentSessionId: config.parentSessionId } : {}),
					...(config.parentTurnId ? { parentTurnId: config.parentTurnId } : {}),
					depth: config.depth,
					contextLevel: 'full',
					onContextCreated: ({ planManager }) => {
						planManagerRef = planManager
					},
					taskStore: input.taskStore,
					runtimeToolOverrides: input.runtimeToolOverrides,
					runtimeContext: input.runtimeContext,
					taskScheduler: gateway,
					budget,
					completionInbox,
					advisory: config.advisory,
					invocationState: childInvocationState,
					// HITL surface: forward optional review-time hooks so hosts can
					// run "Ask before acting" supervisors instead of the default
					// auto-approve. drainQuery falls back to autoApproveHandler
					// when resumeHandler is omitted (= same behaviour as before).
					...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
					...(config.reviewAllowedCalls ? { reviewAllowedCalls: config.reviewAllowedCalls } : {}),
					// Forwarded for the same reason the handler is. A capability the
					// kernel honours in `drainQuery` but that never reaches the
					// surface a host actually constructs is a capability nobody can
					// use — which is the shape of defect this file has already been
					// corrected for twice.
					...(config.steering ? { steering: config.steering } : {}),
					...(config.inboundMessages ? { inboundMessages: config.inboundMessages } : {}),
					...(config.projectInstructionContext
						? { projectInstructionContext: config.projectInstructionContext }
						: {}),
					...(config.authorizationGate ? { authorizationGate: config.authorizationGate } : {}),
					// The one hop between the config and the tool. `drainQuery`
					// registers `structured_output` from this and the loop
					// captures it, so the kernel never cared which archetype it
					// came from — only `ReactiveAgent` was passing it.
					...(config.structuredOutput ? { structuredOutput: config.structuredOutput } : {}),
					...(config.sandboxProvider ? { sandboxProvider: config.sandboxProvider } : {}),
					...(config.sandboxTeardownTimeoutMs !== undefined
						? { sandboxTeardownTimeoutMs: config.sandboxTeardownTimeoutMs }
						: {}),
					// Working-memory / compaction seam (optional; absent => unchanged
					// run path, byte-identical for every existing consumer).
					...(config.compactionConfig ? { compactionConfig: config.compactionConfig } : {}),
					...(config.workingMemoryProvider
						? { workingMemoryProvider: config.workingMemoryProvider }
						: {}),
					...(config.paths ? { paths: config.paths } : {}),
					...(config.sessionLog ? { sessionLog: config.sessionLog } : {}),
					...(config.checkpointStore ? { checkpointStore: config.checkpointStore } : {}),
				},
				listener,
			)

			const taskHandles = gateway.listTasks()
			const taskResults = synthesizeTaskResults(taskHandles, {
				sessionId,
				turnId,
			})

			const completedTasks = countCompletedTasks(taskResults)

			return {
				sessionId,
				turnId: turn.id,
				status: turn.status === 'completed' ? 'completed' : 'failed',
				stopReason: turn.stopReason,
				usage: turn.tokenUsage,
				budget: budget.summary(),
				cost: turn.costInfo,
				iterations: turn.currentIteration,
				durationMs: Date.now() - startTime,
				messages: turn.messages,
				result: turn.result,
				// `BaseAgentResult.structuredOutput` names "an archetype's result
				// literal did not copy it" as a defect it was written to close.
				// This literal still did not copy it, so the same defect was live
				// in the one archetype nobody checked: the value would have been
				// produced, recorded on the turn, serialized into `result`, and
				// absent from the type a supervisor host actually reads.
				structuredOutput: turn.structuredOutput,
				lastError: turn.lastError,
				taskResults,
				completedTasks,
				totalTasks: taskResults.length,
			}
		} finally {
			completionInbox.close()
		}
	}
}
