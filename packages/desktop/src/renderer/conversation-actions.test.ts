import { describe, expect, it } from 'vitest'
import type { ChatMessage, ConversationView } from '../shared/protocol.js'
import {
	type ConversationActionId,
	type ConversationActionInput,
	type ShortcutEvent,
	ariaShortcut,
	conversationActionGroups,
	conversationShortcut,
	conversationSources,
	lastReplyText,
	shortcutLabel,
} from './conversation-actions.js'

const view: ConversationView = {
	id: 's',
	projectId: 'p',
	title: 'T',
	updatedAt: '2026-10-01T00:00:00Z',
}
const can = {
	rename: true,
	pin: true,
	fork: true,
	markdown: true,
	copy: true,
	archive: true,
	moveRight: true,
	moveWindow: true,
}
function input(overrides: Partial<ConversationActionInput> = {}): ConversationActionInput {
	return {
		view,
		isPal: false,
		running: false,
		queued: 0,
		permissions: 0,
		backgroundRunning: 0,
		hasMessages: true,
		hasReply: true,
		hasProjectPath: true,
		canMoveRight: true,
		can,
		...overrides,
	}
}
const ids = (value: ConversationActionInput) =>
	conversationActionGroups(value)
		.flat()
		.flatMap((entry) => [entry.id, ...(entry.children?.map((child) => child.id) ?? [])])
const find = (value: ConversationActionInput, id: ConversationActionId) =>
	conversationActionGroups(value)
		.flat()
		.flatMap((entry) => [entry, ...(entry.children ?? [])])
		.find((entry) => entry.id === id)

describe('the actions matrix', () => {
	it('offers everything for a Namzu conversation, in the reference order', () => {
		const groups = conversationActionGroups(input())
		expect(groups.map((group) => group.map((entry) => entry.id))).toEqual([
			['rename', 'pin'],
			['side-chat', 'fork'],
			['copy'],
			['move-right', 'move-window'],
			['archive'],
		])
		expect(ids(input())).toContain('copy-markdown')
		expect(ids(input())).toContain('copy-path')
	})
	it('hides rename, fork and Markdown for the Codex and Claude Code engines', () => {
		for (const harness of ['codex-cli', 'claude-code'] as const) {
			const result = ids(input({ view: { ...view, harness } }))
			expect(result).toEqual(
				expect.arrayContaining(['pin', 'copy-reply', 'copy-id', 'move-right', 'archive']),
			)
			for (const hidden of ['rename', 'side-chat', 'fork', 'copy-markdown'])
				expect(result).not.toContain(hidden)
		}
	})
	it('gives a Pal conversation only its move items', () => {
		expect(ids(input({ isPal: true, view: { ...view, palId: 'pal' } }))).toEqual([
			'move-right',
			'move-window',
		])
	})
	it('hides what the host cannot do', () => {
		const result = ids(
			input({ can: { ...can, rename: false, fork: false, markdown: false, copy: false } }),
		)
		for (const hidden of ['rename', 'fork', 'side-chat', 'copy', 'copy-markdown'])
			expect(result).not.toContain(hidden)
	})
	it('labels pin by state', () => {
		expect(find(input(), 'pin')?.label).toBe('Pin')
		expect(find(input({ view: { ...view, pinned: true } }), 'pin')?.label).toBe('Unpin')
	})
	it('says why a fork is refused', () => {
		expect(find(input({ running: true }), 'side-chat')?.reason).toBe(
			'Wait for the reply to finish.',
		)
		expect(find(input({ hasMessages: false }), 'fork')?.reason).toBe(
			'There is nothing to fork yet.',
		)
		expect(find(input(), 'side-chat')?.reason).toBeUndefined()
	})
	it('disables moving right when the pane holds one conversation', () => {
		expect(find(input({ canMoveRight: false }), 'move-right')?.reason).toBe(
			'Open another conversation in this pane first.',
		)
	})
	it('keeps the archive rules and names the blocker', () => {
		expect(find(input({ running: true }), 'archive')?.reason).toMatch(/Stop the reply/)
		expect(find(input({ permissions: 1 }), 'archive')?.reason).toMatch(/approval/)
		expect(find(input({ queued: 2 }), 'archive')?.reason).toMatch(/queued/)
		expect(find(input({ backgroundRunning: 1 }), 'archive')?.reason).toMatch(/background/)
		expect(find(input(), 'archive')?.reason).toBeUndefined()
		expect(find(input(), 'archive')?.label).toBe('Archive…')
	})
	it('drops the project path when there is none and disables an empty copy', () => {
		expect(ids(input({ hasProjectPath: false }))).not.toContain('copy-path')
		expect(find(input({ hasReply: false }), 'copy-reply')?.reason).toBeDefined()
		expect(find(input({ hasMessages: false }), 'copy-markdown')?.reason).toBeDefined()
	})
})

