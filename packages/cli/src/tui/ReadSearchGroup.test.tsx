import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ReadSearchGroup } from './ReadSearchGroup.js'
import { EMPTY_GROUP, foldOp } from './read-search-group.js'
import type { TranscriptMessage } from './types.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function row(group: TranscriptMessage['group'], pending: boolean): TranscriptMessage {
	return { id: 'g', role: 'tool', content: '', pending, group }
}

it('a live line carries the expand hint', () => {
	const group = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"a"' })
	const harness = render(<ReadSearchGroup message={row(group, true)} />)
	expect(harness.lastFrame()).toContain('Searching for 1 pattern… (ctrl+o to expand)')
	harness.unmount()
})

it('shows the newest item as soon as it starts, and holds still until another starts', async () => {
	let group = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"first"' })
	group = foldOp(group, { kind: 'search', hint: '"second"' })
	const harness = render(<ReadSearchGroup message={row(group, true)} />)
	expect(harness.lastFrame()).toContain('"second"')
	expect(harness.lastFrame()).not.toContain('"first"')
	// Time alone never changes the line.
	await vi.advanceTimersByTimeAsync(5000)
	expect(harness.lastFrame()).toContain('"second"')
	expect(harness.lastFrame()).not.toContain('"first"')
	harness.unmount()
})

it('wraps a long hint under the line instead of cutting it at the terminal width', () => {
	const words = Array.from({ length: 45 }, (_, i) => `w${i}`).join(' ')
	const group = foldOp(EMPTY_GROUP, { kind: 'search', hint: `"${words}"` })
	const harness = render(<ReadSearchGroup message={row(group, true)} />)
	const frame = harness.lastFrame() ?? ''
	// The default test terminal is 100 columns: the hint is longer, and all of it is still there.
	expect(frame).toContain('w0 ')
	expect(frame).toContain('w44')
	expect(frame.split('\n').slice(1).join('\n')).not.toContain('…')
	harness.unmount()
})

it('cuts a hint at 300 characters with an ellipsis', () => {
	const group = foldOp(EMPTY_GROUP, { kind: 'search', hint: `"${'x'.repeat(400)}"` })
	const harness = render(<ReadSearchGroup message={row(group, true)} />)
	const shown = (harness.lastFrame() ?? '').replace(/\s+/g, '')
	expect(shown).toContain(`${'x'.repeat(299 - 1)}…`)
	expect(shown).not.toContain('x'.repeat(300))
	harness.unmount()
})

it('does not point at the detailed transcript from inside it', () => {
	const group = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"a"' })
	const harness = render(
		<ReadSearchGroup message={{ ...row(group, true), detailExpanded: true }} />,
	)
	expect(harness.lastFrame()).not.toContain('ctrl+o')
	harness.unmount()
})

function ran(count: number, extra: Parameters<typeof foldOp>[1][] = []) {
	let group = EMPTY_GROUP
	for (const op of extra) group = foldOp(group, op)
	for (let i = 1; i <= count; i += 1) group = foldOp(group, { kind: 'run', command: `step ${i}` })
	return group
}

it('lists the commands it ran under the line, one per row, and no hint when it is settled', () => {
	const harness = render(
		<ReadSearchGroup message={{ ...row(ran(3), false), meta: '(ctrl+o to expand)' }} />,
	)
	const lines = (harness.lastFrame() ?? '').split('\n').map((line) => line.trimEnd())
	expect(lines[0]).toContain('Ran 3 commands (ctrl+o to expand)')
	expect(lines.slice(1)).toEqual(['  ⎿  $ step 1', '     $ step 2', '     $ step 3'])
	harness.unmount()
})

it('says how many earlier commands are not listed, above the last five', () => {
	const harness = render(<ReadSearchGroup message={{ ...row(ran(8), true) }} />)
	const lines = (harness.lastFrame() ?? '').split('\n').map((line) => line.trimEnd())
	expect(lines[0]).toContain('Running 8 commands…')
	expect(lines.slice(1)).toEqual([
		'  ⎿  3 earlier commands not listed',
		'     $ step 4',
		'     $ step 5',
		'     $ step 6',
		'     $ step 7',
		'     $ step 8',
	])
	harness.unmount()
})

it('puts the newest target of a live look under the commands, and the commands stay on one row each', () => {
	const group = foldOp(ran(1, [{ kind: 'read', key: 'a.ts' }]), {
		kind: 'read',
		key: 'b.ts',
		hint: 'b.ts',
	})
	const long = foldOp(group, { kind: 'run', command: `echo ${'y'.repeat(300)}` })
	const harness = render(<ReadSearchGroup message={row(long, true)} />)
	const lines = (harness.lastFrame() ?? '').split('\n').map((line) => line.trimEnd())
	expect(lines[1]).toBe('  ⎿  $ step 1')
	// Cut to the width with an ellipsis, never wrapped.
	expect(lines[2]).toMatch(/^ {5}\$ echo y+…$/)
	expect(lines[2]?.length).toBeLessThanOrEqual(100)
	expect(lines[3]).toBe('     b.ts')
	expect(lines).toHaveLength(4)
	harness.unmount()
})

it('lists nothing on the detailed transcript screen, which shows each command whole', () => {
	const harness = render(
		<ReadSearchGroup message={{ ...row(ran(2), false), detailExpanded: true }} />,
	)
	expect(harness.lastFrame()).not.toContain('$ step')
	harness.unmount()
})
