import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type LLMProvider, MockLLMProvider, SessionPaths, type ToolContext } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})

/**
 * Four background agents launched in one message while the project allows two
 * at a time. The words of each launch report match what the task is doing when
 * the report is made: two have started, two wait for a slot.
 */
it('says queued only for the agents that are waiting, and running for those that started', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-launch-report-'))
	directories.push(cwd)
	const fixture = await subagentParentFixture(cwd)
	const parent = await fixture.resolveParent(fixture.scope.turnId)
	parent.project.config.maxDelegationWidth = 2
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
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		paths: new SessionPaths({ home: join(cwd, 'state'), slug: '-work-launch-report' }),
		resolveParent: async (turnId) => {
			if (turnId !== fixture.scope.turnId) throw new Error('Parent no longer active')
			return parent
		},
		buildProvider: provider,
		buildTools: () => [],
	})
	const context = {
		turnId: fixture.scope.turnId,
		sessionId: fixture.scope.sessionId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	} as ToolContext
	try {
		const reports = await Promise.all(
			[1, 2, 3, 4].map((n) =>
				runtime.agentTool.execute(
					{ description: `lookup ${n}`, prompt: `Look up ${n}.`, run_in_background: true },
					context,
				),
			),
		)
		const text = reports.map((report) => report.output)
		expect(text.filter((line) => line.includes('queued for an available slot'))).toHaveLength(2)
		expect(text.filter((line) => line.includes('still running'))).toHaveLength(2)
		// What was said is what happened: two requests reached the provider.
		await vi.waitFor(() => expect(started).toBe(2))
	} finally {
		release()
		await runtime.close()
	}
})
