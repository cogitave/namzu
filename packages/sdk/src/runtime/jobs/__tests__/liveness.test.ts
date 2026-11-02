import { describe, expect, it } from 'vitest'

import {
	LIVENESS_QUIET_MS,
	LIVENESS_STALLED_MS,
	type LivenessInput,
	formatLivenessAge,
	formatLivenessLine,
	judgeLiveness,
} from '../liveness.js'

const T0 = 1_000_000
const base: LivenessInput = {
	kind: 'job',
	id: 'b1',
	label: 'npm test',
	startedAt: T0,
	alive: true,
}

describe('judgeLiveness', () => {
	const table: ReadonlyArray<{
		name: string
		input: Partial<LivenessInput>
		at: number
		verdict: string
		idle: number
	}> = [
		{
			name: 'fresh output',
			input: { lastProgressAt: T0 + 50_000 },
			at: T0 + 60_000,
			verdict: 'progressing',
			idle: 10,
		},
		{
			name: 'no output yet, just started',
			input: {},
			at: T0 + 5_000,
			verdict: 'progressing',
			idle: 5,
		},
		{
			name: 'quiet but under the stall bound',
			input: { lastProgressAt: T0 },
			at: T0 + LIVENESS_QUIET_MS,
			verdict: 'waiting',
			idle: 30,
		},
		{
			name: 'silent past the idle default',
			input: { lastProgressAt: T0 },
			at: T0 + LIVENESS_STALLED_MS,
			verdict: 'stalled',
			idle: 120,
		},
		{
			name: 'known reason keeps it waiting however long',
			input: { lastProgressAt: T0, waitingOn: 'a free slot' },
			at: T0 + 10 * LIVENESS_STALLED_MS,
			verdict: 'waiting',
			idle: 1200,
		},
		{
			name: 'gone without a result',
			input: { alive: false },
			at: T0 + 9_000,
			verdict: 'dead',
			idle: 9,
		},
		{
			name: 'a result beats a failed probe',
			input: { alive: false, finished: true },
			at: T0 + 9_000,
			verdict: 'finished',
			idle: 9,
		},
	]
	for (const row of table) {
		it(row.name, () => {
			const out = judgeLiveness({ ...base, ...row.input }, row.at)
			expect(out.verdict).toBe(row.verdict)
			expect(out.idleSeconds).toBe(row.idle)
		})
	}

	it('measures a wait from when it began waiting', () => {
		const out = judgeLiveness(
			{ ...base, lastProgressAt: T0, waitingOn: 'the bash tool', waitingSince: T0 + 20_000 },
			T0 + 80_000,
		)
		expect(out.waitingSeconds).toBe(60)
		expect(out.waitingOn).toBe('the bash tool')
	})

	it('honours thresholds the caller sets', () => {
		const out = judgeLiveness({ ...base, lastProgressAt: T0 }, T0 + 5_000, {
			quietMs: 1_000,
			stalledMs: 4_000,
		})
		expect(out.verdict).toBe('stalled')
	})
})

describe('formatLivenessLine', () => {
	it('prints age, verdict and where for each verdict', () => {
		const line = (input: Partial<LivenessInput>, at: number) =>
			formatLivenessLine(judgeLiveness({ ...base, ...input }, at))
		expect(line({ lastProgressAt: T0 + 56_000, where: 'compiling' }, T0 + 60_000)).toBe(
			'job b1 "npm test" - progressing - last progress 4s ago - at: compiling',
		)
		expect(line({ lastProgressAt: T0 }, T0 + 200_000)).toBe(
			'job b1 "npm test" - stalled - last progress 3m 20s ago',
		)
		expect(line({ waitingOn: 'a free slot', lastProgressAt: T0 }, T0 + 45_000)).toBe(
			'job b1 "npm test" - waiting on a free slot for 45s',
		)
		expect(line({ alive: false, lastProgressAt: T0 + 1_000 }, T0 + 9_000)).toBe(
			'job b1 "npm test" - dead: gone without a result after 9s, last progress 8s ago',
		)
		expect(line({ finished: true }, T0 + 9_000)).toBe('job b1 "npm test" - finished after 9s')
	})

	it('flattens and clips free text', () => {
		const out = formatLivenessLine(
			judgeLiveness({ ...base, label: `a\nb${'x'.repeat(200)}`, where: 'l1\n\nl2' }, T0),
		)
		expect(out).not.toContain('\n')
		expect(out).toContain('at: l1 l2')
		expect(out.length).toBeLessThan(300)
	})
})

describe('formatLivenessAge', () => {
	it('is short at every scale', () => {
		expect(formatLivenessAge(0)).toBe('0s')
		expect(formatLivenessAge(59)).toBe('59s')
		expect(formatLivenessAge(65)).toBe('1m 05s')
		expect(formatLivenessAge(3720)).toBe('1h 02m')
	})
})
