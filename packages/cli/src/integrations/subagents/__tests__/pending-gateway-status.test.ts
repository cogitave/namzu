import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, type ToolContext } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

it('does not wait for a different conversation whose gateway is still being admitted', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-pending-gateway-'))
	const parent = await subagentParentFixture(cwd)
	const foreign = await parent.addForeignTurn()
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let admitting!: () => void
	const entered = new Promise<void>((resolve) => {
		admitting = resolve
	})
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		buildTools: () => [],
		buildProvider: () => new MockLLMProvider(),
		resolveParent: async (turnId) => {
			if (turnId === foreign) {
				admitting()
				await held
			}
			return parent.resolveParent(turnId)
		},
	})
	const pending = runtime.gatewayForTurn(foreign)
	try {
		await entered
		const context = {
			turnId: parent.scope.turnId,
			sessionId: parent.scope.sessionId,
			workingDirectory: cwd,
			abortSignal: new AbortController().signal,
			env: {},
			log() {},
		} as ToolContext
		const result = await runtime.agentTaskListTool.execute({}, context)
		expect(JSON.parse(result.output)).toEqual({ tasks: [], total: 0, omitted: 0 })
	} finally {
		release()
		await pending
		await runtime.close()
		removeTempDir(cwd)
	}
})
