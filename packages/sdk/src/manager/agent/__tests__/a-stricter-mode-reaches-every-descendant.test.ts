import { realpathSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ReactiveAgent } from '../../../agents/ReactiveAgent.js'
import { SupervisorAgent } from '../../../agents/SupervisorAgent.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createReviewHandler } from '../../../runtime/query/review-policy.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ResumeHandler,
} from '../../../types/hitl/index.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { generateTenantId, generateTurnId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A stricter mode than the rules reaches every delegated turn, not only the
 * one the operator is watching.
 *
 * `reviewAllowedCalls` sends a batch the handler would otherwise never see —
 * one a rule allows, or one an approval from earlier in the turn covers — to
 * the handler, which is where plan mode refuses a change. A delegated child
 * borrowed its parent's handler and not this switch, so inside a child turn a
 * call covered by an approval given earlier in THAT turn skipped the handler
 * after the operator had switched to plan: the parent's next write was
 * refused and the child's ran.
 *
 * Every scenario here is the same shape: the child writes, the operator
 * approves that write for the rest of the turn and then enters plan mode, the
 * child writes again. The second write is the one plan mode must refuse.
 */

const dirs: string[] = []
beforeEach(async () => {
	const home = await mkdtemp(join(realpathSync(tmpdir()), 'namzu-stricter-mode-home-'))
	dirs.push(home)
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(async () => {
	vi.unstubAllEnvs()
	await removeTempDirs(dirs)
	dirs.length = 0
})

const WRITE = 'touch'

/** A tool that changes something, recording each path it was asked to create. */
function writeTools(written: string[]): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: WRITE,
			description: 'creates a file',
			inputSchema: z.object({ path: z.string() }),
			category: 'filesystem',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			execute: async (input) => {
				written.push(input.path)
				return { success: true, output: `created ${input.path}` }
			},
		}),
	)
	return registry
}

/** Two writes in two batches, then an answer. */
function writerProvider(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: WRITE, args: { path: 'first.txt' } }],
				finishReason: 'tool_calls',
			},
			{
				toolCalls: [{ name: WRITE, args: { path: 'second.txt' } }],
				finishReason: 'tool_calls',
			},
			{ text: 'wrote both' },
		],
	})
}

/**
 * The operator, as the CLI's live mode presents one: every review decision
 * reads the mode it is asked under. Approving the first write remembers the
 * tool for the rest of the turn (the grant), and — when `enterPlanAfterFirst`
 * — the operator then presses shift+tab into plan mode.
 */
function operator(options: { enterPlanAfterFirst: boolean }) {
	let plan = false
	const writes: HITLDecisionRequest[] = []
	const planHandler = createReviewHandler({
		mode: 'plan',
		exempt: () => false,
	})
	const handler: ResumeHandler = async (request): Promise<HITLResumeDecision> => {
		if (request.type !== 'tool_review') return { action: 'continue' }
		// A supervisor's own `create_task` is reviewed too; it is not a write.
		if (!request.toolCalls.some((tc) => tc.name === WRITE)) return { action: 'approve_tools' }
		writes.push(request)
		if (plan) return planHandler(request)
		if (options.enterPlanAfterFirst) plan = true
		return { action: 'approve_tools', remember: [WRITE] }
	}
	return {
		handler,
		writes,
		/** What the CLI passes: true only while the live mode is plan. */
		reviewAllowedCalls: vi.fn(() => plan),
	}
}

const workerInfo = {
	id: 'worker',
	name: 'worker',
	version: '1.0.0',
	category: 'general',
	description: 'writes files',
}
const leadInfo = {
	id: 'lead',
	name: 'lead',
	version: '1.0.0',
	category: 'general',
	description: 'delegates to the worker',
}

