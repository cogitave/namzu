import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import {
	HOVER_CARD_DELAY_MS,
	createGitCache,
	createHoverIntent,
	hoverCardModel,
	lastMessagePreview,
	relativeAge,
} from './sidebar-hover-card.js'
import { ThreadHoverCardView } from './thread-hover-card.js'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const conversation: ConversationView = {
	id: 'c',
	projectId: 'p',
	title: 'Find a memorable workspace name',
	updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
}
const project: ProjectView = {
	id: 'p',
	path: '/work/cogitave',
	name: 'Cogitave',
	trusted: true,
	status: 'ready',
}

describe('relativeAge', () => {
	it('uses the short form the sidebar always showed', () => {
		const at = (ms: number) => relativeAge(new Date(NOW - ms).toISOString(), NOW)
		expect(at(5_000)).toBe('now')
		expect(at(5 * 60_000)).toBe('5m')
		expect(at(3 * 3_600_000)).toBe('3h')
		expect(at(2 * 86_400_000)).toBe('2d')
		expect(relativeAge('not a date', NOW)).toBe('')
	})
})

describe('hoverCardModel', () => {
	it('names the computer, folder and branch', () => {
		const model = hoverCardModel({
			conversation,
			project,
			git: { branch: 'main', subject: null },
			now: NOW,
		})
		expect(model).toMatchObject({
			title: conversation.title,
			age: '3h',
			environment: { kind: 'this-computer', label: 'This computer' },
			folder: 'Cogitave',
			branch: 'main',
		})
	})
	it('omits the branch when it is unknown, detached or the project is not a repository host', () => {
		expect(hoverCardModel({ conversation, project, now: NOW }).branch).toBeUndefined()
		expect(
			hoverCardModel({ conversation, project, git: { branch: null, subject: 'x' }, now: NOW })
				.branch,
		).toBeUndefined()
		const untrusted = { ...project, trusted: false }
		const model = hoverCardModel({
			conversation,
			project: untrusted,
			git: { branch: 'main', subject: null },
			now: NOW,
		})
		expect(model.branch).toBeUndefined()
		expect(model.wantsGit).toBe(false)
	})
	it('drops the folder for an ordinary chat and names a Pal computer', () => {
		expect(
			hoverCardModel({ conversation, project: { ...project, isChat: true }, now: NOW }).folder,
		).toBeUndefined()
		const pal = hoverCardModel({ conversation: { ...conversation, palId: 'x' }, project, now: NOW })
		expect(pal.environment.kind).toBe('pal-computer')
		expect(pal.folder).toBeUndefined()
	})
	it('renders only the lines it has', () => {
		const html = renderToStaticMarkup(
			createElement(ThreadHoverCardView, {
				model: hoverCardModel({
					conversation,
					project,
					git: { branch: 'feat/x', subject: null },
					now: NOW,
				}),
			}),
		)
		// The row already shows the title; the card says what the row cannot.
		expect(html).not.toContain('Find a memorable workspace name')
		expect(html).toContain('Namzu')
		expect(html).toContain('This computer')
		expect(html).toContain('Cogitave')
		expect(html).toContain('feat/x')
		const bare = renderToStaticMarkup(
			createElement(ThreadHoverCardView, {
				model: hoverCardModel({ conversation, project, now: NOW }),
			}),
		)
		expect(bare).not.toContain('feat/x')
		const said = renderToStaticMarkup(
			createElement(ThreadHoverCardView, {
				model: hoverCardModel({
					conversation,
					project,
					messages: [
						{ role: 'user', text: 'Please list the files' },
						{ role: 'assistant', text: '  Here are\nthe files.  ' },
					],
					now: NOW,
				}),
			}),
		)
		expect(said).toContain('Here are the files.')
	})
	it('previews the last message, marking the person’s own', () => {
		expect(lastMessagePreview([{ role: 'user', text: ' hi   there ' }])).toBe('You: hi there')
		expect(
			lastMessagePreview([
				{ role: 'assistant', text: 'ok' },
				{ role: 'user', text: '  ' },
			]),
		).toBe('ok')
		expect(lastMessagePreview([{ role: 'assistant', text: 'x'.repeat(200) }])).toBe(
			`${'x'.repeat(120)}…`,
		)
		expect(lastMessagePreview(undefined)).toBeUndefined()
	})
})

describe('createHoverIntent', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())
	it('opens only after the delay and closes at once on cancel', () => {
		const onOpen = vi.fn()
		const onClose = vi.fn()
		const intent = createHoverIntent({ onOpen, onClose })
		intent.enter()
		vi.advanceTimersByTime(HOVER_CARD_DELAY_MS - 1)
		expect(onOpen).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(onOpen).toHaveBeenCalledTimes(1)
		intent.cancel()
		expect(onClose).toHaveBeenCalledTimes(1)
	})
	it('never opens when the pointer leaves first, and does not close what never opened', () => {
		const onOpen = vi.fn()
		const onClose = vi.fn()
		const intent = createHoverIntent({ onOpen, onClose })
		intent.enter()
		vi.advanceTimersByTime(200)
		intent.cancel()
		vi.advanceTimersByTime(1000)
		expect(onOpen).not.toHaveBeenCalled()
		expect(onClose).not.toHaveBeenCalled()
	})
	it('does not restart while open', () => {
		const onOpen = vi.fn()
		const intent = createHoverIntent({ onOpen, onClose: vi.fn() })
		intent.enter()
		vi.advanceTimersByTime(HOVER_CARD_DELAY_MS)
		intent.enter()
		vi.advanceTimersByTime(HOVER_CARD_DELAY_MS * 2)
		expect(onOpen).toHaveBeenCalledTimes(1)
	})
})

describe('createGitCache', () => {
	it('asks the host once per project within the ttl, even for overlapping hovers', async () => {
		let clock = 0
		const load = vi.fn(async () => ({ branch: 'main', subject: null }))
		const cache = createGitCache(load, { ttl: 1000, now: () => clock })
		await Promise.all([cache.get('p'), cache.get('p')])
		await cache.get('p')
		expect(load).toHaveBeenCalledTimes(1)
		expect(cache.peek('p')).toEqual({ branch: 'main', subject: null })
		clock = 1001
		expect(cache.peek('p')).toBeUndefined()
		await cache.get('p')
		expect(load).toHaveBeenCalledTimes(2)
	})
	it('treats a failed read as unknown, not as a branch', async () => {
		const cache = createGitCache(async () => {
			throw new Error('no')
		})
		await expect(cache.get('p')).resolves.toBeNull()
	})
})
