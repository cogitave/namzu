import { describe, expect, it } from 'vitest'
import type { GeneratorOutcome } from './generator-run.js'
import { describeLearned } from './learned-notice.js'

type Ran = Extract<GeneratorOutcome, { status: 'ran' }>
const ran = (status: string, description = 'Check the lockfile before retrying an install.'): Ran =>
	({
		status: 'ran',
		cycle: { status },
		proposal: { status: 'proposed', candidate: { description } },
		tokens: 1,
	}) as never

describe('the line shown after learning by itself', () => {
	it('says what was learned and how to undo it', () => {
		expect(describeLearned(ran('activated'))).toBe(
			'Namzu learned something for this folder: Check the lockfile before retrying an install. Undo with `namzu learn --undo`.',
		)
	})

	it('stays silent for a revision that was not activated', () => {
		for (const status of ['rejected', 'inconclusive', 'failed', 'cancelled'])
			expect(describeLearned(ran(status))).toBeNull()
	})

	it('stays silent when there was no proposal', () => {
		expect(describeLearned({ ...ran('activated'), proposal: null })).toBeNull()
	})

	it('keeps the line short and free of control characters', () => {
		const line = describeLearned(ran('activated', `\u001b[31mred\u001b[0m\n${'word '.repeat(60)}`))
		expect(line).not.toMatch(/\p{Cc}/u)
		expect(line?.length).toBeLessThan(200)
		expect(line).toContain('…')
	})
})
