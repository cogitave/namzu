import { describe, expect, it } from 'vitest'
import { applySnapshot } from './terminal-attach.js'

function fake(cols: number, rows: number) {
	const calls: string[] = []
	return {
		calls,
		cols,
		rows,
		reset: () => calls.push('reset'),
		resize(c: number, r: number) {
			this.cols = c
			this.rows = r
			calls.push(`resize ${c}x${r}`)
		},
		write: (d: string) => calls.push(`write@${calls.length}:${d}`),
	}
}

describe('applying a host snapshot', () => {
	it('sizes the emulator to the host screen before writing it', () => {
		const term = fake(87, 30)
		applySnapshot(term, { screen: 'S', data: 'D', cols: 120, rows: 24 })
		expect(term.calls).toEqual(['reset', 'resize 120x24', 'write@2:SD'])
	})

	it('does not resize when the sizes already agree, or when the host did not say', () => {
		const same = fake(120, 24)
		applySnapshot(same, { screen: 'S', data: '', cols: 120, rows: 24 })
		expect(same.calls).toEqual(['reset', 'write@1:S'])
		const unknown = fake(87, 30)
		applySnapshot(unknown, { screen: 'S', data: '' })
		expect(unknown.calls).toEqual(['reset', 'write@1:S'])
	})
})
