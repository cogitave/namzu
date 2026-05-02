import { drainQuery } from '../runtime/query/index.js'
import type {
	AgentInput,
	AgentMetadata,
	ReactiveAgentConfig,
	ReactiveAgentResult,
} from '../types/agent/index.js'
import type { AssistantMessage } from '../types/message/index.js'
import type { RunEventListener } from '../types/run/index.js'
import { AbstractAgent } from './AbstractAgent.js'

export class ReactiveAgent extends AbstractAgent<ReactiveAgentConfig, ReactiveAgentResult> {
	readonly type = 'reactive' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>) {
		super({
			...metadata,
			type: 'reactive',
			capabilities: {
				supportsTools: true,
				supportsStreaming: true,
				supportsConcurrency: false,
				supportsSubAgents: false,
			},
		})
	}

	async run(
		input: AgentInput,
		config: ReactiveAgentConfig,
		listener?: RunEventListener,
	): Promise<ReactiveAgentResult> {
		const startTime = Date.now()

		if (!config.sessionId || !config.threadId || !config.projectId || !config.tenantId) {
			throw new Error(
				'ReactiveAgent requires sessionId, threadId, projectId, and tenantId in config (session-hierarchy.md §12.1).',
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
				},
				agentId: this.metadata.id,
				agentName: this.metadata.name,
				workingDirectory: input.workingDirectory,
				sessionId: config.sessionId,
				threadId: config.threadId,
				projectId: config.projectId,
				tenantId: config.tenantId,
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
			lastError: run.lastError,
			toolCallCount,
		}
	}

	override async cancel(): Promise<void> {
		this.abortController.abort()
	}
}
