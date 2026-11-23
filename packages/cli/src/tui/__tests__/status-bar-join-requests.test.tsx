import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar, fitStatusLine, joinRequestPill } from '../StatusBar.js'

describe('the footer mark for machines asking to join', () => {
	it('says how many wait and where to answer, once, in the plural when there are several', () => {
		expect(joinRequestPill(0)).toBeNull()
		expect(joinRequestPill(1)).toBe('1 join request · /peers')
		expect(joinRequestPill(3)).toBe('3 join requests · /peers')
		expect(joinRequestPill(120)).toBe('99+ join requests · /peers')
	})

	it('shows on the row beside the mode and clears when nobody waits', () => {
		const waiting = render(<StatusBar provider="p" model="a-model" state="idle" joinRequests={1} />)
		expect(waiting.lastFrame()).toContain('1 join request · /peers')
		waiting.unmount()
		const none = render(<StatusBar provider="p" model="a-model" state="idle" joinRequests={0} />)
		expect(none.lastFrame()).not.toContain('join request')
		none.unmount()
	})

	it('goes after the other items on a narrow row, never half of it', () => {
		const input = {
			provider: null,
			model: null,
			modeLabel: '⏵⏵ bypass permissions on',
			joins: '1 join request · /peers',
			shells: '2 shells',
			effort: 'high',
		}
		const wide = fitStatusLine({ columns: 120, ...input })
		expect(wide.joins).toBe('1 join request · /peers')
		// Wherever the row is narrow, the mark outlasts the shell pill and the effort; only the mode outlasts it.
		for (let columns = 20; columns <= 120; columns++) {
			const row = fitStatusLine({ columns, ...input })
			if (row.shells || row.effort) expect(row.joins, `${columns} columns`).not.toBeNull()
			if (row.joins) expect(row.joins).toBe('1 join request · /peers')
		}
	})
})
