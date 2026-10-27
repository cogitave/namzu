import { describe, expect, it } from 'vitest'

import { tokenColor } from './theme.js'
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
		expect(declined.rows[0]?.glyphColor).toBe(tokenColor('status.error'))
		expect(declined.rows[1]?.content).toContain('You declined this')
	})
})

describe('what a declined call leaves under its row', () => {
	const declinedRows = (
		toolName: string,
		proposed: NonNullable<Parameters<typeof toolEndRows>[1]>['proposed'],
	) => {
		const built = toolEndRows(
			{ ...base, toolName, declined: {} } as ToolEndEvent,
			{ label: `${toolName}(a.txt)`, proposed },
			{ hasPlan: false },
		)
		if (built.kind !== 'rows') throw new Error('expected rows')
		return built.rows
	}

	it('shows a declined write as its declined line alone, not the file it proposed', () => {
		const rows = declinedRows('write', { kind: 'write', content: 'fresh\nsecond' })
		expect(rows).toHaveLength(2)
		expect(rows[1]?.content).toBe('You declined this, so it did not run.')
		expect(rows[1]?.detail).toBeUndefined()
		expect(rows[1]?.diff).toBeUndefined()
	})

	it('still shows what a declined edit would have changed', () => {
		const rows = declinedRows('edit', { kind: 'edit', before: 'a = 1', after: 'a = 2' })
		expect(rows[1]?.diff).toBeDefined()
	})
})
