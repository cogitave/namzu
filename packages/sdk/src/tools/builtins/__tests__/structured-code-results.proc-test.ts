import { describe, expect, it } from 'vitest'

import { WorkerCodeRuntime } from '../../../execution/code-runtime/worker.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { generateRunId } from '../../../utils/id.js'
import { buildRunCodeTool } from '../run-code.js'

function context(result: ToolResult, over: Partial<ToolContext> = {}): ToolContext {
	return {
		runId: generateRunId(),
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		dispatchTool: async () => result,
		...over,
	}
}

describe('structured results inside a real code worker', () => {
	it('filters data that cannot be reconstructed from the display output', async () => {
		const data = Array.from({ length: 200 }, (_, id) => ({ id, enabled: id % 97 === 0 }))
		const seen: string[] = []
		const tool = buildRunCodeTool({ toolResultMode: 'structured', timeoutMs: 5_000 })
		const result = await tool.execute(
			{
				code: 'const result = await call("rows", {}); return result.data.filter(row => row.enabled).map(row => row.id)',
				tools: ['rows'],
			},
			context(
				{ success: true, output: '200 rows', data },
				{
					dispatchTool: async (name) => {
						seen.push(name)
						return { success: true, output: '200 rows', data }
					},
				},
			),
		)
		expect(result.success).toBe(true)
		expect(result.output).toBe('[returned] [0,97,194]')
		expect(seen).toEqual(['rows'])
		expect(result.data).toMatchObject({ calls: [{ name: 'rows', ok: true }] })
		expect(tool.description).toContain('data?: JSON value')
	})

	it('keeps the default call contract as text even when data exists', async () => {
		const tool = buildRunCodeTool({ timeoutMs: 5_000 })
		const result = await tool.execute(
			{ code: 'return (await call("rows", {})).toUpperCase()', tools: ['rows'] },
			context({ success: true, output: 'display text', data: { count: 2 } }),
		)
		expect(result.output).toBe('[returned] "DISPLAY TEXT"')
		expect(tool.description).toContain('output string')
	})

	it.each([null, false, 0, '', [1, 2]])(
		'preserves a JSON value without truthiness fallback: %j',
		async (data) => {
			const tool = buildRunCodeTool({ toolResultMode: 'structured', timeoutMs: 5_000 })
			const result = await tool.execute(
				{ code: 'return await call("rows", {})', tools: ['rows'] },
				context({ success: true, output: 'summary', data }),
			)
			expect(result.output).toBe(`[returned] ${JSON.stringify({ output: 'summary', data })}`)
		},
	)

	it('makes absent data explicit through the documented optional field', async () => {
		const tool = buildRunCodeTool({ toolResultMode: 'structured', timeoutMs: 5_000 })
		const result = await tool.execute(
			{ code: 'return await call("rows", {})', tools: ['rows'] },
			context({ success: true, output: 'only text' }),
		)
		expect(result.output).toBe('[returned] {"output":"only text"}')
	})

	it('rejects a failed result instead of exposing its partial data as success', async () => {
		const tool = buildRunCodeTool({ toolResultMode: 'structured', timeoutMs: 5_000 })
		const result = await tool.execute(
			{ code: 'return await call("rows", {})', tools: ['rows'] },
			context({ success: false, output: 'partial', data: [1], error: 'access denied' }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('access denied')
	})

	it('refuses calls excluded by the turn before dispatch', async () => {
		let dispatched = false
		const tool = buildRunCodeTool({ toolResultMode: 'structured', timeoutMs: 5_000 })
		const result = await tool.execute(
			{ code: 'return await call("rows", {})', tools: ['rows'] },
			context(
				{ success: true, output: '' },
				{
					allowedTools: [],
					dispatchTool: async () => {
						dispatched = true
						return { success: true, output: '', data: [] }
					},
				},
			),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('not granted')
		expect(dispatched).toBe(false)
	})

	it('enforces the worker value limit on structured host results', async () => {
		const tool = buildRunCodeTool({
			toolResultMode: 'structured',
			runtime: new WorkerCodeRuntime({ maxValueBytes: 128 }),
			timeoutMs: 5_000,
		})
		const result = await tool.execute(
			{ code: 'return await call("rows", {})', tools: ['rows'] },
			context({ success: true, output: 'large', data: 'x'.repeat(256) }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/limit|bytes|large/i)
		expect(result.error).toContain('completed, but its result could not be delivered')
		expect(result.error).toContain('Do not repeat a state-changing call')
	})
})
