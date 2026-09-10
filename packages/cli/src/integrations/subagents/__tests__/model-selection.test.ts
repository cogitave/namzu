import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ToolRegistry } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

describe('delegated model selection', () => {
	it('uses a separate selected provider and inherits the parent only when selection is omitted', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-delegated-model-'))
		dirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const inherited = new MockLLMProvider({ turns: [{ text: 'parent provider child' }] })
		const selected = new MockLLMProvider({ turns: [{ text: 'selected provider child' }] })
		const resolveModel = vi.fn(async () => ({
			provider: 'zen',
			model: 'chosen-model',
			effort: 'low' as const,
		}))
		const buildProvider = vi.fn((_session, selection) => (selection ? selected : inherited))
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'parent-model',
			resolveParent: parent.resolveParent,
			buildTools: () => new ToolRegistry(),
			buildProvider,
			resolveModel,
			listModels: async () => 'catalogue',
		})
		const context = {
			runId: parent.scope.runId,
			workingDirectory: cwd,
			abortSignal: new AbortController().signal,
			env: {},
			log() {},
		}
		try {
			expect(
				runtime.agentTool.inputSchema.safeParse({
					description: 'review',
					prompt: 'report',
					model: 'chosen-model',
					provider: 'zen',
					effort: 'low',
				}).success,
			).toBe(true)
			const result = await runtime.agentTool.execute(
				{
					description: 'review',
					prompt: 'report',
					model: 'chosen-model',
					provider: 'zen',
					effort: 'low',
					subagent_type: 'explore',
				},
				context,
			)
			expect(result.success).toBe(true)
			expect(buildProvider).toHaveBeenCalledWith(parent.scope.sessionId, {
				provider: 'zen',
				model: 'chosen-model',
				effort: 'low',
			})
			expect(selected.requests).toHaveLength(1)
			expect(inherited.requests).toHaveLength(0)
			expect(selected.requests[0]).toMatchObject({ model: 'chosen-model', effort: 'low' })
			expect(
				(await runtime.agentTool.execute({ description: 'inherited', prompt: 'report' }, context))
					.success,
			).toBe(true)
			expect(inherited.requests).toHaveLength(1)
			expect(inherited.requests[0]).toMatchObject({ model: 'parent-model' })
			await expect(
				runtime.agentTool.execute(
					{ description: 'invalid', prompt: 'report', provider: 'zen' },
					context,
				),
			).resolves.toMatchObject({ success: false })
			expect((await runtime.modelCatalogueTool?.execute({}, context))?.output).toBe('catalogue')
		} finally {
			await runtime.close()
		}
	})
	it('rejects unavailable selections before creating a task', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-invalid-model-'))
		dirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const buildProvider = vi.fn(() => new MockLLMProvider({ turns: [] }))
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'parent',
			resolveParent: parent.resolveParent,
			buildTools: () => new ToolRegistry(),
			buildProvider,
			resolveModel: async () => {
				throw new Error('Model unavailable')
			},
		})
		try {
			await expect(
				runtime.agentTool.execute(
					{ description: 'invalid', prompt: 'report', model: 'missing' },
					{
						runId: parent.scope.runId,
						workingDirectory: cwd,
						abortSignal: new AbortController().signal,
						env: {},
						log() {},
					},
				),
			).resolves.toMatchObject({ success: false })
			expect(buildProvider).not.toHaveBeenCalled()
			expect((await runtime.gatewayForRun(parent.scope.runId)).listTasks()).toHaveLength(0)
		} finally {
			await runtime.close()
		}
	})
})
