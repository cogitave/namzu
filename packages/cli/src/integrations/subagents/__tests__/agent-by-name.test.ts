import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, type ToolContext } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { agentNameProblem, normalizeAgentName } from '../agent-names.js'
import { createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

async function world() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-agent-name-'))
	directories.push(cwd)
	const parent = await subagentParentFixture(cwd)
	let requests = 0
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd,
		model: 'mock',
		buildTools: () => [],
		buildProvider: () => ({
			id: 'child',
			name: 'child',
			async *chatStream(params) {
				requests += 1
				yield* new MockLLMProvider({ turns: [{ text: `RESULT_${requests}` }] }).chatStream(params)
			},
		}),
	})
	const context: ToolContext = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	const launch = async (name: string | undefined, prompt = 'DO_IT') =>
		runtime.agentTool.execute(
			{ description: 'look', prompt, run_in_background: false, ...(name ? { name } : {}) },
			context,
		)
	return { runtime, context, launch }
}

describe('a name given to Agent', () => {
	it('addresses the agent in wait_for_task and cancel_agent, and shows in the listing', async () => {
		const w = await world()
		try {
			const receipt = await w.launch('Reviewer')
			expect(receipt.success).toBe(true)
			const listed = JSON.parse((await w.runtime.agentTaskListTool.execute({}, w.context)).output)
			const entry = listed.tasks[0]
			expect(entry.name).toBe('Reviewer')

			const waited = await w.runtime.waitForTaskTool.execute({ task_id: 'reviewer' }, w.context)
			expect(waited.success).toBe(true)
			expect(waited.output).toContain(`task_id: ${entry.task_id}`)
			expect(waited.output).toContain('RESULT_1')

			const cancelled = await w.runtime.cancelAgentTool.execute({ task_id: 'Reviewer' }, w.context)
			expect(cancelled.output).toBe(
				`Task ${entry.task_id} already ended: completed. No cancellation sent.`,
			)
		} finally {
			await w.runtime.close()
		}
	})

	it('hands the name to the later agent that takes it', async () => {
		const w = await world()
		try {
			await w.launch('worker')
			await w.launch('worker')
			const listed = JSON.parse((await w.runtime.agentTaskListTool.execute({}, w.context)).output)
			const named = listed.tasks.filter((task: { name?: string }) => task.name === 'worker')
			expect(named).toHaveLength(1)
			const waited = await w.runtime.waitForTaskTool.execute({ task_id: 'worker' }, w.context)
			expect(waited.output).toContain(`task_id: ${named[0].task_id}`)
		} finally {
			await w.runtime.close()
		}
	})

	it('refuses a name that cannot address an agent, and starts nothing', async () => {
		const w = await world()
		try {
			for (const bad of ['main', 'USER', 'system', '-dash', 'has space', 'a'.repeat(65)]) {
				expect((await w.launch(bad)).success).toBe(false)
			}
			expect((await w.launch('596ec65e-b063-401c-b1f7-a2b6cc4ce35a')).error).toMatch(/look like/)
			const listed = JSON.parse((await w.runtime.agentTaskListTool.execute({}, w.context)).output)
			expect(listed.tasks).toEqual([])
		} finally {
			await w.runtime.close()
		}
	})

	it('answers a name nobody has as an unknown task', async () => {
		const w = await world()
		try {
			const result = await w.runtime.sendMessageTool.execute(
				{ task_id: 'nobody', message: 'hello' },
				w.context,
			)
			expect(result.success).toBe(false)
			expect(result.error).toContain('No task with ID nobody')
		} finally {
			await w.runtime.close()
		}
	})
})

it('keeps the same agent name independently addressable in two conversations', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-agent-name-scope-'))
	directories.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const foreignTurn = await parent.addForeignTurn()
	const foreign = await parent.resolveParent(foreignTurn)
	let requests = 0
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		buildProvider: () => ({
			id: 'child',
			name: 'child',
			async *chatStream(params) {
				yield* new MockLLMProvider({ turns: [{ text: `RESULT_${++requests}` }] }).chatStream(params)
			},
		}),
	})
	const first: ToolContext = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	}
	const second: ToolContext = { ...first, sessionId: foreign.sessionId, turnId: foreignTurn }
	try {
		for (const context of [first, second]) {
			const result = await runtime.agentTool.execute(
				{ name: 'reviewer', description: 'look', prompt: 'answer', run_in_background: false },
				context,
			)
			expect(result.success, result.error).toBe(true)
		}
		for (const [context, expected] of [
			[first, 'RESULT_1'],
			[second, 'RESULT_2'],
		] as const) {
			const waited = await runtime.waitForTaskTool.execute({ task_id: 'REVIEWER' }, context)
			expect(waited.success, waited.error).toBe(true)
			expect(waited.output).toContain(expected)
			const cancelled = await runtime.cancelAgentTool.execute({ task_id: 'reviewer' }, context)
			expect(cancelled.output).toContain('already ended: completed')
		}
	} finally {
		await runtime.close()
	}
})
describe('agent names', () => {
	it('fold width, case and spaces the same way when matching', () => {
		expect(normalizeAgentName('  Ｒeview Bot ')).toBe('review-bot')
		expect(agentNameProblem('review_bot-2')).toBeUndefined()
		expect(agentNameProblem('Team-Lead')).toMatch(/reserved/)
	})
})
