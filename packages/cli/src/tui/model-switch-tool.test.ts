import { type ToolContext, generateRunId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { type RequestModelSwitch, buildSwitchModelTool } from './model-switch-tool.js'

function context(signal?: AbortSignal): ToolContext {
	return { runId: generateRunId(), abortSignal: signal } as ToolContext
}

describe('the interactive model-switch request tool', () => {
	it('reports pending acceptance and passes the owning run context to the host', async () => {
		const requestSwitch = vi.fn<RequestModelSwitch>(async () => ({
			kind: 'pending',
			selection: { id: 'zen', model: 'muse-spark-1.3-contributor-free' },
		}))
		const tool = buildSwitchModelTool(requestSwitch)
		const owner = context(new AbortController().signal)
		const request = { model: 'muse-spark-1.3-contributor-free', provider: 'zen' }
		const result = await tool.execute(tool.inputSchema.parse(request), owner)
		expect(requestSwitch).toHaveBeenCalledExactlyOnceWith(request, owner)
		expect(result).toMatchObject({
			success: true,
			data: { status: 'pending', provider: 'zen', model: request.model },
		})
		expect(result.output).toContain('Pending host application for this session')
		expect(result.output).not.toContain('switched')
		expect(tool.isReadOnly?.(request)).toBe(true)
		expect(tool.isConcurrencySafe?.(request)).toBe(false)
		expect(tool.presentCall?.(request)).toEqual({
			kind: 'generic',
			label: `zen/${request.model}`,
		})
		expect(tool.presentResult?.(request, result)).toMatchObject({ visibility: 'hidden' })
	})

	it('puts ambiguous provider choices in model-visible error text', async () => {
		const tool = buildSwitchModelTool(async () => ({
			kind: 'rejected',
			reason: 'Specify the provider.',
			choices: [
				{ provider: 'codex', model: 'shared-model' },
				{ provider: 'zen', model: 'shared-model' },
			],
		}))
		const result = await tool.execute({ model: 'shared-model' }, context())
		expect(result.success).toBe(false)
		expect(result.error).toContain('codex: shared-model')
		expect(result.error).toContain('zen: shared-model')
		expect(result.output).not.toContain('queued')
		expect(tool.presentResult?.({ model: 'shared-model' }, result)).toBeUndefined()
	})

	it('reports a host failure without leaking its exception or claiming acceptance', async () => {
		const tool = buildSwitchModelTool(async () => {
			throw new Error('Bearer fixture-private-token')
		})
		const result = await tool.execute({ model: 'target' }, context())
		expect(result).toMatchObject({
			success: false,
			error: 'Could not queue the model change. The active model has not changed.',
		})
		expect(JSON.stringify(result)).not.toContain('fixture-private-token')
	})

	it('withholds a cancelled request from the host callback', async () => {
		const requestSwitch = vi.fn<RequestModelSwitch>()
		const tool = buildSwitchModelTool(requestSwitch)
		const controller = new AbortController()
		controller.abort(new Error('cancelled by operator'))
		const result = await tool.execute({ model: 'target' }, context(controller.signal))
		expect(result.success).toBe(false)
		expect(requestSwitch).not.toHaveBeenCalled()
	})

	it('does not report a late acceptance after cancellation', async () => {
		const controller = new AbortController()
		const tool = buildSwitchModelTool(async () => {
			controller.abort(new Error('cancelled by operator'))
			return { kind: 'pending', selection: { id: 'openai', model: 'target' } }
		})
		const result = await tool.execute({ model: 'target' }, context(controller.signal))
		expect(result.success).toBe(false)
		expect(result.output).not.toContain('queued')
	})

	it.each([{}, { model: 2 }, { model: '' }, { model: 'target', provider: 2 }])(
		'rejects malformed request %j in the tool input schema',
		(request) => {
			const tool = buildSwitchModelTool(vi.fn<RequestModelSwitch>())
			expect(tool.inputSchema.safeParse(request).success).toBe(false)
		},
	)
})
