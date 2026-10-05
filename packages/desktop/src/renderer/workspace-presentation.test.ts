import { expect, it } from 'vitest'
import {
	type WorkspacePresentation,
	readWorkspacePresentation,
	writeWorkspacePresentation,
} from './workspace-presentation.js'

function storage() {
	const rows = new Map<string, string>()
	return {
		getItem: (key: string) => rows.get(key) ?? null,
		setItem: (key: string, value: string) => rows.set(key, value),
	}
}

function presentation(overrides: Partial<WorkspacePresentation> = {}): WorkspacePresentation {
	return {
		computerChat: 'floating',
		floatingChatMinimized: true,
		palProfileOpen: false,
		computerProfileOpen: true,
		jobsOpen: true,
		panelTab: 'changes',
		follow: false,
		scrollTop: 428,
		...overrides,
	}
}

function readRaw(value: unknown, palId?: string) {
	return readWorkspacePresentation({ getItem: () => JSON.stringify(value) }, 'session', palId)
}

it('restores the Pal computer, chat and position while dropping an old technical pane', () => {
	const cache = storage()
	const original = presentation({
		palScreen: { palId: 'pal-happy', activeTab: 'computer' },
	})
	writeWorkspacePresentation(cache, 'pal-session', original)
	expect(readWorkspacePresentation(cache, 'pal-session', 'pal-happy')).toEqual({
		...original,
		jobsOpen: false,
	})
})

it('keeps ordinary session view state independent from other conversations', () => {
	const cache = storage()
	const first = presentation({
		computerChat: 'hidden',
		jobsOpen: false,
		scrollTop: 0,
	})
	const second = presentation({ panelTab: 'jobs', scrollTop: 91 })
	writeWorkspacePresentation(cache, 'first', first)
	writeWorkspacePresentation(cache, 'second', second)
	expect(readWorkspacePresentation(cache, 'first')).toEqual(first)
	expect(readWorkspacePresentation(cache, 'second')).toEqual(second)
	expect(readWorkspacePresentation(cache, 'missing')).toBeNull()
})

it('drops stale or malformed Pal identity while preserving the remaining valid view state', () => {
	const original = presentation({
		palScreen: { palId: 'old-pal', activeTab: 'computer' },
	})
	for (const palId of [undefined, 'new-pal'])
		expect(readRaw(original, palId)).toEqual({
			...original,
			jobsOpen: palId ? false : original.jobsOpen,
			palScreen: undefined,
		})
	for (const palScreen of [
		{ activeTab: 'computer' },
		{ palId: 12, activeTab: 'computer' },
		{ palId: 'new-pal', activeTab: 'missing' },
		{ palId: 'new-pal', activeTab: ['computer'] },
	]) {
		expect(readRaw({ ...original, palScreen }, 'new-pal')).toEqual({
			...original,
			jobsOpen: false,
			palScreen: undefined,
		})
	}
	expect(readRaw({ ...original, palScreen: { activeTab: 'computer' } })).toEqual({
		...original,
		palScreen: undefined,
	})
})

it('rejects invalid JSON, oversized stored data and unavailable storage', () => {
	for (const raw of ['', '{', 'null', JSON.stringify(presentation()) + ' '.repeat(4096)])
		expect(readWorkspacePresentation({ getItem: () => raw }, 'session')).toBeNull()
	expect(
		readWorkspacePresentation(
			{
				getItem: () => {
					throw new Error('Storage unavailable')
				},
			},
			'session',
		),
	).toBeNull()
})

it.each([
	null,
	[],
	'split',
	{},
	presentation({
		computerChat: 'unknown' as WorkspacePresentation['computerChat'],
	}),
	{ ...presentation(), computerChat: ['split'] },
	{ ...presentation(), panelTab: ['jobs'] },
	{ ...presentation(), panelTab: 'unknown' },
	{ ...presentation(), follow: 'false' },
	{ ...presentation(), floatingChatMinimized: 0 },
	{ ...presentation(), palProfileOpen: null },
	{ ...presentation(), computerProfileOpen: undefined },
	{ ...presentation(), jobsOpen: 'true' },
	{ ...presentation(), scrollTop: -1 },
	{ ...presentation(), scrollTop: '20' },
	{ ...presentation(), scrollTop: Number.POSITIVE_INFINITY },
])('rejects malformed presentation shapes %#', (value) => {
	expect(readRaw(value)).toBeNull()
})

it('propagates a failed write so a transfer cannot acknowledge lost presentation state', () => {
	const error = new Error('Storage quota exceeded')
	expect(() =>
		writeWorkspacePresentation(
			{
				setItem: () => {
					throw error
				},
			},
			'session',
			presentation(),
		),
	).toThrow(error)
})
