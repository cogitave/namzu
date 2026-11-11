import { describe, expect, it } from 'vitest'

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
	const failed = toolEndRows(
		end({ isError: true, summary: 'no such file', output: undefined }),
		start,
		{
			hasPlan: false,
		},
	)
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

describe('a shell command folds into the line only when it ended well', () => {
	const start = { label: 'Bash(npm test)', command: 'npm test' }
	const shell = { stdout: ['all good'], stderr: [], failed: false }
	const build = (over: Partial<ToolEndEvent>) =>
		toolEndRows(
			end({ toolName: 'bash', summary: 'all good', output: 'all good', shell, ...over }),
			start,
			{ hasPlan: false },
		)
	const row = (over: Partial<ToolEndEvent>) => {
		const built = build(over)
		return built.kind === 'rows' ? built.rows[0] : undefined
	}

	it('a command that worked is one row that is a group of that command, drawn as its own cell', () => {
		const first = row({})
		expect(first?.group?.commands).toEqual(['npm test'])
		expect(first?.content).toBe('Bash(npm test)')
		expect(first?.glyph).toBe('●')
		expect(first?.shell?.stdout).toEqual(['all good'])
		expect(first?.meta).toBeUndefined()
		// What the detailed transcript shows for it: the call, then the whole output.
		expect(first?.detail).toEqual(['Bash(npm test)', 'all good'])
	})

	it('a command whose non-zero exit is its answer worked', () => {
		expect(
			row({ shell: { stdout: [], stderr: [], failed: false, note: 'No matches found' } })?.group,
		).toBeDefined()
	})

	it('a failed command is its own red row and does not fold', () => {
		const failed = row({ shell: { ...shell, failed: true, status: 'Exit code 3' } })
		expect(failed?.group).toBeUndefined()
		expect(failed?.glyphColor).toBeDefined()
		expect(failed?.shell?.failed).toBe(true)
		// A timeout and a signal arrive as `failed` too.
		expect(
			row({ shell: { stdout: [], stderr: [], failed: true, note: 'Timed out' } })?.group,
		).toBeUndefined()
		expect(
			row({ shell: { stdout: [], stderr: [], failed: true, note: 'Stopped before it finished' } })
				?.group,
		).toBeUndefined()
	})

	it('an error result (a blocked or refused call) does not fold', () => {
		expect(row({ isError: true })?.group).toBeUndefined()
	})

	it('a command the person declined, or declined on a screen, does not fold', () => {
		expect(row({ declined: {} })?.group).toBeUndefined()
		expect(row({ cancelled: true, isError: true })?.group).toBeUndefined()
	})

	it('a command that moved to the background has not finished and does not fold', () => {
		const background = { stdout: [], stderr: [], failed: false, background: true as const }
		expect(
			row({ shell: { ...background, note: 'Running in the background (↓ to manage)' } })?.group,
		).toBeUndefined()
		expect(row({ shell: { ...background, stdout: ['partial'] } })?.group).toBeUndefined()
	})

	it('only the shell tool folds', () => {
		expect(row({ toolName: 'other_terminal' })?.group).toBeUndefined()
	})
})

it('a call to a tool that does not exist is not counted as a look and shows its error', () => {
	const built = toolEndRows(
		end({
			toolName: 'ls',
			isError: true,
			unknownTool: true,
			plainFailure: 'The model asked for a tool that does not exist (ls). It will try another way.',
			summary: 'The model asked for a tool that does not exist (ls). It will try another way.',
			output: 'Error: Unknown tool "ls". Available: bash, read',
		}),
		{ label: 'Ls(.)', fold: { kind: 'list' } },
		{ hasPlan: false },
	)
	const rows = built.kind === 'rows' ? built.rows : []
	expect(rows.some((r) => r.group !== undefined)).toBe(false)
	expect(rows[0]?.content).toBe('Ls(.)')
	// The error is on the row, not hidden: one sentence, the tool's own words behind Ctrl+O.
	expect(rows[1]?.content).toContain('does not exist (ls)')
	expect(rows[1]?.detail?.join('\n')).toContain('Unknown tool "ls"')
})
