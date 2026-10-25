import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type ResumeHandler,
	SessionPaths,
	type ToolContext,
	type TurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'
import type { SavedAgent } from '../saved-agents.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

/** One run of the program over a shared state directory and the same conversation. */
async function runProgram(
	cwd: string,
	parent: Awaited<ReturnType<typeof subagentParentFixture>>,
	saved: (id: string) => SavedAgent | undefined,
	label: string,
) {
	const requests: ChatCompletionParams[] = []
	const handlerTurns: TurnId[] = []
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		paths: new SessionPaths({ home: join(cwd, 'state'), slug: 'restart' }),
		cwd,
		model: 'mock',
		backgroundByDefault: true,
		savedAgents: () => ({
			list: async () => ({ agents: [], omitted: 0 }),
			read: async (id) => {
				const found = saved(id)
				if (!found) throw new Error('not saved')
				return found
			},
		}),
		resolveResumeHandler: (turnId): ResumeHandler => {
			handlerTurns.push(turnId)
			return async (request) =>
				request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' }
		},
		buildTools: () => [],
		buildProvider: (): LLMProvider => ({
			id: 'child',
			name: 'child',
			async *chatStream(params) {
				requests.push(params)
				yield* new MockLLMProvider({
					turns: [{ text: `${label}_${requests.length}` }],
				}).chatStream(params)
			},
		}),
	})
	const contextFor = (turnId: TurnId): ToolContext => ({
		sessionId: parent.scope.sessionId,
		turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	})
	return { runtime, requests, handlerTurns, contextFor }
}

/** A finished agent of a program that has since exited. */
async function finishedBeforeRestart(launch: Record<string, unknown> = {}) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-restart-'))
	directories.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const before = await runProgram(cwd, parent, () => undefined, 'BEFORE')
	const receipt = await before.runtime.agentTool.execute(
		{ description: 'investigate', prompt: 'ORIGINAL_TASK', run_in_background: false, ...launch },
		before.contextFor(parent.scope.turnId),
	)
	expect(receipt.success).toBe(true)
	const task = (await before.runtime.gatewayForTurn(parent.scope.turnId)).listTasks()[0]
	if (!task?.childSessionId) throw new Error('no child launched')
	const childId = String(task.childSessionId)
	await before.runtime.releaseTurn(parent.scope.turnId)
	parent.end(parent.scope.turnId)
	await before.runtime.close()
	const record = (status: SavedAgent['status'] = 'completed'): SavedAgent => ({
		sessionId: task.childSessionId as SavedAgent['sessionId'],
		parentTurnId: String(parent.scope.turnId),
		description: 'investigate',
		status,
		spawnedAt: new Date().toISOString(),
	})
	return { cwd, parent, childId, record }
}

