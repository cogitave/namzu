import { drainQuery } from '../runtime/query/index.js'
import type {
	AgentInput,
	AgentMetadata,
	QueryAgentConfig,
	QueryAgentResult,
} from '../types/agent/index.js'
import type { AssistantMessage } from '../types/message/index.js'
import type { SessionEventListener } from '../types/session/events.js'
import type { Logger } from '../utils/logger.js'
import { AbstractAgent } from './AbstractAgent.js'

export class QueryAgent extends AbstractAgent<QueryAgentConfig, QueryAgentResult> {
	readonly type: string

	constructor(metadata: Omit<AgentMetadata, 'capabilities'>, log?: Logger) {
		super(
			{
				...metadata,
				type: metadata.type,
				capabilities: {
					supportsTools: true,
					supportsStreaming: true,
					supportsConcurrency: false,
					supportsSubAgents: false,
				},
			},
			log,
		)
		this.type = metadata.type
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
		config: QueryAgentConfig,
		listener?: SessionEventListener,
	): Promise<QueryAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: QueryAgentConfig,
		listener?: SessionEventListener,
	): Promise<QueryAgentResult> {
		const startTime = Date.now()
		if (!config.sessionId || !config.topicId || !config.projectId || !config.tenantId) {
			throw new Error(
				'QueryAgent requires sessionId, topicId, projectId, and tenantId in config (session-hierarchy.md §12.1).',
			)
		}
		const turnId = this.createTurnId()
		this.bindTurn(config.sessionId, turnId, config.logger)

		const turn = await drainQuery(
			{
				systemPrompt: config.systemPrompt,
				persona: config.persona,
				skills: config.skills,
				basePrompt: config.basePrompt,
				provider: config.provider,
				...(config.budget ? { budget: config.budget } : {}),
				toolsets: config.toolsets,
				...(input.attachmentStore ? { attachmentStore: input.attachmentStore } : {}),
				...(config.attachmentResolveTimeoutMs !== undefined
					? { attachmentResolveTimeoutMs: config.attachmentResolveTimeoutMs }
					: {}),
				...(config.authorizationGate ? { authorizationGate: config.authorizationGate } : {}),
				...(config.sandboxProvider ? { sandboxProvider: config.sandboxProvider } : {}),
				...(config.sandboxTeardownTimeoutMs !== undefined
					? { sandboxTeardownTimeoutMs: config.sandboxTeardownTimeoutMs }
					: {}),
				...(config.outsideRootAccess ? { outsideRootAccess: config.outsideRootAccess } : {}),
				...(config.sandboxEscape ? { sandboxEscape: config.sandboxEscape } : {}),
				// Working-memory / compaction seam (optional; absent => unchanged run path).
				...(config.compactionConfig ? { compactionConfig: config.compactionConfig } : {}),
				...(config.workingMemoryProvider
					? { workingMemoryProvider: config.workingMemoryProvider }
					: {}),
				// Forward the same loop-control and resilience settings a direct
				// `query()` caller can supply. An `AgentManager` host should not lose
				// them just because it uses an Agent instance for delegation.
				...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
				// The switch that sends rule-allowed and grant-covered batches to
				// that handler (plan mode). A delegated child inherits it from the
				// manager; dropped here, the child would run them past the handler.
				...(config.reviewAllowedCalls ? { reviewAllowedCalls: config.reviewAllowedCalls } : {}),
				...(config.retry !== undefined ? { retry: config.retry } : {}),
				...(config.toolTimeoutMs !== undefined ? { toolTimeoutMs: config.toolTimeoutMs } : {}),
				...(config.toolRetryBackoff !== undefined
					? { toolRetryBackoff: config.toolRetryBackoff }
					: {}),
				...(config.maxToolConcurrency !== undefined
					? { maxToolConcurrency: config.maxToolConcurrency }
					: {}),
				...(config.maxToolOutputChars !== undefined
					? { maxToolOutputChars: config.maxToolOutputChars }
					: {}),
				...(config.toolResultGuardrails !== undefined
					? { toolResultGuardrails: config.toolResultGuardrails }
					: {}),
				...(config.retainedToolPreviewChars !== undefined
					? { retainedToolPreviewChars: config.retainedToolPreviewChars }
					: {}),
				...(config.maxToolContentBytes !== undefined
					? { maxToolContentBytes: config.maxToolContentBytes }
					: {}),
				...(config.repairToolCall ? { repairToolCall: config.repairToolCall } : {}),
				...(config.stopWhen ? { stopWhen: config.stopWhen } : {}),
				...(config.onStepFinish ? { onStepFinish: config.onStepFinish } : {}),
				...(config.prepareStep ? { prepareStep: config.prepareStep } : {}),
				...(config.beforeStep ? { beforeStep: config.beforeStep } : {}),
				...(config.allowedTools ? { allowedTools: [...config.allowedTools] } : {}),
				...(config.deniedTools ? { deniedTools: [...config.deniedTools] } : {}),
				...(config.inboundMessages ? { inboundMessages: config.inboundMessages } : {}),
				...(config.projectInstructionContext
					? { projectInstructionContext: config.projectInstructionContext }
					: {}),
				...(config.steering ? { steering: config.steering } : {}),
				...(config.structuredOutput ? { structuredOutput: config.structuredOutput } : {}),
				...(config.inputGuardrails ? { inputGuardrails: config.inputGuardrails } : {}),
				...(config.outputGuardrails ? { outputGuardrails: config.outputGuardrails } : {}),
				...(config.checkpointStore ? { checkpointStore: config.checkpointStore } : {}),
				...(config.paths ? { paths: config.paths } : {}),
				// Forwarded so a session log in memory keeps the whole session
				// there; dropped here, the turn would build a disk log instead.
				...(config.sessionLog ? { sessionLog: config.sessionLog } : {}),
				...(config.parentSpan ? { parentSpan: config.parentSpan } : {}),
				turnConfig: {
					model: config.model,
					...(config.webSearch ? { webSearch: config.webSearch } : {}),
					tokenBudget: config.tokenBudget,
					timeoutMs: config.timeoutMs,
					...(config.sandbox ? { sandbox: config.sandbox } : {}),
					...(config.streamIdleTimeoutMs !== undefined
						? { streamIdleTimeoutMs: config.streamIdleTimeoutMs }
						: {}),
					...(config.maxRequestRichContentBytes !== undefined
						? { maxRequestRichContentBytes: config.maxRequestRichContentBytes }
						: {}),
					maxIterations: config.maxIterations,
					temperature: config.temperature,
					maxResponseTokens: config.maxResponseTokens,
					...(config.pruneKeepLast !== undefined ? { pruneKeepLast: config.pruneKeepLast } : {}),
					costLimitUsd: config.costLimitUsd,
					permissionMode: config.permissionMode,
					env: config.env,
					logger: this.log,
					// Hand-listed, so anything not named here is dropped in silence.
					// That is how both of these came to be unreachable from every
					// entry point except the raw kernel one.
					...(config.thinking ? { thinking: config.thinking } : {}),
					...(config.effort ? { effort: config.effort } : {}),
				},
				agentId: this.metadata.id,
				agentName: this.metadata.name,
				workingDirectory: input.workingDirectory,
				sessionId: config.sessionId,
				topicId: config.topicId,
				projectId: config.projectId,
				tenantId: config.tenantId,
				turnId,
				...(config.parentSessionId ? { parentSessionId: config.parentSessionId } : {}),
				...(config.parentTurnId ? { parentTurnId: config.parentTurnId } : {}),
				depth: config.depth,
				contextLevel: config.contextLevel,
				messages: input.messages,
				signal: input.signal,
				taskStore: input.taskStore,
				runtimeToolOverrides: input.runtimeToolOverrides,
				runtimeContext: input.runtimeContext,
				advisory: config.advisory,
				invocationState: config.invocationState,
			},
			listener,
		)

		let toolCallCount = 0
		for (const msg of turn.messages) {
			if (msg.role === 'assistant') {
				const assistantMsg = msg as AssistantMessage
				if (assistantMsg.toolCalls) {
					toolCallCount += assistantMsg.toolCalls.length
				}
			}
		}

		return {
			sessionId: turn.sessionId,
			turnId: turn.id,
			status: turn.status,
			stopReason: turn.stopReason,
			usage: turn.tokenUsage,
			...(turn.budget ? { budget: turn.budget } : {}),
			cost: turn.costInfo,
			iterations: turn.currentIteration,
			durationMs: Date.now() - startTime,
			messages: turn.messages,
			result: turn.result,
			structuredOutput: turn.structuredOutput,
			lastError: turn.lastError,
			toolCallCount,
		}
	}

	override async cancel(): Promise<void> {
		this.abortController.abort()
	}
}
