import { expect, it } from 'vitest'
import { ComputerInputRetiredError, computerSurfaceOwnsFocus } from './computer-input-focus.js'
import { ComputerInputQueue, computerInputOwnerMatches } from './computer-input-queue.js'

it('admits input only while the live surface owns focus', () => {
	const surface = {
		closest: (selector: string) => (selector === '.pal-computer-screen' ? {} : null),
	}
	const chat = { closest: () => null }
	expect(computerSurfaceOwnsFocus(surface)).toBe(true)
	expect(computerSurfaceOwnsFocus(chat)).toBe(false)
	expect(computerSurfaceOwnsFocus(null)).toBe(false)
})

it('retires queued input after host focus, even when focus returns before an in-flight reply', async () => {
	let release = () => {}
	let started = () => {}
	const flight = new Promise<void>((resolve) => {
		release = resolve
	})
	const firstStarted = new Promise<void>((resolve) => {
		started = resolve
	})
	const owner = { id: 'pal', generation: 'guest', navigation: 1, viewEpoch: 1 }
	let current = { ...owner }
	const forwarded: string[] = []
	const queue = new ComputerInputQueue(async (action, captured) => {
		if (!computerInputOwnerMatches(captured, current)) throw new ComputerInputRetiredError()
		if (action.type !== 'type_text') throw new Error('Unexpected test action')
		forwarded.push(action.text)
		if (forwarded.length === 1) {
			started()
			await flight
		}
	})
	const first = queue.enqueue({ type: 'type_text', text: 'admitted' }, owner)
	await firstStarted
	const pending = queue.enqueue({ type: 'type_text', text: 'retired' }, owner)
	const retired = expect(pending).rejects.toBeInstanceOf(ComputerInputRetiredError)
	// Focusing chat retires pending input without discarding its painted live stream.
	current = { ...current, viewEpoch: current.viewEpoch + 1 }
	// Returning focus cannot revive the old epoch while the first host reply is pending.
	release()
	await first
	await retired
	await queue.flush()
	expect(forwarded).toEqual(['admitted'])
	await queue.enqueue({ type: 'type_text', text: 'new input' }, current)
	expect(forwarded).toEqual(['admitted', 'new input'])
})
