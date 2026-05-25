/**
 * Sub-agent runtime: the model delegates work via an `Agent` tool that can
 * DEFINE a specialist on the fly — pass a `role` (the persona / system prompt)
 * and namzu spins up a fresh sub-agent with that role at runtime, no
 * pre-registered definition needed. Omit `role` for a general-purpose one.
 * The call blocks until the child finishes and its final text returns as the
 * tool result, so a delegation surfaces in the transcript as a normal
 * `⏺ Agent(...)` call.
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
	defineTool,
	mcpJsonSchemaToZod,
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
	registry.register(
		buildDefinition(
			GENERAL_PURPOSE_SUBAGENT,
			'A general-purpose sub-agent.',
			SUBAGENT_PROMPT,
			opts,
		),
	)

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

	// Dynamic `Agent` tool: the model passes an optional `role` (the persona /
	// system prompt) and we register + spawn a fresh specialist for it at call
	// time — no pre-defined agent file needed. Omit `role` → general-purpose.
	let dynCounter = 0
	const agentTool = defineTool({
		name: 'Agent',
		description:
			'Delegate a self-contained task to a sub-agent and get its result back (BLOCKING). ' +
			'Define the specialist inline with `role` — a system prompt describing who the sub-agent ' +
			'is and how to behave (e.g. "You are a security auditor; flag vulnerabilities and rate severity"). ' +
			'Omit `role` for a general-purpose sub-agent. The sub-agent runs in its own context with its own ' +
			'tools and cannot see this conversation — put everything it needs in `prompt`. Call this multiple ' +
			'times in one response to run specialists in parallel.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				description: {
					type: 'string',
					description: 'Short label for tracking (shown to the user).',
				},
				prompt: {
					type: 'string',
					description: 'Self-contained task with all the context the sub-agent needs.',
				},
				role: {
					type: 'string',
					description:
						'Optional persona / system prompt that defines this specialist sub-agent. Omit for general-purpose.',
				},
			},
			required: ['description', 'prompt'],
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute(input) {
			const { prompt, role } = input as { prompt: string; role?: string }
			let agentId = GENERAL_PURPOSE_SUBAGENT
			const persona = typeof role === 'string' ? role.trim() : ''
			const dynamic = persona.length > 0
			if (dynamic) {
				agentId = `dyn-${++dynCounter}`
				registry.register(buildDefinition(agentId, `Dynamic specialist: ${agentId}`, persona, opts))
			}
			try {
				const handle = await gateway.createTask({ agentId, prompt, workingDirectory: opts.cwd })
				const completed = await gateway.waitForTask(handle.taskId)
				const runStatus = completed.result?.status
				const succeeded =
					completed.state === 'completed' && (runStatus === undefined || runStatus === 'completed')
				const resultText =
					typeof completed.result?.result === 'string'
						? completed.result.result
						: completed.result?.result !== undefined
							? JSON.stringify(completed.result.result)
							: ''
				if (!succeeded) {
					return {
						success: false,
						output: '',
						error: `Sub-agent ${agentId} ${completed.state}: ${completed.result?.lastError ?? resultText ?? '(no detail)'}`,
					}
				}
				return { success: true, output: resultText || '(sub-agent returned no text)' }
			} finally {
				// A per-call dynamic specialist is single-use — drop its definition
				// (and retained persona string) so long sessions don't leak `dyn-N`
				// registrations whether the task succeeded, failed, or threw.
				if (dynamic) registry.unregister(agentId)
			}
		},
	})

	return { gateway, agentTool, allowedAgentIds: [GENERAL_PURPOSE_SUBAGENT] }
}

/**
 * Build an agent definition with the given id + persona (system prompt). Used
 * for the static `general-purpose` agent and for each dynamically-defined
 * specialist the model creates via the `Agent` tool's `role` argument.
 */
function buildDefinition(
	id: string,
	description: string,
	systemPrompt: string,
	opts: SubagentRuntimeOptions,
): AgentDefinition {
	const agent = new ReactiveAgent({
		id,
		name: id,
		version: '1.0.0',
		category: 'general',
		description,
	})
	// A specialist persona is layered on top of the anti-fabrication base so a
	// dynamic role can't opt out of the "don't invent results" guardrails.
	const prompt =
		systemPrompt === SUBAGENT_PROMPT ? SUBAGENT_PROMPT : `${systemPrompt}\n\n${SUBAGENT_PROMPT}`
	return {
		info: {
			id,
			name: id,
			version: '1.0.0',
			category: 'general',
			description,
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
			systemPrompt: prompt,
			...(opts.verificationGate ? { verificationGate: opts.verificationGate } : {}),
		}),
	}
}