describe('an agent saved by an earlier run of the program', () => {
	it('is resumed from its saved history by a message, under the new turn', async () => {
		const world = await finishedBeforeRestart()
		const turn = world.parent.addTurn()
		const after = await runProgram(
			world.cwd,
			world.parent,
			(id) => (id === world.childId ? world.record() : undefined),
			'AFTER',
		)
		try {
			const sent = await after.runtime.sendMessageTool.execute(
				{ task_id: world.childId, message: 'AFTER_RESTART' },
				after.contextFor(turn),
			)
			expect(sent.error).toBeUndefined()
			expect(sent.success).toBe(true)
			expect(sent.output).toContain('Resuming agent')
			expect(sent.output).not.toMatch(/turn|authority|dyn-/i)

			// The saved id keeps naming the agent, with its newest run.
			const result = await after.runtime.waitForTaskTool.execute(
				{ task_id: world.childId },
				after.contextFor(turn),
			)
			expect(result.success).toBe(true)
			expect(result.output).toContain('AFTER_1')
			expect(after.requests).toHaveLength(1)
			const seen = JSON.stringify(after.requests[0]?.messages)
			expect(seen).toContain('ORIGINAL_TASK')
			expect(seen).toContain('AFTER_RESTART')
			// It answers to this turn's review channel; nothing of the old program remains.
			expect(after.handlerTurns).toContain(turn)
			expect(after.handlerTurns).not.toContain(world.parent.scope.turnId)

			const rail = after.runtime.activity.getSnapshot()
			expect(rail).toHaveLength(1)
			expect(rail[0]?.description).toBe('investigate')
		} finally {
			await after.runtime.close()
		}
	})

	it('says it cannot be resumed when nothing was kept to rebuild it from', async () => {
		const world = await finishedBeforeRestart({ role: 'a careful auditor' })
		const after = await runProgram(
			world.cwd,
			world.parent,
			(id) => (id === world.childId ? world.record() : undefined),
			'AFTER',
		)
		try {
			const sent = await after.runtime.sendMessageTool.execute(
				{ task_id: world.childId, message: 'NOPE' },
				after.contextFor(world.parent.addTurn()),
			)
			expect(sent.success).toBe(false)
			expect(sent.error).toContain(`Agent ${world.childId} was saved by an earlier run`)
			expect(sent.error).toContain('cannot be resumed')
			expect(sent.error).toContain('Start a new agent')
			expect(after.requests).toEqual([])
			expect(after.runtime.activity.getSnapshot()).toEqual([])
		} finally {
			await after.runtime.close()
		}
	})

	it('is resumed when the parent log never recorded its end but its own log did', async () => {
		const world = await finishedBeforeRestart()
		const after = await runProgram(
			world.cwd,
			world.parent,
			(id) => (id === world.childId ? world.record('unresolved') : undefined),
			'AFTER',
		)
		try {
			const sent = await after.runtime.sendMessageTool.execute(
				{ task_id: world.childId, message: 'AFTER_RESTART' },
				after.contextFor(world.parent.addTurn()),
			)
			expect(sent.error).toBeUndefined()
			expect(sent.success).toBe(true)
		} finally {
			await after.runtime.close()
		}
	})

	it('is not resumed when the user stopped it', async () => {
		const world = await finishedBeforeRestart()
		const after = await runProgram(
			world.cwd,
			world.parent,
			(id) => (id === world.childId ? world.record('cancelled') : undefined),
			'AFTER',
		)
		try {
			const sent = await after.runtime.sendMessageTool.execute(
				{ task_id: world.childId, message: 'RESUME_ME' },
				after.contextFor(world.parent.addTurn()),
			)
			expect(sent.success).toBe(false)
			expect(sent.error).toContain('was stopped and was not resumed')
			expect(after.requests).toEqual([])
		} finally {
			await after.runtime.close()
		}
	})

	it('is not reached from another conversation, and an id nothing saved stays unknown', async () => {
		const world = await finishedBeforeRestart()
		const after = await runProgram(
			world.cwd,
			world.parent,
			(id) => (id === world.childId ? world.record() : undefined),
			'AFTER',
		)
		try {
			const stranger = await world.parent.addForeignTurn()
			const foreign = await after.runtime.sendMessageTool.execute(
				{ task_id: world.childId, message: 'FOREIGN' },
				after.contextFor(stranger),
			)
			expect(foreign.success).toBe(false)
			expect(after.requests).toEqual([])
			const missing = await after.runtime.sendMessageTool.execute(
				{ task_id: '596ec65e-b063-401c-b1f7-a2b6cc4ce35a', message: 'X' },
				after.contextFor(world.parent.addTurn()),
			)
			expect(missing.error).toContain('No task with ID 596ec65e-b063-401c-b1f7-a2b6cc4ce35a')
		} finally {
			await after.runtime.close()
		}
	})
})

describe('the guidance for saved agents', () => {
	it('tells the model a saved agent can be continued with send_message', async () => {
		const { SAVED_AGENTS_GUIDANCE } = await import('../saved-agents.js')
		expect(SAVED_AGENTS_GUIDANCE).toContain('send_message')
		expect(SAVED_AGENTS_GUIDANCE).not.toContain('send messages to these agents')
	})
})
