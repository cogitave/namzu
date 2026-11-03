import { describe, expect, it } from 'vitest'

import { createLiveModelStep } from './live-model-step.js'

// The step never reads its argument, so one empty stand-in serves every case.
const input = {} as Parameters<ReturnType<typeof createLiveModelStep>>[0]

describe('the live model step', () => {
	it('keeps the turn model while nothing was picked', async () => {
		const step = createLiveModelStep(() => undefined)
		expect(await step(input)).toBeUndefined()
	})

	it('asks for the picked model, and follows a later pick on the next request', async () => {
		let pick: string | undefined
		const step = createLiveModelStep(() => pick)
		expect(await step(input)).toBeUndefined()
		pick = 'second'
		expect(await step(input)).toEqual({ model: 'second' })
		pick = 'third'
		expect(await step(input)).toEqual({ model: 'third' })
	})
})
