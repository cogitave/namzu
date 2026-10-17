import { describe, expect, it } from 'vitest'

import {
	type ShellOutput,
	shellCollapses,
	shellCommandFull,
	shellCommandHeader,
	shellResultRows,
	shellRunningRows,
	wrapShellLine,
} from './shell-cell.js'

const lines = (count: number, prefix = 'line') =>
	Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`)

const ok = (stdout: readonly string[], stderr: readonly string[] = []): ShellOutput => ({
	stdout,
	stderr,
	failed: false,
})

describe('the shell cell header', () => {
	it('keeps real line breaks, up to two lines', () => {
		expect(shellCommandHeader("cat <<'EOF'\nbir\niki\nEOF")).toBe("cat <<'EOF'\nbir…")
		expect(shellCommandHeader('echo a\necho b')).toBe('echo a\necho b')
	})

	it('cuts at 160 characters with a single ellipsis', () => {
		const header = shellCommandHeader('x'.repeat(300))
		expect(header).toBe(`${'x'.repeat(160)}…`)
	})

	it('does not leave half a surrogate pair at the cut', () => {
		const header = shellCommandHeader(`${'a'.repeat(159)}😀tail`)
		expect(header).toBe(`${'a'.repeat(159)}…`)
	})

	it('shows the whole command, trimmed, when expanded', () => {
		expect(shellCommandFull('  a\r\nb\nc\nd  \n')).toBe('a\nb\nc\nd')
	})
})

describe('the shell cell result rows', () => {
	const collapsed = { expanded: false } as const

	it('shows the first three lines, then a dim count with the expand hint', () => {
		expect(shellResultRows(ok(lines(40)), collapsed)).toEqual([
			{ text: 'line 1', tone: 'out' },
			{ text: 'line 2', tone: 'out' },
			{ text: 'line 3', tone: 'out' },
			{ text: '… +37 lines (ctrl+o to expand)', tone: 'dim' },
		])
	})

	it('shows a single hidden line instead of saying so', () => {
		const rows = shellResultRows(ok(lines(4)), collapsed)
		expect(rows.map((row) => row.text)).toEqual(['line 1', 'line 2', 'line 3', 'line 4'])
		expect(shellResultRows(ok(lines(5)), collapsed).at(-1)?.text).toBe(
			'… +2 lines (ctrl+o to expand)',
		)
	})

	it('puts stdout first and stderr after it in the error tone', () => {
		const rows = shellResultRows(ok(['out'], ['err']), collapsed)
		expect(rows).toEqual([
			{ text: 'out', tone: 'out' },
			{ text: 'err', tone: 'err' },
		])
	})

	it('gives a failed command ten lines and leads with its status', () => {
		const failed: ShellOutput = {
			stdout: [],
			stderr: lines(30, 'boom'),
			failed: true,
			status: 'Exit code 2',
		}
		const rows = shellResultRows(failed, collapsed)
		expect(rows[0]).toEqual({ text: 'Exit code 2', tone: 'err' })
		expect(rows.filter((row) => row.tone === 'err')).toHaveLength(11)
		expect(rows.at(-1)).toEqual({ text: '… +20 lines (ctrl+o to expand)', tone: 'dim' })
	})

	it('names an empty result, a failed empty result and a background start', () => {
		expect(shellResultRows(ok([]), collapsed)).toEqual([{ text: '(No output)', tone: 'dim' }])
		expect(
			shellResultRows({ stdout: [], stderr: [], failed: true, note: 'Exit code 3' }, collapsed),
		).toEqual([{ text: 'Exit code 3', tone: 'err' }])
		expect(
			shellResultRows(
				{ ...ok([]), note: 'Running in the background (/jobs to manage)' },
				collapsed,
			),
		).toEqual([{ text: 'Running in the background (/jobs to manage)', tone: 'dim' }])
	})

	it('counts a kernel gap line as the lines it stands for', () => {
		const stdout = ['a', 'b', 'c', 'd', '… 80 lines not shown', 'x', 'y']
		const rows = shellResultRows(ok(stdout), collapsed)
		expect(rows.at(-1)?.text).toBe('… +83 lines (ctrl+o to expand)')
	})

	it('shows every retained line when expanded, with no hint', () => {
		const rows = shellResultRows(ok(lines(40)), { expanded: true })
		expect(rows).toHaveLength(40)
		expect(rows.some((row) => row.tone === 'dim')).toBe(false)
	})

	it('counts visual lines: a long line wraps before it is elided', () => {
		const rows = shellResultRows(ok(['x'.repeat(100), 'tail']), { expanded: false, width: 20 })
		expect(rows.map((row) => row.text)).toEqual([
			'x'.repeat(20),
			'x'.repeat(20),
			'x'.repeat(20),
			'… +3 lines (ctrl+o to expand)',
		])
	})

	it('drops the hint when the row cannot be expanded', () => {
		const rows = shellResultRows(ok(lines(10)), { expanded: false, canExpand: false })
		expect(rows.at(-1)?.text).toBe('… +7 lines')
	})
})

describe('wrapShellLine', () => {
	it('keeps indentation and breaks between graphemes', () => {
		expect(wrapShellLine('    abcdef', 6)).toEqual(['    ab', 'cdef'])
		expect(wrapShellLine('short', 20)).toEqual(['short'])
	})
})

describe('when a body is worth numbering for ctrl+o', () => {
	it('is true for a folded body, a cut header and a very long line only', () => {
		expect(shellCollapses(undefined)).toBe(false)
		expect(shellCollapses(ok(lines(3)))).toBe(false)
		expect(shellCollapses(ok(lines(5)))).toBe(true)
		expect(shellCollapses({ ...ok(['a']), fullHeader: 'Bash(a\nb\nc)' })).toBe(true)
		expect(shellCollapses(ok(['y'.repeat(200)]))).toBe(true)
	})
})

describe('a running command', () => {
	it('says it is running until it prints something', () => {
		expect(shellRunningRows([], '12s')).toEqual([{ text: 'Running… (12s)', tone: 'dim' }])
		expect(shellRunningRows([], '12s', '2m')[0]?.text).toBe('Running… (12s · timeout 2m)')
	})

	it('shows the last five lines it printed, then the elapsed time', () => {
		const rows = shellRunningRows(lines(8), '3.0s')
		expect(rows.map((row) => row.text)).toEqual([
			'line 4',
			'line 5',
			'line 6',
			'line 7',
			'line 8',
			'(3.0s)',
		])
	})
})
