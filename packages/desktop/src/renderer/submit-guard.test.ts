import { expect, it } from 'vitest'
import { palOpeningStatus } from './pals-page.js'
import { createSubmitGuard } from './submit-guard.js'

it('refuses a second submit until the first has finished, then lets one through again', async () => {
	const guard = createSubmitGuard()
	let finish: (() => void) | undefined
	let runs = 0
	const slow = () => {
		runs += 1
		return new Promise<void>((resolve) => {
			finish = resolve
		})
	}
	expect(guard.run(slow)).toBe(true)
	expect(guard.busy).toBe(true)
	expect(guard.run(slow)).toBe(false)
	expect(runs).toBe(1)
	finish?.()
	await Promise.resolve()
	await Promise.resolve()
	expect(guard.busy).toBe(false)
	expect(guard.run(async () => {})).toBe(true)
})

it('releases the guard when the action fails', async () => {
	const guard = createSubmitGuard()
	expect(guard.run(() => Promise.reject(new Error('no')))).toBe(true)
	await Promise.resolve()
	await Promise.resolve()
	expect(guard.busy).toBe(false)
})

it('says what is happening while a Pal starts, with seconds only after two', () => {
	expect(palOpeningStatus('pamir', 0)).toEqual({ text: 'Opening pamir…', stalled: false })
	expect(palOpeningStatus('pamir', 1).text).toBe('Opening pamir…')
	expect(palOpeningStatus('pamir', 3)).toEqual({ text: 'Opening pamir… 3s', stalled: false })
	expect(palOpeningStatus('pamir', 12)).toEqual({
		text: 'Still starting pamir… 12s',
		stalled: true,
	})
})
