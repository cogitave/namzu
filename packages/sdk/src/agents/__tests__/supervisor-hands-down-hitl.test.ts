import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { AgentTaskContext } from '../../types/agent/task.js'
import type { ResumeHandler } from '../../types/hitl/index.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * The supervisor already handed its resume handler to its OWN run and its
 * own coordinator tools. It did not hand it to the spawn context, so the
 * two disagreed: the supervisor paused for a human, and every worker it
 * launched approved itself.
 *
 * This is the link a mutation run found untested — the previous version of
 * these tests drove `AgentManager` with a context built by hand, which is
 * not the path a host takes.
 */

/** Captures the context the supervisor builds for its spawns. */
function spyManager(): {
	contexts: AgentTaskContext[]
	manager: unknown
} {
	const contexts: AgentTaskContext[] = []
	const manager = {
		sendMessage: vi.fn(async (_options: unknown, context: AgentTaskContext) => {
			contexts.push(context)
			return {
				taskId: '5f5d0823-8327-45fd-a288-bf8fd5f45f91',
				status: 'completed',
				result: {
					runId: '4721e070-5ba2-425a-bf5a-8cc927907e9a',
					status: 'completed',
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
					cost: { totalCost: 0 },
					iterations: 1,
					durationMs: 1,
					messages: [],
					result: 'worker done',
				},
			}
		}),
		await: vi.fn(async () => undefined),
		cancel: vi.fn(),
		dispose: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
	return { contexts, manager }
}

async function runSupervisor(resumeHandler?: ResumeHandler, depth?: number) {
	const { contexts, manager } = spyManager()
	const agent = new SupervisorAgent({
		id: 'supervisor',
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	})

	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'c1',
						name: 'create_task',
						rawArguments: JSON.stringify({
							agent_id: 'worker',
							prompt: 'do the thing',
							description: 'a task',
						}),
					},
				],
			},
			{ text: 'all done' },
		],
	})

	await agent
		.run(
			{
				messages: [{ role: 'user', content: 'go', timestamp: 1 }],
				workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-sup-')),
			},
			{
				provider,
				agentIds: ['worker'],
				agentManager: manager,
				tools: new ToolRegistry(),
				systemPrompt: 'You coordinate.',
				model: 'mock-model',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 4,
				sessionId: '8b71f555-ab2b-4a78-be42-3109378b5888',
				topicId: '18fd1af5-acfa-402d-b733-693691c1820e',
				projectId: 'f00d2464-af09-4609-99e5-79def1ea043d',
				tenantId: '17621f97-7a3a-4a70-b704-29f1441d224b',
				...(resumeHandler ? { resumeHandler } : {}),
				...(depth !== undefined ? { depth } : {}),
			} as never,
		)
		.catch(() => undefined)

	return contexts
}

describe('a supervisor hands its decision channel to the workers it launches', () => {
	it('puts its own handler on the spawn context', async () => {
		const handler = vi.fn(async () => ({ action: 'approve_tools' })) as unknown as ResumeHandler

		const contexts = await runSupervisor(handler)

		expect(contexts.length).toBeGreaterThan(0)
		expect(contexts[0]?.resumeHandler).toBe(handler)
	})

	it('leaves the context without one when it has none itself', async () => {
		const contexts = await runSupervisor()

		expect(contexts.length).toBeGreaterThan(0)
		// Absent still means the worker auto-approves, which is what every
		// worker did before any of this.
		expect(contexts[0]?.resumeHandler).toBeUndefined()
	})

	it('preserves its delegated depth in the context used for the next spawn', async () => {
		const handler = vi.fn(async () => ({ action: 'approve_tools' })) as unknown as ResumeHandler

		const contexts = await runSupervisor(handler, 2)

		// AgentManager increments this value when it constructs the child. If
		// the supervisor reset the context to zero, every nested supervisor
		// would create another depth-one worker and the recursion cap would
		// never observe the real ancestry.
		expect(contexts[0]?.depth).toBe(2)
	})
})