function key(
	code: string,
	overrides: Partial<ShortcutEvent> & { altGraph?: boolean } = {},
): ShortcutEvent {
	const { altGraph = false, ...rest } = overrides
	return {
		code,
		ctrlKey: true,
		metaKey: false,
		altKey: true,
		shiftKey: false,
		getModifierState: (name) => altGraph && name === 'AltGraph',
		...rest,
	}
}

describe('shortcuts', () => {
	it('maps the four chords by physical key', () => {
		expect(conversationShortcut(key('KeyR'), false)).toBe('rename')
		expect(conversationShortcut(key('KeyP'), false)).toBe('pin')
		expect(conversationShortcut(key('KeyS'), false)).toBe('side-chat')
		expect(conversationShortcut(key('KeyA', { altKey: false, shiftKey: true }), false)).toBe(
			'archive',
		)
	})
	it('uses Cmd on a Mac and ignores Ctrl there', () => {
		expect(conversationShortcut(key('KeyR', { ctrlKey: false, metaKey: true }), true)).toBe(
			'rename',
		)
		expect(conversationShortcut(key('KeyR'), true)).toBeNull()
		expect(conversationShortcut(key('KeyR', { ctrlKey: false, metaKey: true }), false)).toBeNull()
	})
	it('ignores AltGr, which many layouts report as Ctrl+Alt', () => {
		expect(conversationShortcut(key('KeyR', { altGraph: true }), false)).toBeNull()
		expect(conversationShortcut(key('KeyS', { altGraph: true }), false)).toBeNull()
	})
	it('ignores IME composition', () => {
		expect(conversationShortcut(key('KeyR', { isComposing: true }), false)).toBeNull()
		expect(conversationShortcut(key('KeyR', { keyCode: 229 }), false)).toBeNull()
	})
	it('ignores near misses', () => {
		expect(conversationShortcut(key('KeyR', { altKey: false }), false)).toBeNull()
		expect(conversationShortcut(key('KeyR', { shiftKey: true }), false)).toBeNull()
		expect(conversationShortcut(key('KeyA'), false)).toBeNull()
		expect(conversationShortcut(key('KeyX'), false)).toBeNull()
	})
	it('prints the hints for both platforms', () => {
		expect(shortcutLabel('rename', false)).toBe('Ctrl+Alt+R')
		expect(shortcutLabel('archive', false)).toBe('Ctrl+Shift+A')
		expect(shortcutLabel('pin', true)).toBe('⌥⌘P')
		expect(ariaShortcut('side-chat', false)).toBe('Control+Alt+S')
		expect(ariaShortcut('archive', true)).toBe('Meta+Shift+A')
		expect(shortcutLabel('copy', false)).toBeUndefined()
	})
})

describe('reply and sources', () => {
	const messages: ChatMessage[] = [
		{
			role: 'user',
			text: 'q',
			attachments: [{ id: 'a', name: 'a.md', kind: 'text', size: 1, mediaType: 'text/markdown' }],
		},
		{ role: 'assistant', text: 'first', phase: 'final_answer', status: 'completed' },
		{
			role: 'user',
			text: 'q2',
			attachments: [
				{ id: 'b', name: 'b.png', kind: 'image', size: 1, mediaType: 'image/png' },
				{ id: 'c', name: 'c.txt', kind: 'text', size: 1, mediaType: 'text/plain' },
			],
		},
		{ role: 'assistant', text: 'thinking', phase: 'commentary' },
		{ role: 'assistant', text: 'streaming', status: 'pending' },
	]
	it('copies the last completed answer, never commentary or a pending reply', () => {
		expect(lastReplyText(messages)).toBe('first')
		expect(lastReplyText([])).toBeUndefined()
		expect(lastReplyText(messages.slice(0, 1))).toBeUndefined()
	})
	it('lists sent attachments newest first', () => {
		expect(conversationSources(messages).map((source) => source.attachment.name)).toEqual([
			'c.txt',
			'b.png',
			'a.md',
		])
		expect(conversationSources([{ role: 'user', text: 'x' }])).toEqual([])
	})
})
