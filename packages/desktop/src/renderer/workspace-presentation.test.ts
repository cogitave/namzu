import { expect, it } from 'vitest'
import {
	type WorkspacePresentation,
	chooseWorkDisclosure,
	readWorkspacePresentation,
	workDisclosureKey,
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

it('retains only explicit ordinary work choices, including closed, across owner restores', () => {
	const cache = storage()
	const first = workDisclosureKey(2, 'message-4')
	const steered = workDisclosureKey(2, 'tool-check')
	expect(first).toBeDefined()
	expect(steered).toBeDefined()
	expect(first).not.toBe(steered)
	const choices = chooseWorkDisclosure(chooseWorkDisclosure({}, first!, true), steered!, false)
	writeWorkspacePresentation(cache, 'ordinary', presentation({ workDisclosures: choices }))
	writeWorkspacePresentation(cache, 'other', presentation())
	expect(readWorkspacePresentation(cache, 'ordinary')?.workDisclosures).toEqual({
		[first!]: true,
		[steered!]: false,
	})
	expect(readWorkspacePresentation(cache, 'other')?.workDisclosures).toBeUndefined()
	expect(readWorkspacePresentation(cache, 'ordinary', 'pal')?.workDisclosures).toBeUndefined()
})

it('bounds work choices without corrupting the other presentation fields', () => {
	let choices = {}
	for (let turn = 0; turn < 40; turn++) {
		const key = workDisclosureKey(turn, 'message-0')
		expect(key).toBeDefined()
		choices = chooseWorkDisclosure(choices, key!, turn % 2 === 0)
	}
	expect(Object.keys(choices)).toHaveLength(32)
	expect(choices).not.toHaveProperty(workDisclosureKey(0, 'message-0')!)
	expect(choices).toHaveProperty(workDisclosureKey(39, 'message-0')!, false)
	expect(workDisclosureKey(1, `tool-${'x'.repeat(100)}`)).toBeUndefined()
	const cache = storage()
	writeWorkspacePresentation(cache, 'session', presentation({ workDisclosures: choices }))
	expect(readWorkspacePresentation(cache, 'session')?.scrollTop).toBe(428)
	expect(readWorkspacePresentation(cache, 'session')?.workDisclosures).toEqual(choices)
})

it('prunes escaped work keys before the stored presentation exceeds its read limit', () => {
	let choices = {}
	for (let turn = 0; turn < 32; turn++) {
		const key = workDisclosureKey(turn, `tool-${'\\'.repeat(34)}`)
		expect(key).toBeDefined()
		choices = chooseWorkDisclosure(choices, key!, true)
	}
	// A key can fit the per-key limit while escaping expands it again in the map.
	expect(Object.keys(choices).length).toBeLessThan(32)
	expect(choices).toHaveProperty(workDisclosureKey(31, `tool-${'\\'.repeat(34)}`)!, true)
	const cache = storage()
	writeWorkspacePresentation(cache, 'session', presentation({ workDisclosures: choices }))
	expect(readWorkspacePresentation(cache, 'session')?.workDisclosures).toEqual(choices)
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
	{ ...presentation(), workDisclosures: [] },
	{ ...presentation(), workDisclosures: { 'not-a-key': true } },
	{ ...presentation(), workDisclosures: { [JSON.stringify([1, 'message-0'])]: 'true' } },
	{ ...presentation(), workDisclosures: { [JSON.stringify([1, 'message-0'])]: null } },
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

it('keeps whether the panel is expanded, and reads an older record as not expanded', () => {
	const cache = storage()
	writeWorkspacePresentation(cache, 'a', presentation({ panelExpanded: true }))
	expect(readWorkspacePresentation(cache, 'a')?.panelExpanded).toBe(true)
	writeWorkspacePresentation(cache, 'b', presentation())
	expect(readWorkspacePresentation(cache, 'b')?.panelExpanded).toBeUndefined()
	expect(readRaw({ ...presentation(), panelExpanded: 'yes' })).toBeNull()
})
