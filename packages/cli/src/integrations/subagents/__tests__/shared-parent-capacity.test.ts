import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DefaultPathBuilder,
	DelegationCapacityExceeded,
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
	it('admits only one sibling across two concurrent runs when Session width is one', async () => {
		const { runtime, first, second, task } = await setup(1)
		try {
			const results = await Promise.allSettled([first.createTask(task), second.createTask(task)])
			const admitted = results.filter((result) => result.status === 'fulfilled')
			const refused = results.filter((result) => result.status === 'rejected')
			expect(admitted).toHaveLength(1)
			expect(refused).toHaveLength(1)
			expect(refused[0]?.reason).toBeInstanceOf(DelegationCapacityExceeded)
			expect(refused[0]?.reason.details.dimension).toBe('width')
			const owner = first.listTasks().length ? first : second
			const handle = owner.listTasks()[0]
			if (!handle) throw new Error('The admitted child disappeared')
			expect((await owner.waitForTask(handle.taskId)).state).toBe('completed')
		} finally {
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

	it('refreshes real limits and refuses archived metadata through an already acquired gateway', async () => {
		const { runtime, parent, first, second, task } = await setup(1)
		try {
			const firstChild = await first.createTask(task)
			await first.waitForTask(firstChild.taskId)
			await expect(second.createTask(task)).rejects.toBeInstanceOf(DelegationCapacityExceeded)
			parent.project.config.maxDelegationWidth = 2
			parent.project.updatedAt = new Date(parent.project.updatedAt.getTime() + 1)
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
})
