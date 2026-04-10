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

		if (!config.threadId) {
			throw new Error('ReactiveAgent.run requires a threadId in config')
		}

		const session = await drainQuery(
			{
				systemPrompt: config.systemPrompt,
				persona: config.persona,
				skills: config.skills,
				basePrompt: config.basePrompt,
				provider: config.provider,
				tools: config.tools,
				sessionConfig: {
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
				threadId: config.threadId,
				parentRunId: config.parentRunId,
				depth: config.depth,
				contextLevel: config.contextLevel,
				messages: input.messages,
				signal: input.signal,
				taskStore: input.taskStore,
				runtimeToolOverrides: input.runtimeToolOverrides,
				advisory: config.advisory,
			},
			listener,
		)

		let toolCallCount = 0
		for (const msg of session.messages) {
			if (msg.role === 'assistant') {
				const assistantMsg = msg as AssistantMessage
				if (assistantMsg.toolCalls) {
					toolCallCount += assistantMsg.toolCalls.length
				}
			}
		}

		return {
			runId: session.id,
			status: session.status,
			stopReason: session.stopReason,
			usage: session.tokenUsage,
			cost: session.costInfo,
			iterations: session.currentIteration,
			durationMs: Date.now() - startTime,
			messages: session.messages,
			result: session.result,
			lastError: session.lastError,
			toolCallCount,
		}
	}

	override async cancel(): Promise<void> {
		this.abortController.abort()
	}
}
