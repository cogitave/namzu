import { expect, it, vi } from 'vitest'
import type { PalComputerInput } from '../shared/protocol.js'
import { type ComputerInputOwner, ComputerInputQueue } from './computer-input-queue.js'

const owner: ComputerInputOwner = { id: 'pal-a', generation: 'allocation-a', navigation: 4 }
function executor() {
	return vi.fn<(action: PalComputerInput, captured: Readonly<ComputerInputOwner>) => Promise<void>>(
		async () => {},
	)
}
function deferred() {
	let resolve = () => {}
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

it('batches rapid text while preserving Enter, click, drag, and scroll ordering', async () => {
	const execute = executor()
	const queue = new ComputerInputQueue(execute)
	const text = 'data:text/html,<input id=p autofocus placeholder=hello>'
	const sent = [...text].map((character) =>
		queue.enqueue({ type: 'type_text', text: character }, owner),
	)
	const boundaries: PalComputerInput[] = [
		{ type: 'key', keys: 'ENTER' },
		{ type: 'mouse_click', at: { x: 2, y: 3 }, button: 'left' },
		{ type: 'type_text', text: 'İyi' },
		{ type: 'mouse_drag', from: { x: 2, y: 3 }, to: { x: 4, y: 5 }, button: 'left' },
		{ type: 'type_text', text: ' günler' },
		{ type: 'scroll', at: { x: 4, y: 5 }, direction: 'down', amount: 1 },
	]
	for (const action of boundaries) sent.push(queue.enqueue(action, owner))
	expect(execute).not.toHaveBeenCalled()
	await Promise.all(sent)
	expect(execute.mock.calls.map(([action]) => action)).toEqual([
		{ type: 'type_text', text },
		...boundaries,
	])
})

it('never changes an in-flight batch and resolves merged callers only after confirmation', async () => {
	const started = deferred()
	const firstReply = deferred()
	const secondReply = deferred()
	const calls: PalComputerInput[] = []
	const queue = new ComputerInputQueue(async (action) => {
		calls.push(action)
		if (calls.length === 1) {
			started.resolve()
			await firstReply.promise
		} else await secondReply.promise
	})
	let firstConfirmed = false
	let restConfirmed = false
	const first = queue.enqueue({ type: 'type_text', text: 'a' }, owner)
	void first.then(() => {
		firstConfirmed = true
	})
	await started.promise
	const rest = Promise.all([
		queue.enqueue({ type: 'type_text', text: 'b' }, owner),
		queue.enqueue({ type: 'type_text', text: 'c' }, owner),
	])
	void rest.then(() => {
		restConfirmed = true
	})
	expect(calls).toEqual([{ type: 'type_text', text: 'a' }])
	expect(firstConfirmed).toBe(false)
	expect(restConfirmed).toBe(false)
	firstReply.resolve()
	await first
	expect(firstConfirmed).toBe(true)
	expect(restConfirmed).toBe(false)
	expect(calls).toEqual([
		{ type: 'type_text', text: 'a' },
		{ type: 'type_text', text: 'bc' },
	])
	secondReply.resolve()
	await rest
	await queue.flush()
	expect(restConfirmed).toBe(true)
})

it('coalesces only adjacent queued mouse moves for the exact same owner', async () => {
	const execute = executor()
	const queue = new ComputerInputQueue(execute)
	const actions: PalComputerInput[] = [
		{ type: 'mouse_move', to: { x: 1, y: 1 } },
		{ type: 'mouse_move', to: { x: 2, y: 2 } },
		{ type: 'mouse_click', at: { x: 2, y: 2 }, button: 'left' },
		{ type: 'mouse_move', to: { x: 3, y: 3 } },
		{ type: 'mouse_move', to: { x: 4, y: 4 } },
	]
	const sent = actions.map((action) => queue.enqueue(action, owner))
	sent.push(queue.enqueue({ type: 'mouse_move', to: { x: 5, y: 5 } }, { ...owner, navigation: 5 }))
	await Promise.all(sent)
	expect(execute.mock.calls.map(([action]) => action)).toEqual([
		actions[1],
		actions[2],
		actions[4],
		{ type: 'mouse_move', to: { x: 5, y: 5 } },
	])
})

it('does not merge text across Pal, generation, or navigation ownership boundaries', async () => {
	const execute = executor()
	const queue = new ComputerInputQueue(execute)
	const owners = [
		owner,
		{ ...owner, id: 'pal-b' },
		{ ...owner, generation: 'allocation-b' },
		{ ...owner, navigation: 5 },
	]
	await Promise.all(
		owners.map((token, index) => queue.enqueue({ type: 'type_text', text: `${index}` }, token)),
	)
	expect(execute.mock.calls).toEqual(
		owners.map((token, index) => [{ type: 'type_text', text: `${index}` }, token]),
	)
})

it('caps each text batch in UTF-8 bytes without breaking Unicode or losing large pastes', async () => {
	const execute = executor()
	const queue = new ComputerInputQueue(execute)
	const text = `${'🐰'.repeat(8200)}İçinde`
	await queue.enqueue({ type: 'type_text', text }, owner)
	const batches = execute.mock.calls.map(([action]) => action)
	expect(batches).toHaveLength(2)
	expect(batches.every((action) => action.type === 'type_text')).toBe(true)
	const copied = batches.map((action) => (action as { type: 'type_text'; text: string }).text)
	expect(copied.join('')).toBe(text)
	for (const chunk of copied)
		expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(32768)
	const adjacent = new ComputerInputQueue(execute)
	execute.mockClear()
	await Promise.all([
		adjacent.enqueue({ type: 'type_text', text: 'x'.repeat(32767) }, owner),
		adjacent.enqueue({ type: 'type_text', text: 'İ' }, owner),
	])
	expect(execute).toHaveBeenCalledTimes(2)
})

it('captures immutable action and owner before yielding to execution', async () => {
	const execute = executor()
	const queue = new ComputerInputQueue(execute)
	const token = { ...owner }
	const action = { type: 'mouse_move' as const, to: { x: 10, y: 20 } }
	const sent = queue.enqueue(action, token)
	token.id = 'pal-b'
	token.generation = 'allocation-b'
	token.navigation = 99
	action.to.x = 999
	await sent
	expect(execute.mock.calls).toEqual([[{ type: 'mouse_move', to: { x: 10, y: 20 } }, owner]])
	const [capturedAction, capturedOwner] = execute.mock.calls[0] ?? []
	expect(Object.isFrozen(capturedOwner)).toBe(true)
	expect(Object.isFrozen(capturedAction)).toBe(true)
	expect(Object.isFrozen((capturedAction as { to: object }).to)).toBe(true)
})

it('rejects every failed batch caller, rechecks later owners, and drains before control transfer', async () => {
	const started = deferred()
	const denied = deferred()
	const failure = new Error('The old allocation no longer accepts input.')
	const confirmed: string[] = []
	const queue = new ComputerInputQueue(async (action, captured) => {
		if (captured.generation === owner.generation) {
			started.resolve()
			await denied.promise
			throw failure
		}
		if (action.type === 'type_text') confirmed.push(action.text)
	})
	const rejected = Promise.allSettled([
		queue.enqueue({ type: 'type_text', text: 'a' }, owner),
		queue.enqueue({ type: 'type_text', text: 'b' }, owner),
	])
	await started.promise
	const later = queue.enqueue(
		{ type: 'type_text', text: 'new computer' },
		{ ...owner, generation: 'new-allocation' },
	)
	let idle = false
	const flushed = queue.flush().then(() => {
		idle = true
	})
	expect(idle).toBe(false)
	denied.resolve()
	const outcomes = await rejected
	expect(outcomes).toEqual([
		{ status: 'rejected', reason: failure },
		{ status: 'rejected', reason: failure },
	])
	await later
	await flushed
	expect(confirmed).toEqual(['new computer'])
	expect(idle).toBe(true)
	await queue.flush()
})
