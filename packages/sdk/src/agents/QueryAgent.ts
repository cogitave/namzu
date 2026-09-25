import { drainQuery } from '../runtime/query/index.js'
import type {
	AgentInvocationScope,
	AgentMetadata,
	ManagedAgentInput,
	QueryAgentConfig,
	QueryAgentResult,
} from '../types/agent/index.js'
import type { AssistantMessage } from '../types/message/index.js'
import type { TurnConfig } from '../types/session/config.js'
import type { SessionEventListener } from '../types/session/events.js'
import type { Logger } from '../utils/logger.js'
import { AbstractAgent } from './AbstractAgent.js'
import { pickRoutedOptions } from './forward-options.js'

/** Every config field has one destination, or a deliberately explicit transform. */
const configRoutes = {
	model: 'turn',
	tokenBudget: 'turn',
	budget: 'query',
	timeoutMs: 'turn',
	streamIdleTimeoutMs: 'turn',
	maxRequestRichContentBytes: 'turn',
	attachmentResolveTimeoutMs: 'query',
	maxIterations: 'turn',
	temperature: 'turn',
	maxResponseTokens: 'turn',
	costLimitUsd: 'turn',
	permissionMode: 'turn',
	pruneKeepLast: 'turn',
	paths: 'query',
	sessionLog: 'query',
	checkpointStore: 'query',
	sandbox: 'turn',
	inboundMessages: 'query',
	projectInstructionContext: 'query',
	allowedTools: 'special',
	toolResultGuardrails: 'query',
	deniedTools: 'special',
	persona: 'query',
	logger: 'special',
	env: 'turn',
	thinking: 'turn',
	effort: 'turn',
	idempotencyKey: 'special',
	projectId: 'special',
	topicId: 'special',
	sessionId: 'special',
	tenantId: 'special',
	parentSessionId: 'query',
	parentTurnId: 'query',
	depth: 'query',
	contextLevel: 'query',
	invocationState: 'query',
	parentSpan: 'query',
	resumeHandler: 'query',
	reviewAllowedCalls: 'query',
	systemPrompt: 'query',
	webSearch: 'turn',
	steering: 'query',
	skills: 'query',
	basePrompt: 'query',
	provider: 'query',
	toolsets: 'query',
	advisory: 'query',
	authorizationGate: 'query',
	sandboxProvider: 'query',
	sandboxTeardownTimeoutMs: 'query',
	outsideRootAccess: 'query',
	sandboxEscape: 'query',
	compactionConfig: 'query',
	workingMemoryProvider: 'query',
	retry: 'query',
	toolTimeoutMs: 'query',
	toolRetryBackoff: 'query',
	maxToolConcurrency: 'query',
	maxToolOutputChars: 'query',
	retainedToolPreviewChars: 'query',
	maxToolContentBytes: 'query',
	repairToolCall: 'query',
	stopWhen: 'query',
	onStepFinish: 'query',
	prepareStep: 'query',
	beforeStep: 'query',
	structuredOutput: 'query',
	inputGuardrails: 'query',
	outputGuardrails: 'query',
} as const satisfies { readonly [K in keyof QueryAgentConfig]: 'query' | 'turn' | 'special' }

type RoutedKeys<TDestination extends 'query' | 'turn'> = {
	[K in keyof typeof configRoutes]: (typeof configRoutes)[K] extends TDestination ? K : never
}[keyof typeof configRoutes]

type QueryFields = Pick<Parameters<typeof drainQuery>[0], RoutedKeys<'query'>>
type TurnFields = Pick<TurnConfig, RoutedKeys<'turn'>>

const SCOPE_FIELDS = ['sessionId', 'topicId', 'projectId', 'tenantId'] as const

function invocationScope(input: ManagedAgentInput, config: QueryAgentConfig): AgentInvocationScope {
	if (input.managedScope !== undefined) {
		const scope = input.managedScope
		if (
			typeof scope !== 'object' ||
			scope === null ||
			Array.isArray(scope) ||
			scope.kind !== 'managed'
		) {
			throw new Error('QueryAgent requires a managed invocation scope.')
		}
		const missing = SCOPE_FIELDS.filter(
			(field) => typeof scope[field] !== 'string' || scope[field].trim().length === 0,
		)
		if (missing.length > 0) {
			throw new Error(`QueryAgent: input.managedScope is missing: ${missing.join(', ')}.`)
		}
		const conflicts = SCOPE_FIELDS.filter(
			(field) => config[field] !== undefined && config[field] !== scope[field],
		)
		if (conflicts.length > 0) {
			throw new Error(
				`QueryAgent: input.managedScope conflicts with legacy config fields: ${conflicts.join(', ')}.`,
			)
		}
		return scope
	}
	if (!config.sessionId || !config.topicId || !config.projectId || !config.tenantId) {
		throw new Error(
			'QueryAgent requires sessionId, topicId, projectId, and tenantId in input.managedScope or legacy config.',
		)
	}
	const invalid = SCOPE_FIELDS.filter((field) => {
		const value = config[field]
		return typeof value !== 'string' || value.trim().length === 0
	})
	if (invalid.length > 0) {
		throw new Error(`QueryAgent: legacy config has invalid scope fields: ${invalid.join(', ')}.`)
	}
	return {
		kind: 'managed',
		sessionId: config.sessionId,
		topicId: config.topicId,
		projectId: config.projectId,
		tenantId: config.tenantId,
	}
}

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
		input: ManagedAgentInput,
		config: QueryAgentConfig,
		listener?: SessionEventListener,
	): Promise<QueryAgentResult> {
		// Resolve before deduplication: an invalid or conflicting scope must never
		// receive another caller's in-flight result under the same raw key.
		const scope = invocationScope(input, config)
		const scopedKey = config.idempotencyKey
			? JSON.stringify([
					scope.kind,
					scope.tenantId,
					scope.projectId,
					scope.topicId,
					scope.sessionId,
					config.idempotencyKey,
				])
			: undefined
		return await this.underIdempotencyKey(scopedKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, scope, listener)),
		)
	}

	private async runExclusive(
		input: ManagedAgentInput,
		config: QueryAgentConfig,
		scope: AgentInvocationScope,
		listener?: SessionEventListener,
	): Promise<QueryAgentResult> {
		const startTime = Date.now()
		const turnId = this.createTurnId()
		this.bindTurn(scope.sessionId, turnId, config.logger)
		const queryFields: QueryFields = pickRoutedOptions(config, configRoutes, 'query')
		const turnFields: TurnFields = pickRoutedOptions(config, configRoutes, 'turn')

		const turn = await drainQuery(
			{
				...queryFields,
				...(input.attachmentStore ? { attachmentStore: input.attachmentStore } : {}),
				...(config.allowedTools ? { allowedTools: [...config.allowedTools] } : {}),
				...(config.deniedTools ? { deniedTools: [...config.deniedTools] } : {}),
				turnConfig: {
					...turnFields,
					logger: this.log,
				},
				agentId: this.metadata.id,
				agentName: this.metadata.name,
				workingDirectory: input.workingDirectory,
				sessionId: scope.sessionId,
				topicId: scope.topicId,
				projectId: scope.projectId,
				tenantId: scope.tenantId,
				turnId,
				messages: input.messages,
				signal: input.signal,
				taskStore: input.taskStore,
				runtimeToolOverrides: input.runtimeToolOverrides,
				runtimeContext: input.runtimeContext,
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
