/**
 * Sub-agent runtime: wires the SDK's native delegation so the model can spawn
 * a sub-agent via the canonical `Agent({ description, prompt, subagent_type })`
 * tool. The parent's tool call blocks until the child finishes and the child's
 * final text returns as the tool result — so a delegation surfaces in the
 * transcript as a normal `⏺ Agent(...)` call (the tree view of the child's
 * internal steps is a later layer that consumes the gateway's event stream).
 *
 * The runtime is fully self-contained: a dedicated in-memory session/thread
 * store backs the AgentManager, so sub-agent bookkeeping never touches the
 * CLI's on-disk `/resume` conversation store.
 */

import {
	type ActorRef,
	type AgentDefinition,
	AgentManager,
	AgentRegistry,
	type AgentTaskContext,
	type BaseAgentConfig,
	type BaseAgentResult,
	type Agent as CoreAgent,
	DefaultCapacityValidator,
	InMemorySessionStore,
	InMemoryThreadStore,
	type LLMProvider,
	LocalTaskGateway,
	ReactiveAgent,
	type ReactiveAgentConfig,
	type RunEvent,
	type RunId,
	SessionSummaryMaterializer,
	type SummaryId,
	type TaskGateway,
	type TenantId,
	ThreadManager,
	type ToolDefinition,
	type ToolRegistryContract,
	type UserId,
	type VerificationGateConfig,
	WorkspaceBackendRegistry,
	buildAgentTool,
} from '@namzu/sdk'

export const GENERAL_PURPOSE_SUBAGENT = 'general-purpose'

const SUBAGENT_PROMPT = [
	'You are a focused sub-agent dispatched by namzu to complete one self-contained task and report back.',
	'You cannot see the parent conversation — work only from the prompt you were given.',
	'Use your tools to actually do the work, then end with a concise summary of what you did and any results the parent needs.',
	'Be thorough but do not ask the parent questions; make reasonable assumptions and state them.',
	'',
	'Never fabricate. Only report results you actually produced via tool calls:',
	'- If you write a file, write it with the `write` tool and report the real path; never claim a file exists without writing it.',
	'- If you need to research and have no web tool available, say so plainly and answer from your own knowledge with that caveat — do not invent sources, data, or URLs.',
	'- Do not invent command output or results. If you cannot complete the task, say what blocked you.',
].join('\n')

export interface SubagentRuntimeOptions {
	readonly cwd: string
	readonly model: string
	/** Construct a fresh provider for the sub-agent (current credential). */
	readonly buildProvider: () => LLMProvider
	/** Build the sub-agent's tool registry (its own working set). */
	readonly buildTools: () => ToolRegistryContract
	readonly verificationGate?: VerificationGateConfig
	/** Receives the child's RunEvents (lineage-stamped) — for the tree view. */
	readonly onEvent?: (event: RunEvent) => void
}

export interface SubagentRuntime {
	readonly gateway: TaskGateway
	readonly agentTool: ToolDefinition
	readonly allowedAgentIds: readonly string[]
}

/**
 * Stand up the AgentManager + gateway + `Agent` tool. Returns the tool to
 * register on the parent and the gateway to pass to `query({ taskGateway })`.
 */
export async function createSubagentRuntime(
	opts: SubagentRuntimeOptions,
): Promise<SubagentRuntime> {
	const tenantId = 'tnt_namzu-cli' as TenantId
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()

	const userActor: ActorRef = { kind: 'user', userId: 'usr_namzu' as UserId, tenantId }
	const project = await store.createProject({ tenantId, name: 'namzu-cli' }, tenantId)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'namzu-cli' },
		tenantId,
	)
	const parentSession = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: userActor },
		tenantId,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, tenantId)

	let summaryCounter = 0
	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId: () => `sum_namzu_${++summaryCounter}` as SummaryId,
	})

	const registry = new AgentRegistry()
	registry.register(buildGeneralPurposeDefinition(opts))

	const threadManager = new ThreadManager({ threadStore, sessionStore: store })
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: materializer,
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager,
	})

	const taskContext: AgentTaskContext = {
		parentRunId: 'run_namzu-cli' as RunId,
		parentAgentId: 'namzu',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 1_000_000, remaining: 1_000_000 },
		tenantId,
		threadId: thread.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor: userActor,
	}

	const gateway = new LocalTaskGateway(manager, taskContext, opts.onEvent)
	const agentTool = buildAgentTool({
		gateway,
		workingDirectory: opts.cwd,
		allowedAgentIds: [GENERAL_PURPOSE_SUBAGENT],
	})

	return { gateway, agentTool, allowedAgentIds: [GENERAL_PURPOSE_SUBAGENT] }
}

function buildGeneralPurposeDefinition(opts: SubagentRuntimeOptions): AgentDefinition {
	const agent = new ReactiveAgent({
		id: GENERAL_PURPOSE_SUBAGENT,
		name: GENERAL_PURPOSE_SUBAGENT,
		version: '1.0.0',
		category: 'general',
		description:
			'A general-purpose sub-agent that completes a self-contained task and reports back.',
	})
	return {
		info: {
			id: GENERAL_PURPOSE_SUBAGENT,
			name: GENERAL_PURPOSE_SUBAGENT,
			version: '1.0.0',
			category: 'general',
			description:
				'A general-purpose sub-agent that completes a self-contained task and reports back.',
			tools: [],
			defaults: { model: opts.model, tokenBudget: 200_000 },
		},
		// ReactiveAgent is Agent<ReactiveAgentConfig,…>; the registry stores the
		// erased Agent<BaseAgentConfig,…>. configBuilder supplies the richer config.
		typedAgent: agent as unknown as CoreAgent<BaseAgentConfig, BaseAgentResult>,
		configBuilder: (options): ReactiveAgentConfig => ({
			model: options.model ?? opts.model,
			tokenBudget: options.tokenBudget ?? 200_000,
			timeoutMs: options.timeoutMs ?? 600_000,
			maxIterations: 40,
			provider: opts.buildProvider(),
			tools: opts.buildTools(),
			systemPrompt: SUBAGENT_PROMPT,
			...(opts.verificationGate ? { verificationGate: opts.verificationGate } : {}),
		}),
	}
}
