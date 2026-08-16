import { drainQuery } from '../runtime/query/index.js'
import type {
	AgentInput,
	AgentMetadata,
	ReactiveAgentConfig,
	ReactiveAgentResult,
} from '../types/agent/index.js'
import type { AssistantMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/index.js'
import type { Logger } from '../utils/logger.js'
import { AbstractAgent } from './AbstractAgent.js'

export class ReactiveAgent extends AbstractAgent<ReactiveAgentConfig, ReactiveAgentResult> {
	readonly type = 'reactive' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>, log?: Logger) {
		super(
			{
				...metadata,
				type: 'reactive',
				capabilities: {
					supportsTools: true,
					supportsStreaming: true,
					supportsConcurrency: false,
					supportsSubAgents: false,
				},
			},
			log,
		)
	}

	/**
	 * One run at a time per instance.
	 *
	 * `abortController` and `currentRunId` are instance state, so two
	 * overlapping runs share one abort controller — cancelling either kills
	 * both — and the second clobbers the first's run id, so a later
	 * `cancel()` cancels the wrong run. Neither failure announces itself.
	 * A host that wants parallelism constructs a second instance.
	 */
	async run(
		input: AgentInput,
		config: ReactiveAgentConfig,
		listener?: RunEventListener,
	): Promise<ReactiveAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: ReactiveAgentConfig,
		listener?: RunEventListener,
	): Promise<ReactiveAgentResult> {
		const startTime = Date.now()
		const runId = this.createRunId()
		this.bindRun(runId, config.logger)

		if (!config.sessionId || !config.topicId || !config.projectId || !config.tenantId) {
			throw new Error(
				'ReactiveAgent requires sessionId, topicId, projectId, and tenantId in config (session-hierarchy.md §12.1).',
			)
		}

		const run = await drainQuery(
			{
				systemPrompt: config.systemPrompt,
				persona: config.persona,
				skills: config.skills,
				basePrompt: config.basePrompt,
				provider: config.provider,
				tools: config.tools,
				...(config.verificationGate ? { verificationGate: config.verificationGate } : {}),
				...(config.authorizationGate ? { authorizationGate: config.authorizationGate } : {}),
				...(config.sandboxProvider ? { sandboxProvider: config.sandboxProvider } : {}),
				// Working-memory / compaction seam (optional; absent => unchanged run path).
				...(config.compactionConfig ? { compactionConfig: config.compactionConfig } : {}),
				...(config.workingMemoryProvider
					? { workingMemoryProvider: config.workingMemoryProvider }
					: {}),
				// Loop-control and resilience seams. These lived on
				// `QueryParams` and stopped there, so every one of them was
				// unreachable for a consumer using the Agent classes — which is
				// what `AgentManager` spawns and what the estate's own
				// applications call. A feature a consumer cannot reach is a
				// feature that does not exist for them.
				...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
				...(config.retry !== undefined ? { retry: config.retry } : {}),
				...(config.emergencySave !== undefined ? { emergencySave: config.emergencySave } : {}),
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
				...(config.structuredOutput ? { structuredOutput: config.structuredOutput } : {}),
				...(config.inputGuardrails ? { inputGuardrails: config.inputGuardrails } : {}),
				...(config.outputGuardrails ? { outputGuardrails: config.outputGuardrails } : {}),
				...(config.checkpointStore ? { checkpointStore: config.checkpointStore } : {}),
				...(config.parentSpan ? { parentSpan: config.parentSpan } : {}),
				runConfig: {
					model: config.model,
					tokenBudget: config.tokenBudget,
					timeoutMs: config.timeoutMs,
					maxIterations: config.maxIterations,
					temperature: config.temperature,
					maxResponseTokens: config.maxResponseTokens,
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
				runId,
				parentRunId: config.parentRunId,
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
		for (const msg of run.messages) {
			if (msg.role === 'assistant') {
				const assistantMsg = msg as AssistantMessage
				if (assistantMsg.toolCalls) {
					toolCallCount += assistantMsg.toolCalls.length
				}
			}
		}

		return {
			runId: run.id,
			status: run.status,
			stopReason: run.stopReason,
			usage: run.tokenUsage,
			cost: run.costInfo,
			iterations: run.currentIteration,
			durationMs: Date.now() - startTime,
			messages: run.messages,
			result: run.result,
			structuredOutput: run.structuredOutput,
			lastError: run.lastError,
			toolCallCount,
		}
	}

	override async cancel(): Promise<void> {
		this.abortController.abort()
	}
}
