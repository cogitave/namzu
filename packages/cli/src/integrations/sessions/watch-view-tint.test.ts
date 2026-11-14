import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptMessage } from '../../tui/types.js'
import type { WatchSnapshot } from './session-watch.js'
import { WatchPrinter } from './watch-view.js'

afterEach(() => vi.unstubAllEnvs())

const snapshot = {
	status: { state: 'finished', sentence: 'done', outcome: 'completed' },
	changed: true,
	messages: [],
	records: [],
} as unknown as WatchSnapshot

const rows: TranscriptMessage[] = [
	{ id: 'u', role: 'user', content: 'check the release\nsecond line' },
	{ id: 'a', role: 'assistant', content: 'It looks fine.' },
]

function printed(plain: boolean): string {
	const out: string[] = []
	new WatchPrinter({ write: (t) => out.push(t), plain, columns: 80, ended: 'stay' }).update(
		snapshot,
		rows,
	)
	return out.join('')
}

describe('namzu watch draws the person’s message on the quiet tint', () => {
	it('tints each line of it, dims the pointer, and writes no blank cells', () => {
		vi.stubEnv('NO_COLOR', '')
		vi.stubEnv('CI', '')
		vi.stubEnv('FORCE_COLOR', '3')
		vi.stubEnv('TERM', 'xterm-256color')
		const text = printed(false)
		expect(text).toContain('\x1b[48;2;30;40;34m\x1b[2m›\x1b[22m check the release\x1b[49m')
		expect(text).toContain('\x1b[48;2;30;40;34m  second line\x1b[49m')
		// The reply and the blank line between carry none.
		expect(text).toContain('\n● It looks fine.') // no background before it
		expect(text.includes(' \x1b[49m')).toBe(false)
	})

	it('prints as it always did with no colour, and in plain mode', () => {
		vi.stubEnv('NO_COLOR', '1')
		expect(printed(false)).not.toContain('\x1b[48')
		vi.stubEnv('NO_COLOR', '')
		vi.stubEnv('FORCE_COLOR', '3')
		vi.stubEnv('TERM', 'xterm-256color')
		expect(printed(true)).not.toContain('\x1b[48')
	})
})
