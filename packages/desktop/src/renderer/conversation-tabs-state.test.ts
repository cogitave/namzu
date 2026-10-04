import { describe, expect, it, vi } from 'vitest'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import {
	CONVERSATION_TABS_STORAGE_KEY,
	type ConversationTabsState,
	readConversationTabsState,
	resolveConversationTabsState,
	writeConversationTabsState,
} from './conversation-tabs-state.js'

const project = (id: string, patch: Partial<ProjectView> = {}): ProjectView => ({
	id,
	path: `/${id}`,
	name: id,
	trusted: true,
	status: 'ready',
	...patch,
})
const conversation = (
	id: string,
	projectId: string,
	patch: Partial<ConversationView> = {},
): ConversationView => ({ id, projectId, title: id, updatedAt: '2026-10-04T10:00:00Z', ...patch })
const projects = [project('app'), project('other'), project('pal-project', { palId: 'pal' })]
const conversations = [
	conversation('first', 'app', { harness: 'namzu' }),
	conversation('native', 'app', { harness: 'codex-cli' }),
	conversation('other-thread', 'other', { harness: 'claude-code' }),
	conversation('pal-thread', 'pal-project', { palId: 'pal' }),
	conversation('pal-in-normal', 'app', { palId: 'pal' }),
	conversation('unbound-pal', 'pal-project'),
	conversation('unknown-project', 'missing'),
]
const state: ConversationTabsState = {
	projectId: 'app',
	activeSessionId: 'native',
	openTabIds: ['first', 'native'],
}

describe('ephemeral normal conversation navigation', () => {
	it('round-trips only project and conversation IDs without duplicating drafts or model settings', () => {
		let saved: string | null = null
		const storage = {
			getItem: vi.fn(() => saved),
			setItem: vi.fn((_key: string, value: string) => {
				saved = value
			}),
		}
		expect(writeConversationTabsState(storage, state)).toBe(true)
		expect(storage.setItem).toHaveBeenCalledWith(
			CONVERSATION_TABS_STORAGE_KEY,
			JSON.stringify(state),
		)
		expect(readConversationTabsState(storage)).toEqual(state)
		expect(storage.getItem).toHaveBeenCalledWith(CONVERSATION_TABS_STORAGE_KEY)
		expect(
			writeConversationTabsState(storage, {
				...state,
				draft: 'private draft',
			} as ConversationTabsState),
		).toBe(false)
		expect(storage.setItem).toHaveBeenCalledOnce()
	})
	it.each([
		null,
		'',
		'{',
		'null',
		'[]',
		'{}',
		JSON.stringify({ ...state, projectId: '' }),
		JSON.stringify({ ...state, activeSessionId: null }),
		JSON.stringify({ ...state, openTabIds: ['first', 5] }),
		JSON.stringify({ ...state, openTabIds: [' first'] }),
		JSON.stringify({ ...state, settings: { model: 'invented' } }),
	])('ignores missing or malformed storage %s', (raw) => {
		expect(readConversationTabsState({ getItem: () => raw })).toBeUndefined()
	})
	it('handles unavailable and full session storage without throwing', () => {
		expect(
			readConversationTabsState({
				getItem: () => {
					throw new Error('Storage is unavailable')
				},
			}),
		).toBeUndefined()
		expect(
			writeConversationTabsState(
				{
					setItem: () => {
						throw new Error('Storage is full')
					},
				},
				state,
			),
		).toBe(false)
	})
	it('preserves real normal tab order across projects while removing duplicates and foreign views', () => {
		expect(
			resolveConversationTabsState(
				{
					...state,
					openTabIds: [
						'other-thread',
						'pal-thread',
						'native',
						'first',
						'native',
						'unknown',
						'unknown-project',
						'pal-in-normal',
						'unbound-pal',
					],
				},
				projects,
				conversations,
			),
		).toEqual({ ...state, openTabIds: ['other-thread', 'native', 'first'] })
	})
	it.each([
		{ ...state, projectId: 'unknown' },
		{
			...state,
			projectId: 'pal-project',
			activeSessionId: 'pal-thread',
			openTabIds: ['pal-thread'],
		},
		{ ...state, activeSessionId: 'unknown' },
		{ ...state, activeSessionId: 'other-thread', openTabIds: ['other-thread'] },
		{ ...state, activeSessionId: 'pal-in-normal', openTabIds: ['pal-in-normal'] },
		{ ...state, openTabIds: ['first'] },
	])('refuses an invalid active owner without choosing another conversation: %j', (invalid) => {
		expect(resolveConversationTabsState(invalid, projects, conversations)).toBeUndefined()
	})
	it('retains an explicitly selected normal project draft with no active conversation', () => {
		expect(
			resolveConversationTabsState({ ...state, activeSessionId: '' }, projects, conversations),
		).toEqual({ ...state, activeSessionId: '' })
	})
})
