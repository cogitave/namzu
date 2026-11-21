import { describe, expect, it } from 'vitest'

import { withoutJobFooter } from '../job-result-footer.js'

describe('a background job result as the person reads it', () => {
	const FOOTER =
		'[job b3k3m1qa6 is exited with code 0; next_offset 2010; the whole output is in /tmp/x/namzu-1000/jobs/b3k3m1qa6.log]'

	it('drops the model-facing cursor line with its temp path', () => {
		expect(withoutJobFooter('job', `> tallybook test\n34 passing\n\n${FOOTER}`)).toBe(
			'> tallybook test\n34 passing',
		)
		expect(
			withoutJobFooter(
				'wait_for_job',
				'waited\n\n[next_offset 12; the whole output is in /tmp/y.log]',
			),
		).toBe('waited')
	})

	it('leaves other tools and output that only looks like it', () => {
		expect(withoutJobFooter('bash', `out\n${FOOTER}`)).toBe(`out\n${FOOTER}`)
		expect(withoutJobFooter('job', 'the [next_offset marker] is in the middle\nof it')).toBe(
			'the [next_offset marker] is in the middle\nof it',
		)
	})
})
