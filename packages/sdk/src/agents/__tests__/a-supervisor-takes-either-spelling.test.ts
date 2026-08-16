import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { stubTaskScheduler } from '../../__fixtures__/task-scheduler.js'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import type { TaskScheduler } from '../../types/agent/scheduler.js'
import { SupervisorAgent } from '../SupervisorAgent.js'

/**
 * `SupervisorAgentConfig.gateway` became `scheduler`, and for one release
 * both are live.
 *
 * The field name is what a host actually types, so retiring the type while
 * leaving the field spelled `gateway` would be exactly the half-migration
 * this wave exists to end.
 *
 * The dangerous shape is not the refusal — it is a PARTIAL read. This value
 * is consulted on more than one path, and had each site read `config.gateway`
 * directly, a host that set only `scheduler` would get a working scheduler on
 * one path and `undefined` on another. That fails silently and
 * intermittently, which is worse than never renaming the field. So the two
 * resolve once, and these drive the real `SupervisorAgent.run` rather than
 * calling the helper.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A scheduler that records whether the supervisor actually used THIS one. */
function scheduler(): TaskScheduler & { listed: number } {
	let listed = 0
	const stub = stubTaskScheduler({
		createTask: async () => ({}) as never,
		listTasks: () => {
			listed++
			return []
		},
		getTask: () => undefined,
		onTaskCompleted: () => () => {},
	}) as TaskScheduler & { listed: number }
	Object.defineProperty(stub, 'listed', { get: () => listed })
	return stub
}

async function run(fields: { gateway?: TaskScheduler; scheduler?: TaskScheduler }) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-either-spelling-'))
	dirs.push(workingDirectory)

	const agent = new SupervisorAgent({
		id: 'sup',
		name: 'Sup',
		version: '1.0.0',
		category: 'test',
		description: 'takes either spelling',
	})

	return agent.run(
		{ messages: [{ role: 'user', content: 'go', timestamp: 1 }], workingDirectory } as never,
		{
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'agent_task_list', args: {} }] }, { text: 'done' }],
			}),
			agentIds: ['worker'],
			tools: new ToolRegistry(),
			systemPrompt: 'You coordinate.',
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 20_000,
			maxIterations: 3,
			sessionId: 'ses_spell',
			topicId: 'top_spell',
			projectId: 'prj_spell',
			tenantId: 'tnt_spell',
			...fields,
		} as never,
	)
}

describe('a supervisor takes either spelling of the scheduler field', () => {
	it('refuses when both are set to different instances, naming both', async () => {
		await expect(run({ gateway: scheduler(), scheduler: scheduler() })).rejects.toThrow(
			/gateway[\s\S]*scheduler|scheduler[\s\S]*gateway/,
		)
	})

	it('accepts the same instance under both spellings', async () => {
		// One object stated twice is not a disagreement — it is what a host
		// spreading its own config into both names during a migration does.
		const shared = scheduler()

		await expect(run({ gateway: shared, scheduler: shared })).resolves.toBeDefined()
	})

	it('uses the instance passed under the OLD name', async () => {
		// Identity, through a call only THIS object can record. "Did not
		// throw" would also pass if the supervisor quietly built its own
		// scheduler and ignored the host's — which is the exact failure a
		// half-migrated read produces.
		const host = scheduler()

		await run({ gateway: host })

		expect(host.listed).toBeGreaterThan(0)
	})

	it('uses the instance passed under the new name', async () => {
		const host = scheduler()

		await run({ scheduler: host })

		expect(host.listed).toBeGreaterThan(0)
	})

	it('still refuses a config that supplies neither, naming the NEW spelling', async () => {
		// A supervisor with no scheduler and no `agentManager` has always
		// been an error, and the `pickRenamed` resolve must not turn that
		// into something quieter. What changed is the message: it used to
		// name `gateway`, teaching the field on its way out at the exact
		// moment a host is reading most carefully.
		await expect(run({})).rejects.toThrow(/'scheduler' or 'agentManager'/)
	})
})
