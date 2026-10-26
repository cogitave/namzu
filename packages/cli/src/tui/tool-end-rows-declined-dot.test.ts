import { describe, expect, it } from 'vitest'

import { theme } from './theme.js'
import { type ToolEndEvent, toolEndRows } from './tool-end-rows.js'

const base = {
	kind: 'tool-end',
	toolUseId: 'c1',
	toolName: 'bash',
	isError: true,
	summary: 'declined',
} as unknown as ToolEndEvent

describe('the dot of a call the person declined', () => {
	it('is the refused colour, the same as a call that was not run', () => {
		const declined = toolEndRows(
			{ ...base, declined: {} } as ToolEndEvent,
			{ label: 'Bash(ls)' },
			{ hasPlan: false },
		)
		if (declined.kind !== 'rows') throw new Error('expected rows')
		expect(declined.rows[0]?.glyphColor).toBe(theme.status.error)
		expect(declined.rows[1]?.content).toContain('You declined this')
	})
})
