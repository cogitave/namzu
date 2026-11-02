import { describe, expect, it } from 'vitest'

import { formatSystemEvent } from '../../system-events.js'
import { formatMonitorEnd, formatMonitorEvent } from '../steering.js'

const AT = Date.UTC(2026, 10, 2, 9, 30, 15)
const fixedNonce = () => 'abcdef0123456789'

describe('system-event frames carry the time they describe', () => {
	it('puts the time of a monitor event in the opening tag', () => {
		const frame = formatMonitorEvent(
			{ jobId: 'b00000001', description: 'build', kind: 'output', text: 'done', at: AT },
			'make',
		)
		expect(frame.split('\n')[0]).toMatch(
			/^<system-event-[0-9a-f]+ kind="job" id="b00000001" status="interim" at="2026-11-02T09:30:15\.000Z">$/,
		)
	})

	it('puts the end time of a monitor in the opening tag', () => {
		const frame = formatMonitorEnd(
			{
				id: 'b00000002',
				command: 'tail -f log',
				description: 'log',
				status: 'exited',
				exitCode: 0,
				exitedAt: AT,
			},
			{ stdoutChars: 10 },
		)
		expect(frame.split('\n')[0]).toContain('at="2026-11-02T09:30:15.000Z"')
	})

	it('leaves the tag as it was when no time is given', () => {
		const frame = formatSystemEvent(
			{ kind: 'job', id: 'x', status: 'interim', summary: 's', source: 'src' },
			{ generateNonce: fixedNonce },
		)
		expect(frame.split('\n')[0]).toBe(
			'<system-event-abcdef0123456789 kind="job" id="x" status="interim">',
		)
	})
})
