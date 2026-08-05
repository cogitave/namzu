import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../provider/mock.js'
import { ToolNameCollisionError, ToolRegistry } from '../../registry/tool/execute.js'
import { defineTool } from '../../tools/defineTool.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * How the supervisor mounts its own coordinator tools.
 *
 * `runtimeToolOverrides` is this SDK's declared way for a host to decline a
 * kernel-mounted tool. It is honoured for the task tools and the advisory
 * tools inside `drainQuery`, and the supervisor forwards it there — but the
 * supervisor registered the coordinator tools BEFORE that call and
 * unconditionally, so `{ create_task: 'disabled' }` was obeyed everywhere
 * except the one surface a host would most want to decline.
 *
 * The second case is the collision: `ManagedRegistry` warns and overwrites, so
 * a host tool sharing a coordinator name vanished into a log line and the
 * model kept a `create_task` whose behaviour depended on registration order.
 */

const HOST_TOOL_DESCRIPTION = 'a tool this host registered deliberately'

function stubManager() {
	return {
		sendMessage: vi.fn(async () => ({ taskId: 'task_1', status: 'completed' })),
		await: vi.fn(async () => undefined),
		cancel: vi.fn(),
		dispose: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

const hostTool = (name: string) =>
	defineTool({
		name,
		description: HOST_TOOL_DESCRIPTION,
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			return { success: true as const, output: 'host tool ran' }
		},
	})

async function runWith(options: {
	hostTools?: string[]
	runtimeToolOverrides?: Record<string, 'active' | 'deferred' | 'disabled'>
	allowDelegation?: boolean
}) {
	const agent = new SupervisorAgent({
		id: 'supervisor',
		name: 'Supervisor',
		version: '1',
		category: 'test',
		description: 'coordinates workers',
	})

	const provider = new MockLLMProvider({ turns: [{ text: 'nothing to delegate' }] })

	const tools = new ToolRegistry()
	for (const name of options.hostTools ?? []) tools.register(hostTool(name))

	await agent.run(
		{
			messages: [{ role: 'user', content: 'go', timestamp: 1 }],
			workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-sup-reg-')),
			...(options.runtimeToolOverrides
				? { runtimeToolOverrides: options.runtimeToolOverrides }
				: {}),
		} as never,
		{
			provider,
			agentIds: ['worker'],
			...(options.allowDelegation !== undefined
				? { allowDelegation: options.allowDelegation }
				: {}),
			agentManager: stubManager(),
			tools,
			systemPrompt: 'You coordinate.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 2,
			sessionId: 'ses_sup',
			threadId: 'thd_sup',
			projectId: 'prj_sup',
			tenantId: 'tnt_sup',
		} as never,
	)

	const advertised = provider.requests[0]?.tools ?? []
	return {
		names: new Set(advertised.map((t) => t.function.name)),
		describedAs: (name: string) =>
			advertised.find((t) => t.function.name === name)?.function.description ?? '',
	}
}

describe('supervisor coordinator-tool registration', () => {
	it('advertises create_task by default', async () => {
		expect((await runWith({})).names).toContain('create_task')
	})

	it('does not advertise a coordinator tool the host disabled', async () => {
		const { names } = await runWith({ runtimeToolOverrides: { create_task: 'disabled' } })

		expect(names).not.toContain('create_task')
		// Declining one coordinator tool must not decline the rest.
		expect(names).toContain('agent_task_list')
	})

	it('leaves a host tool that shares no coordinator name alone', async () => {
		const { names } = await runWith({ hostTools: ['host_only'] })

		expect(names).toContain('host_only')
		expect(names).toContain('create_task')
	})

	it('refuses to take a name the host already registered', async () => {
		// Named and carrying the name, so a host can catch it narrowly rather
		// than match on message text — the shape `DuplicateProviderError`
		// already set in this repo.
		await expect(runWith({ hostTools: ['create_task'] })).rejects.toThrow(ToolNameCollisionError)
		await expect(runWith({ hostTools: ['create_task'] })).rejects.toThrow(
			/runtimeToolOverrides: \{ "create_task": "disabled" \}/,
		)
	})

	it('lets the host keep its own tool under that name by declining the coordinator one', async () => {
		const { names, describedAs } = await runWith({
			hostTools: ['create_task'],
			runtimeToolOverrides: { create_task: 'disabled' },
		})

		expect(names).toContain('create_task')
		expect(names).toContain('agent_task_list')
		// The name surviving is not the assertion — WHOSE tool holds it is.
		// Overwriting also leaves the name present, so a membership check
		// alone passes against the very behaviour this replaces.
		expect(describedAs('create_task')).toBe(HOST_TOOL_DESCRIPTION)
	})
})

/**
 * The one hop between `SupervisorAgentConfig.allowDelegation` and the builder
 * that acts on it.
 *
 * These go through `SupervisorAgent` rather than calling the builder directly,
 * and that is the entire point. The builder has its own unit tests, and they
 * pass whether or not the supervisor actually forwards the flag — measured:
 * deleting the forward left the type-check clean and all 143 coordinator and
 * agent tests green, with the field settable, documented, and read by nobody.
 * That is the shape of a declaration this repository has had to go and delete
 * before, so it gets a test that fails when the road is cut.
 */
describe('allowDelegation reaches the tool surface', () => {
	it('withholds the delegation tools when the run declines to delegate', async () => {
		const { names } = await runWith({ allowDelegation: false })

		expect(names, 'the flag never reached buildCoordinatorTools').not.toContain('create_task')
		expect(names).not.toContain('wait_for_task')
		expect(names).not.toContain('cancel_task')
	})

	it('keeps the listing, so a non-delegating run can still see what is running', async () => {
		expect((await runWith({ allowDelegation: false })).names).toContain('agent_task_list')
	})

	it('leaves an opting-in run exactly as it was', async () => {
		const { names } = await runWith({ allowDelegation: true })

		expect(names).toContain('create_task')
		expect(names).toContain('agent_task_list')
	})
})
