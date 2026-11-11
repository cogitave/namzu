import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationSearchHit } from '../shared/protocol.js'
import { matchesCommandOrText } from './command-palette-filter.js'
import {
	CONVERSATION_SEARCH_DELAY_MS,
	ConversationSearch,
	type ConversationTextMatches,
} from './use-conversation-search.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(search: (query: string) => Promise<ConversationSearchHit[]>) {
	const published: (ConversationTextMatches | undefined)[] = []
	return { controller: new ConversationSearch(search, (value) => published.push(value)), published }
}

it('waits for typing to pause, searches once, and keys the excerpts by palette item', async () => {
	const search = vi.fn(async () => [{ conversationId: 'c1', excerpt: 'edited cart.js' }])
	const { controller, published } = setup(search)
	controller.change('ca')
	controller.change('car')
	controller.change('cart ')
	await vi.advanceTimersByTimeAsync(CONVERSATION_SEARCH_DELAY_MS - 1)
	expect(search).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(search).toHaveBeenCalledTimes(1)
	expect(search).toHaveBeenCalledWith('cart')
	expect(published.at(-1)?.query).toBe('cart')
	expect(published.at(-1)?.excerpts.get('conversation:c1')).toBe('edited cart.js')
})

it('clears matches for text too short to search and never lets an old answer land', async () => {
	let release: (hits: ConversationSearchHit[]) => void = () => {}
	const search = vi.fn(
		() =>
			new Promise<ConversationSearchHit[]>((resolve) => {
				release = resolve
			}),
	)
	const { controller, published } = setup(search)
	controller.change('cart')
	await vi.advanceTimersByTimeAsync(CONVERSATION_SEARCH_DELAY_MS)
	controller.change('c')
	expect(published.at(-1)).toBeUndefined()
	release([{ conversationId: 'late', excerpt: 'old' }])
	await vi.advanceTimersByTimeAsync(0)
	expect(published.at(-1)).toBeUndefined()
	expect(published.every((value) => value === undefined)).toBe(true)
})

it('drops the matches when a search fails, and stop() cancels a pending one', async () => {
	const failing = vi.fn(async () => {
		throw new Error('engine gone')
	})
	const { controller, published } = setup(failing)
	controller.change('cart')
	await vi.advanceTimersByTimeAsync(CONVERSATION_SEARCH_DELAY_MS)
	expect(published.at(-1)).toBeUndefined()
	controller.change('cart again')
	controller.stop()
	await vi.advanceTimersByTimeAsync(CONVERSATION_SEARCH_DELAY_MS * 2)
	expect(failing).toHaveBeenCalledTimes(1)
})

it('keeps a conversation whose title misses but whose text matched', () => {
	const contains = (text: string, term: string) => text.toLowerCase().includes(term.toLowerCase())
	const item = { id: 'conversation:c1', label: 'Fix the total', group: 'Recent' }
	expect(matchesCommandOrText(item, 'cart', contains, undefined)).toBe(false)
	expect(
		matchesCommandOrText(item, 'cart', contains, new Map([['conversation:c1', 'cart.js']])),
	).toBe(true)
	expect(matchesCommandOrText(item, 'cart', contains, new Map([['conversation:c2', 'x']]))).toBe(
		false,
	)
	expect(matchesCommandOrText(item, 'total', contains, undefined)).toBe(true)
})
