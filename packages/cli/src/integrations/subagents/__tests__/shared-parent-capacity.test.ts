import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	type LLMProvider,
	MockLLMProvider,
	type RunId,
	ToolRegistry,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { type SubagentParent, createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

async function setup(width: number, buildProvider?: () => LLMProvider) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-shared-delegation-'))
	directories.push(cwd)
	const fixture = await subagentParentFixture(cwd)
	const parent = await fixture.resolveParent(fixture.scope.runId)
	parent.project.config.maxDelegationWidth = width
	const firstRun = fixture.scope.runId
	const secondRun = generateRunId()
	const active = new Map<RunId, SubagentParent>([
		[firstRun, parent],
		[secondRun, parent],
	])
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		pathBuilder: new DefaultPathBuilder(join(cwd, 'state')),
		resolveParent: async (runId) => {
			const current = active.get(runId)
			if (!current) throw new Error('Parent no longer active')
			return current
		},
		buildProvider: buildProvider ?? (() => new MockLLMProvider({ turns: [{ text: 'done' }] })),
		buildTools: () => new ToolRegistry(),
	})
	const [first, second] = await Promise.all([
		runtime.gatewayForRun(firstRun),
		runtime.gatewayForRun(secondRun),
	])
	return {
		runtime,
		parent,
		active,
		firstRun,
		secondRun,
		first,
		second,
		task: { agentId: 'general-purpose', prompt: 'report the result', workingDirectory: cwd },
	}
}

describe('parallel runs share their actual parent Session capacity', () => {
	it('queues siblings across concurrent runs and reuses a released slot', async () => {
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let started = 0
		const provider = (): LLMProvider => ({
			id: 'held',
			name: 'Held',
			async *chatStream(params) {
				started++
				await held
				yield* new MockLLMProvider({ turns: [{ text: 'done' }] }).chatStream(params)
			},
		})
		const { runtime, first, second, task } = await setup(1, provider)
		try {
			const [mine, theirs] = await Promise.all([first.createTask(task), second.createTask(task)])
			await vi.waitFor(() => expect(started).toBe(1))
			expect(
				[...first.listTasks(), ...second.listTasks()].filter((task) => task.state === 'pending'),
			).toHaveLength(1)
			release()
			expect((await first.waitForTask(mine.taskId)).state).toBe('completed')
			expect((await second.waitForTask(theirs.taskId)).state).toBe('completed')
			expect(started).toBe(2)
			expect(first.getTask(mine.taskId)?.result?.result).toBe('done')
		} finally {
			release()
			await runtime.close()
		}
	})

	it('releases only one run and never lets it read, continue, or cancel another run’s child', async () => {
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const signals = new Map<string, AbortSignal>()
		const provider = (): LLMProvider => ({
			id: 'held-provider',
			name: 'Held provider',
			chatStream(params) {
				const prompt = params.messages.filter((message) => message.role === 'user').at(-1)?.content
				if (params.signal && typeof prompt === 'string') signals.set(prompt, params.signal)
				return (async function* () {
					await held
					yield* new MockLLMProvider({ turns: [{ text: 'done' }] }).chatStream(params)
				})()
			},
		})
		const { runtime, firstRun, first, second, task } = await setup(2, provider)
		try {
			const mine = await first.createTask({ ...task, prompt: 'first-owner' })
			const theirs = await second.createTask({ ...task, prompt: 'second-owner' })
			await vi.waitFor(() => expect(signals.size).toBe(2))
			expect(first.getTask(theirs.taskId)).toBeUndefined()
			await expect(first.waitForTask(theirs.taskId)).rejects.toThrow('does not belong')
			await expect(first.continueTask(theirs.taskId, 'interfere')).rejects.toThrow(
				'does not belong',
			)
			first.cancelTask(theirs.taskId)
			expect(signals.get('second-owner')?.aborted).toBe(false)
			await runtime.releaseRun(firstRun)
			expect(first.getTask(mine.taskId)?.state).toBe('canceled')
			expect(signals.get('first-owner')?.aborted).toBe(true)
			expect(signals.get('second-owner')?.aborted).toBe(false)
			await expect(first.createTask(task)).rejects.toThrow('released')
			release()
			expect((await second.waitForTask(theirs.taskId)).state).toBe('completed')
		} finally {
			release()
			await runtime.close()
		}
	})

	it('retains completed work without consuming width and refuses archived metadata', async () => {
		const { runtime, parent, first, second, task } = await setup(1)
		try {
			const firstChild = await first.createTask(task)
			await first.waitForTask(firstChild.taskId)
			const secondChild = await second.createTask(task)
			await second.waitForTask(secondChild.taskId)
			parent.project.status = 'archived'
			await expect(first.createTask(task)).rejects.toThrow(/archived|closed/i)
			parent.project.status = 'open'
			parent.topic.status = 'archived'
			await expect(first.createTask(task)).rejects.toThrow(/archived/i)
		} finally {
			await runtime.close()
		}
	})
	it('rechecks live parent metadata before a queued task starts', async () => {
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let started = 0
		const { runtime, parent, first, second, task } = await setup(1, () => ({
			id: 'held',
			name: 'Held',
			async *chatStream(params) {
				started++
				await held
				yield* new MockLLMProvider({ turns: [{ text: 'done' }] }).chatStream(params)
			},
		}))
		try {
			const firstChild = await first.createTask(task)
			await vi.waitFor(() => expect(started).toBe(1))
			const queued = await second.createTask(task)
			expect(queued.state).toBe('pending')
			parent.project.status = 'archived'
			release()
			await first.waitForTask(firstChild.taskId)
			const refused = await second.waitForTask(queued.taskId)
			expect(refused.state).toBe('failed')
			expect(refused.result?.lastError).toMatch(/archived|closed/i)
			expect(started).toBe(1)
		} finally {
			release()
			await runtime.close()
		}
	})
})
