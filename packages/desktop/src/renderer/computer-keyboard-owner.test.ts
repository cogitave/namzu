import { expect, it } from 'vitest'
import { ComputerInputRetiredError } from './computer-input-focus.js'
import { ComputerInputQueue, computerInputOwnerMatches } from './computer-input-queue.js'
import { ComputerKeyboardOwners } from './computer-keyboard-owner.js'

it('serializes scoped cleanup after in-flight input even when focus/navigation/generation changes', async () => {
	const owners = new ComputerKeyboardOwners()
	const original = { id: 'old-pal', generation: '1', navigation: 1, viewEpoch: 1 }
	let current = { ...original }
	let unblock!: () => void
	let started!: () => void
	const flight = new Promise<void>((resolve) => {
		unblock = resolve
	})
	const entered = new Promise<void>((resolve) => {
		started = resolve
	})
	const calls: unknown[] = []
	const keyboardId = 'old-keyboard-lifetime'
	const queue = new ComputerInputQueue(async (action, captured) => {
		if (action.type === 'release_keys') owners.assertRelease(action.keyboardId, captured)
		else if (!computerInputOwnerMatches(captured, current)) throw new ComputerInputRetiredError()
		calls.push({ action, captured })
		if (action.type === 'key_down') {
			started()
			await flight
		}
	})
	const action = { type: 'key_down' as const, key: 'w', keyboardId }
	owners.capture(action, original)
	const down = queue.enqueue(action, original)
	await entered
	current = { id: 'different-pal', generation: '2', navigation: 2, viewEpoch: 2 }
	const stale = queue.enqueue({ type: 'key_up', key: 'w', keyboardId }, original)
	const staleAssertion = expect(stale).rejects.toBeInstanceOf(ComputerInputRetiredError)
	const captured = owners.owner(keyboardId)!
	const cleanup = queue.enqueue({ type: 'release_keys', keyboardId }, captured)
	unblock()
	await down
	await staleAssertion
	await cleanup
	expect(calls).toEqual([
		{ action, captured: original },
		{ action: { type: 'release_keys', keyboardId }, captured: original },
	])
	owners.retire(keyboardId, captured)
	expect(() => owners.assertRelease(keyboardId, captured)).toThrow(ComputerInputRetiredError)
})

it('never grants cleanup authority to an unknown lifetime or a replaced allocation', () => {
	const owners = new ComputerKeyboardOwners()
	const owner = { id: 'pal', generation: '1', navigation: 1, viewEpoch: 1 }
	const keyboardId = 'private-keyboard-lifetime'
	expect(owners.owner(keyboardId)).toBeUndefined()
	expect(() => owners.capture({ type: 'key_up', key: 'w', keyboardId }, owner)).toThrow(
		ComputerInputRetiredError,
	)
	owners.capture({ type: 'key_down', key: 'w', keyboardId }, owner)
	owner.generation = '2'
	expect(owners.owner(keyboardId)?.generation).toBe('1')
	expect(() => owners.assertRelease(keyboardId, owner)).toThrow(ComputerInputRetiredError)
	expect(() => owners.capture({ type: 'key_down', key: 'd', keyboardId }, owner)).toThrow(
		ComputerInputRetiredError,
	)
})
