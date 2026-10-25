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
	const group = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"a"' }, 0)
	const harness = render(<ReadSearchGroup message={row(group, true)} now={() => 0} />)
	expect(harness.lastFrame()).toContain('Searching for 1 pattern… (ctrl+o to expand)')
	harness.unmount()
})

it('a held hint appears once its interval passes, with nothing else re-rendering', async () => {
	let clock = 0
	let group = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"first"' }, 0)
	clock = 100
	group = foldOp(group, { kind: 'search', hint: '"second"' }, clock)
	const harness = render(<ReadSearchGroup message={row(group, true)} now={() => clock} />)
	expect(harness.lastFrame()).toContain('"first"')
	expect(harness.lastFrame()).not.toContain('"second"')
	clock = 700
	await vi.advanceTimersByTimeAsync(600)
	await vi.advanceTimersByTimeAsync(100)
	expect(harness.lastFrame()).toContain('"second"')
	harness.unmount()
})
