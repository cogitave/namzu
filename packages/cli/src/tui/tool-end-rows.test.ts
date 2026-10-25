import { expect, it } from 'vitest'

import { type ToolEndEvent, toolEndRows, withoutErrorName } from './tool-end-rows.js'

it('drops the interpreter error name in front of a failure sentence, once or doubled', () => {
	expect(withoutErrorName('Error: The script stopped at line 3, column 20: it broke')).toBe(
		'The script stopped at line 3, column 20: it broke',
	)
	expect(withoutErrorName('Error: TypeError: cannot read property of undefined')).toBe(
		'cannot read property of undefined',
	)
	expect(withoutErrorName('No error name here: just text')).toBe('No error name here: just text')
	expect(withoutErrorName('Errors are not names')).toBe('Errors are not names')
})

const end = (over: Partial<ToolEndEvent>): ToolEndEvent =>
	({
		kind: 'tool-end',
		toolUseId: 'c1',
		toolName: 'read',
		isError: false,
		summary: 'Read a.ts',
		output: 'one\ntwo',
		...over,
	}) as ToolEndEvent

it('a successful look is one settled counted line that keeps its call and output behind expansion', () => {
	const built = toolEndRows(
		end({ headline: 'Read a.ts' }),
		{ label: 'Read(a.ts)', activity: 'exploration', fold: { kind: 'read', key: 'a.ts' } },
		{ hasPlan: false },
	)
	expect(built.kind).toBe('rows')
	const row = built.kind === 'rows' ? built.rows[0] : undefined
	expect(row?.content).toBe('Read 1 file')
	expect(row?.detail).toEqual(['Read a.ts', 'one', 'two'])
	expect(row?.meta).toBe('(ctrl+o to expand)')
	expect(row?.group?.readKeys).toEqual(['a.ts'])
})

it('a shell look and a connector call fold the same way, under their own headline', () => {
	const shell = toolEndRows(
		end({ toolName: 'bash', output: 'x' }),
		{ label: 'Bash(rg x)', fold: { kind: 'search' } },
		{ hasPlan: false },
	)
	expect(shell.kind === 'rows' ? shell.rows[0]?.content : '').toBe('Searched for 1 pattern')
	const mcp = toolEndRows(
		end({ toolName: 'mcp__docs__search', output: 'y' }),
		{ label: 'Mcp docs search', fold: { kind: 'mcp', label: 'docs' } },
		{ hasPlan: false },
	)
	expect(mcp.kind === 'rows' ? mcp.rows[0]?.content : '').toBe('Called docs')
})

it('a failed look stays in its counted line, with its error behind the detailed transcript', () => {
	const start = { label: 'Read(a.ts)', fold: { kind: 'read', key: 'a.ts' } } as const
	const failed = toolEndRows(end({ isError: true, summary: 'no such file', output: undefined }), start, {
		hasPlan: false,
	})
	expect(failed.kind).toBe('rows')
	const row = failed.kind === 'rows' ? failed.rows[0] : undefined
	// Counted like a look that worked, with no error text on the line itself.
	expect(row?.content).toBe('Read 1 file')
	expect(row?.group?.readKeys).toEqual(['a.ts'])
	expect(row?.meta).toBe('(ctrl+o to expand)')
	expect(row?.detail).toEqual(['Read(a.ts)', 'Error: no such file'])
})

it('a refused look is still a row of its own', () => {
	const start = { label: 'Read(a.ts)', fold: { kind: 'read', key: 'a.ts' } } as const
	const refused = toolEndRows(
		end({ isError: true, summary: 'no', declined: { note: 'No' } } as never),
		start,
		{ hasPlan: false },
	)
	expect(refused.kind === 'rows' ? refused.rows.some((row) => row.group) : true).toBe(false)
})
