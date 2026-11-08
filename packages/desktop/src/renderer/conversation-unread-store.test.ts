import { expect, it, vi } from 'vitest'
import type { ConversationUnreadView, DesktopEvent } from '../shared/protocol.js'
import { ConversationUnreadStore } from './conversation-unread-store.js'

function setup(initial: () => Promise<ConversationUnreadView>) {
	let push: (event: DesktopEvent) => void = () => {}
	const stop = vi.fn()
	const api = {
		conversationUnread: initial,
		setConversationUnread: vi.fn(),
		onEvent: (listener: (event: DesktopEvent) => void) => {
			push = listener
			return stop
		},
	}
	const store = new ConversationUnreadStore(api)
	const changes = vi.fn()
	const unsubscribe = store.subscribe(changes)
	return { api, store, changes, push: (event: DesktopEvent) => push(event), stop, unsubscribe }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

it('takes the first answer', async () => {
	const { store } = setup(async () => ({ ids: ['a'], sequence: 4 }))
	await flush()
	expect([...store.snapshot()]).toEqual(['a'])
})

it('does not let a reply that arrives late undo a newer event', async () => {
	let reply: (view: ConversationUnreadView) => void = () => {}
	const { store, push } = setup(
		() =>
			new Promise((resolve) => {
				reply = resolve
			}),
	)
	// Main sent sequence 5 (a is read) as an event, and the invoke answered with sequence 4 (a is
	// unread) from before it; the reply is the one that arrives second.
	push({ kind: 'unread', ids: [], sequence: 5 })
	reply({ ids: ['a'], sequence: 4 })
	await flush()
	expect([...store.snapshot()]).toEqual([])
})

it('does not let an older event replace a newer reply', async () => {
	const { store, push } = setup(async () => ({ ids: ['a', 'b'], sequence: 7 }))
	await flush()
	push({ kind: 'unread', ids: ['a'], sequence: 6 })
	expect([...store.snapshot()]).toEqual(['a', 'b'])
	push({ kind: 'unread', ids: ['b'], sequence: 8 })
	expect([...store.snapshot()]).toEqual(['b'])
})

it('tells its listeners once per change and not for an answer it already holds', async () => {
	const { changes, push } = setup(async () => ({ ids: ['a'], sequence: 1 }))
	await flush()
	expect(changes).toHaveBeenCalledTimes(1)
	push({ kind: 'unread', ids: ['a'], sequence: 1 })
	expect(changes).toHaveBeenCalledTimes(1)
	push({ kind: 'unread', ids: [], sequence: 2 })
	expect(changes).toHaveBeenCalledTimes(2)
})

it("sets a marker through main and shows main's answer", async () => {
	const { api, store } = setup(async () => ({ ids: [], sequence: 0 }))
	await flush()
	api.setConversationUnread.mockResolvedValue({ ids: ['a'], sequence: 1 })
	await store.set('a', true)
	expect(api.setConversationUnread).toHaveBeenCalledWith('a', true)
	expect([...store.snapshot()]).toEqual(['a'])
})

it('stops listening and forgets when the last listener leaves', async () => {
	const { store, stop, unsubscribe } = setup(async () => ({ ids: ['a'], sequence: 1 }))
	await flush()
	unsubscribe()
	expect(stop).toHaveBeenCalled()
	expect([...store.snapshot()]).toEqual([])
})