async function harness() {
	const tenantId = generateTenantId() as TenantId
	const store = new InMemorySessionStore()
	const topics = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId, name: 'p' }, tenantId)
	const topic = await topics.createTopic({ projectId: project.id, title: 't' }, tenantId)
	const actor = {
		kind: 'user',
		userId: '4a6f0f5e-2b1c-4d3e-8f9a-0b1c2d3e4f5a',
		tenantId,
	} as unknown as ActorRef
	const parent = await store.createSession(
		{ topicId: topic.id, projectId: project.id, currentActor: actor },
		tenantId,
	)
	await store.updateSession({ ...parent, status: 'active' }, tenantId)
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-stricter-mode-'))
	dirs.push(workingDirectory)

	const written: string[] = []
	const registry = new AgentRegistry()
	// The lead's builder knows nothing about `reviewAllowedCalls`, the shape
	// most hosts register: what reaches it is what the manager stamps. The
	// worker's forwards whatever it is handed, as a builder that spreads its
	// options does, so the override path is the builder's value too.
	registry.register({
		info: {
			...workerInfo,
			tools: [],
			defaults: { model: 'mock', tokenBudget: 0 },
		},
		typedAgent: new ReactiveAgent(workerInfo),
		configBuilder: (opts: Record<string, unknown>) => ({
			model: 'mock',
			tokenBudget: (opts.tokenBudget as number) ?? 0,
			timeoutMs: 20_000,
			maxIterations: 5,
			provider: writerProvider(),
			tools: writeTools(written),
			systemPrompt: 'write',
			...(opts.reviewAllowedCalls ? { reviewAllowedCalls: opts.reviewAllowedCalls } : {}),
		}),
	} as never)
	// Read when the lead is built, after the manager below exists.
	const late: { manager?: AgentManager } = {}
	registry.register({
		info: {
			...leadInfo,
			tools: [],
			defaults: { model: 'mock', tokenBudget: 0 },
		},
		typedAgent: new SupervisorAgent(leadInfo),
		configBuilder: (opts: Record<string, unknown>) => ({
			model: 'mock',
			tokenBudget: (opts.tokenBudget as number) ?? 0,
			timeoutMs: 20_000,
			maxIterations: 4,
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'c1',
								name: 'create_task',
								rawArguments: JSON.stringify({
									agent_id: 'worker',
									prompt: 'write both files',
									description: 'write',
								}),
							},
						],
					},
					{ text: 'delegated' },
				],
			}),
			agentIds: ['worker'],
			agentManager: late.manager,
			tools: new ToolRegistry(),
			systemPrompt: 'You coordinate.',
		}),
	} as never)
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => '6b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e' as never,
		}),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager: new TopicManager({
			topicStore: topics,
			sessionStore: store,
		}),
	})
	late.manager = manager

	/** Delegate `agentId` from a root turn with this context, and wait for it. */
	const delegate = async (
		agentId: 'worker' | 'lead',
		over: Partial<AgentTaskContext>,
		opts: Partial<SendMessageOptions> = {},
	) => {
		const context = {
			parentSessionId: parent.id,
			parentTurnId: generateTurnId(),
			parentAgentId: 'root',
			parentAbortController: new AbortController(),
			depth: 0,
			budget: SessionTokenBudget.create(0, {
				rootSessionId: parent.id,
				rootTurnId: generateTurnId(),
			}),
			tenantId,
			topicId: topic.id,
			sessionId: parent.id,
			projectId: project.id,
			parentActor: actor,
			...over,
		} as AgentTaskContext
		const task = await manager.sendMessage(
			{
				agentId,
				input: {
					messages: [{ role: 'user', content: 'go', timestamp: 1 }],
					workingDirectory,
				},
				parentSessionId: parent.id,
				tenantId,
				projectId: project.id,
				parentActor: actor,
				...opts,
			} as SendMessageOptions,
			context,
		)
		await manager.waitForCompletion(task.taskId)
		expect(task.result?.lastError).toBeUndefined()
		return task
	}

	return { delegate, written }
}

describe('a delegated child under a parent in a stricter mode', () => {
	it('without the switch, an approval earlier in the child turn runs its next write unasked', async () => {
		// The defect, stated as the baseline it was: plan mode is entered after
		// the first approval, and nothing tells the child's kernel to ask.
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		await h.delegate('worker', { resumeHandler: op.handler })

		expect(op.writes).toHaveLength(1)
		expect(h.written).toEqual(['first.txt', 'second.txt'])
	})

	it('routes the in-turn-approved batch to the handler, which refuses it in plan mode', async () => {
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		await h.delegate('worker', {
			resumeHandler: op.handler,
			reviewAllowedCalls: op.reviewAllowedCalls,
		})

		expect(op.writes).toHaveLength(2)
		expect(h.written).toEqual(['first.txt'])
	})

	it('reads the parent function live, so a mode entered mid-turn reaches the running child', async () => {
		// Read once per batch: false before the first write (plan not yet
		// entered), true before the second. A value sampled at spawn would be
		// false for the whole child turn and let the second write run.
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		await h.delegate('worker', {
			resumeHandler: op.handler,
			reviewAllowedCalls: op.reviewAllowedCalls,
		})

		const answers = op.reviewAllowedCalls.mock.results.map((r) => r.value)
		expect(answers[0]).toBe(false)
		expect(answers).toContain(true)
		expect(h.written).not.toContain('second.txt')
	})

	it('changes nothing while the parent answers false', async () => {
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: false })

		await h.delegate('worker', {
			resumeHandler: op.handler,
			reviewAllowedCalls: op.reviewAllowedCalls,
		})

		// The grant covers the second write, as it always has.
		expect(op.writes).toHaveLength(1)
		expect(h.written).toEqual(['first.txt', 'second.txt'])
	})
})

describe('a grandchild under a parent in a stricter mode', () => {
	it('routes its in-turn-approved batch to the handler too', async () => {
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		// root → lead (a SupervisorAgent child) → worker (the grandchild).
		await h.delegate('lead', {
			resumeHandler: op.handler,
			reviewAllowedCalls: op.reviewAllowedCalls,
		})

		expect(op.writes).toHaveLength(2)
		expect(h.written).toEqual(['first.txt'])
	})

	it('without the switch, the grandchild runs the write plan mode would refuse', async () => {
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		await h.delegate('lead', { resumeHandler: op.handler })

		expect(h.written).toEqual(['first.txt', 'second.txt'])
	})
})

describe("a child's own setting", () => {
	it('is kept: a child that asks for review gets it under a parent that set none', async () => {
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		await h.delegate(
			'worker',
			{ resumeHandler: op.handler },
			{ configOverrides: { reviewAllowedCalls: op.reviewAllowedCalls } },
		)

		expect(op.writes).toHaveLength(2)
		expect(h.written).toEqual(['first.txt'])
	})

	it('cannot shed the review its parent asked for', async () => {
		const h = await harness()
		const op = operator({ enterPlanAfterFirst: true })

		await h.delegate(
			'worker',
			{ resumeHandler: op.handler, reviewAllowedCalls: op.reviewAllowedCalls },
			{ configOverrides: { reviewAllowedCalls: () => false } },
		)

		// OR-ed, not replaced: the child's `false` does not widen what it may do.
		expect(op.writes).toHaveLength(2)
		expect(h.written).toEqual(['first.txt'])
	})
})
