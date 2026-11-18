import type { SessionEvent } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { SideModel } from '../../integrations/small-model/side-model.js'
import {
	TITLE_NOTIFICATION,
	TITLE_NOTIFICATION_MAX,
	createTitleFeed,
	fitTitle,
} from '../desktop-title-feed.js'

const started = { type: 'turn_started', turnId: 't1' } as unknown as SessionEvent
const other = { type: 'turn_completed', turnId: 't1' } as unknown as SessionEvent

function side(reply: string | undefined): SideModel {
	return { ask: vi.fn(async () => reply) } as unknown as SideModel
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('the title feed', () => {
	it('names a conversation once, beside its first turn, and says it', async () => {
		const notify = vi.fn()
		const save = vi.fn(async () => undefined)
		const model = side('{"title": "Ada Kahve web sayfası"}')
		const feed = createTitleFeed({
			notify,
			sideModel: () => model,
			hasTitle: async () => false,
			save,
			idle: () => true,
		})
		feed.expect('s1', 'Kahve dükkanım için tek sayfalık bir web sayfası yap')
		feed.observe('s1', other)
		expect(model.ask).not.toHaveBeenCalled()
		feed.observe('s1', started)
		feed.observe('s1', started)
		await settle()
		expect(model.ask).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith(TITLE_NOTIFICATION, {
			sessionId: 's1',
			title: 'Ada Kahve web sayfası',
		})
		expect(save).toHaveBeenCalledWith('s1', 'Ada Kahve web sayfası')
		// A later first message of the same conversation is not named again.
		feed.expect('s1', 'Another long message to name')
		feed.observe('s1', started)
		await settle()
		expect(model.ask).toHaveBeenCalledTimes(1)
	})

	it('says nothing when the request fails, and the conversation can be tried again', async () => {
		const notify = vi.fn()
		const feed = createTitleFeed({
			notify,
			sideModel: () => side(undefined),
			hasTitle: async () => false,
			save: async () => undefined,
			idle: () => true,
		})
		feed.expect('s1', 'A message long enough to name')
		feed.observe('s1', started)
		await settle()
		expect(notify).not.toHaveBeenCalled()
		feed.expect('s1', 'A message long enough to name')
		feed.observe('s1', started)
		await settle()
		expect(notify).not.toHaveBeenCalled()
	})

	it('leaves a conversation that already has a name alone, and one with no small model', async () => {
		const notify = vi.fn()
		const named = side('{"title": "x title"}')
		const a = createTitleFeed({
			notify,
			sideModel: () => named,
			hasTitle: async () => true,
			save: async () => undefined,
			idle: () => true,
		})
		a.expect('s1', 'A message long enough to name')
		a.observe('s1', started)
		await settle()
		expect(named.ask).not.toHaveBeenCalled()
		const b = createTitleFeed({
			notify,
			sideModel: () => undefined,
			hasTitle: async () => false,
			save: async () => undefined,
			idle: () => true,
		})
		b.expect('s2', 'A message long enough to name')
		b.observe('s2', started)
		await settle()
		expect(notify).not.toHaveBeenCalled()
	})

	it('keeps a name the log would not take yet and saves it when flushed', async () => {
		const notify = vi.fn()
		const save = vi
			.fn<(id: string, title: string) => Promise<unknown>>()
			.mockRejectedValueOnce(new Error('busy'))
			.mockResolvedValue(undefined)
		const feed = createTitleFeed({
			notify,
			sideModel: () => side('{"title": "Coffee page"}'),
			hasTitle: async () => false,
			save,
			idle: () => true,
		})
		feed.expect('s1', 'A message long enough to name')
		feed.observe('s1', started)
		await settle()
		expect(notify).toHaveBeenCalledTimes(1)
		await feed.flush('s1')
		expect(save).toHaveBeenCalledTimes(2)
		await feed.flush('s1')
		expect(save).toHaveBeenCalledTimes(2)
	})

	it('writes the log only while no turn runs, and a turn waits for a write under way', async () => {
		let running = true
		let release: (() => void) | undefined
		const save = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const feed = createTitleFeed({
			notify: vi.fn(),
			sideModel: () => side('{"title": "Coffee page"}'),
			hasTitle: async () => false,
			save,
			idle: () => !running,
		})
		feed.expect('s1', 'A message long enough to name')
		feed.observe('s1', started)
		await settle()
		// The turn is still running when the title arrives: nothing is written.
		expect(save).not.toHaveBeenCalled()
		running = false
		const flushed = feed.flush('s1')
		await settle()
		expect(save).toHaveBeenCalledTimes(1)
		// A second flush while one is under way writes nothing more, and the next turn waits.
		await feed.flush('s1')
		expect(save).toHaveBeenCalledTimes(1)
		let turnMayStart = false
		const waiting = feed.saved('s1').then(() => {
			turnMayStart = true
		})
		await settle()
		expect(turnMayStart).toBe(false)
		release?.()
		await flushed
		await waiting
		expect(turnMayStart).toBe(true)
	})

	it('cuts a long title to sixty characters', () => {
		const long = 'word '.repeat(30).trim()
		const fitted = fitTitle(long)
		expect(fitted.length).toBeLessThanOrEqual(TITLE_NOTIFICATION_MAX)
		expect(fitted.endsWith('…')).toBe(true)
		expect(fitTitle('Short one')).toBe('Short one')
	})
})
