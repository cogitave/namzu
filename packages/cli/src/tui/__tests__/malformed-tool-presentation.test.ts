import {
	BashTool,
	EditTool,
	ReadFileTool,
	type SessionEvent,
	type ToolCallView,
	WriteFileTool,
	toAcpSessionUpdate,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { testToolManager } from '../../test-support/toolset.js'
import { toAgentEvent, viewToLines, viewToSummary } from '../agent.js'
import { createCliToolPresenter } from '../tool-presentation.js'

describe('refused tool input stays presentable', () => {
	it.each([WriteFileTool, ReadFileTool, EditTool, BashTool])(
		'keeps malformed $name input out of rendering failures',
		(tool) => {
			const presenter = createCliToolPresenter(testToolManager(tool))
			for (const input of [{}, null, { content: 'private unreadable file body', path: 42 }]) {
				const event = {
					type: 'tool_executing',
					toolName: tool.name,
					toolUseId: 'refused-call',
					input,
				} as unknown as SessionEvent
				const tui = toAgentEvent(event, presenter)
				expect(tui?.kind).toBe('tool-start')
				const wire = toAcpSessionUpdate(event, presenter)
				expect(wire?.kind).toBe('tool_call')
			}
		},
	)

	it('uses the tool name for an unreadable write and retains its repair guidance', () => {
		const presenter = createCliToolPresenter(testToolManager(WriteFileTool))
		const view = presenter.presentCall('write', { content: 'private unreadable file body' })
		expect(view).toEqual({ kind: 'generic', label: 'write' })
		expect(viewToSummary(view)).toBe('write')
		const result = toAgentEvent(
			{
				type: 'tool_completed',
				toolName: 'write',
				toolUseId: 'refused-call',
				isError: true,
				result: 'Unreadable arguments. Keep each content string below 12000 characters.',
			} as unknown as SessionEvent,
			presenter,
		)
		expect(result).toMatchObject({
			kind: 'tool-end',
			isError: true,
			output: 'Unreadable arguments. Keep each content string below 12000 characters.',
		})
	})

	it.each([
		{ kind: 'generic', label: undefined },
		{ kind: 'diff', before: undefined, after: 'new text' },
		{ kind: 'terminal', output: undefined },
	])('falls back from a malformed $kind result without losing the tool error', (invalid) => {
		const presenter = createCliToolPresenter({
			get: () => ({
				...WriteFileTool,
				presentResult: () => invalid as unknown as ToolCallView,
			}),
		})
		const view = presenter.presentResult(
			'write',
			{},
			{
				success: false,
				output: '',
				error: 'Repair the arguments and retry.',
			},
		)
		expect(view).toEqual({ kind: 'terminal', output: 'Repair the arguments and retry.' })
		expect(viewToSummary(view)).toBe('Repair the arguments and retry.')
		expect(viewToLines(view)).toBeUndefined()
	})

	it.each<ToolCallView>([
		{
			kind: 'generic',
			label: 'Read the document',
			presentation: 'activity',
			activity: 'exploration',
		},
		{ kind: 'diff', path: 'file.md', label: 'Updated file.md', before: 'before', after: 'after' },
		{ kind: 'terminal', command: 'pwd', output: '/workspace' },
	])('preserves an admitted $kind view', (view) => {
		const presenter = createCliToolPresenter({
			get: () => ({ ...WriteFileTool, presentCall: () => view, presentResult: () => view }),
		})
		expect(presenter.presentCall('write', {})).toBe(view)
		expect(presenter.presentResult('write', {}, { success: true, output: 'done' })).toBe(view)
	})
})
