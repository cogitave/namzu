import { describe, expect, it } from 'vitest'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import {
	type DeliveredKeys,
	type ListOutcome,
	replaceProject,
	rowsToRemember,
	snapshotConversations,
	stableConversationRows,
	withRememberedRows,
} from './sidebar-catalogue.js'

const project = (id: string, over: Partial<ProjectView> = {}): ProjectView => ({
	id,
	path: `/work/${id}`,
	name: id,
	trusted: true,
	status: 'ready',
	...over,
})
const chat = (id: string, projectId: string, updatedAt: string, over = {}): ConversationView => ({
	id,
	projectId,
	title: `title ${id}`,
	updatedAt,
	...over,
})
const none = { conversations: new Set<string>(), projects: new Set<string>() }
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describe('replaceProject', () => {
	const rows = [project('a'), project('b'), project('c')]
	it('keeps a project where it was when it connects, fails, goes missing or is trusted', () => {
		for (const change of [
			{ status: 'connecting' as const },
			{ status: 'error' as const, error: 'No' },
			{ missing: true as const },
			{ trusted: false },
		])
			expect(ids(replaceProject(rows, { ...project('b'), ...change }))).toEqual(['a', 'b', 'c'])
		expect(replaceProject(rows, project('a', { name: 'renamed' }))[0]?.name).toBe('renamed')
	})
	it('adds a project that is new to the list at the end', () => {
		expect(ids(replaceProject(rows, project('d')))).toEqual(['a', 'b', 'c', 'd'])
	})
})

describe('snapshotConversations', () => {
	it('keeps each project’s newest rows, newest first, and nothing from a missing project', () => {
		const rows = Array.from({ length: 20 }, (_, index) =>
			chat(
				`a${String(index).padStart(2, '0')}`,
				'a',
				`2026-10-${String(index + 1).padStart(2, '0')}`,
			),
		)
		const kept = snapshotConversations(
			[...rows, chat('m1', 'm', '2026-10-30'), chat('b1', 'b', '2026-09-01', { pinned: true })],
			[project('a'), project('b'), project('m', { missing: true })],
		)
		expect(kept.filter((row) => row.projectId === 'a')).toHaveLength(12)
		expect(kept.some((row) => row.projectId === 'm')).toBe(false)
		expect(kept[0]?.id).toBe('b1')
		expect(kept[0]).toEqual({
			id: 'b1',
			projectId: 'b',
			title: 'title b1',
			updatedAt: '2026-09-01',
			pinned: true,
		})
	})
})

describe('withRememberedRows', () => {
	const remembered = [chat('r1', 'a', '2026-10-02'), chat('r2', 'b', '2026-10-01')]
	it('shows the remembered rows of a project that has not answered', () => {
		const rows = withRememberedRows(
			[],
			remembered,
			new Map(),
			[project('a', { status: 'connecting', trusted: false }), project('b')],
			none,
		)
		expect(ids(rows)).toEqual(['r1', 'r2'])
	})
	it('replaces a project’s remembered rows with its live ones once it answers', () => {
		const live = [chat('r1', 'a', '2026-10-02', { title: 'new title' })]
		const rows = withRememberedRows(
			live,
			remembered,
			new Map([['a', 'listed' as const]]),
			[project('a'), project('b')],
			none,
		)
		expect(rows.find((row) => row.id === 'r1')?.title).toBe('new title')
		expect(ids(rows)).toEqual(['r1', 'r2'])
		const gone = withRememberedRows(
			[],
			remembered,
			new Map([['a', 'listed' as const]]),
			[project('a'), project('b')],
			none,
		)
		expect(ids(gone)).toEqual(['r2'])
	})
	it('drops rows of a project that failed, lost trust or was removed', () => {
		const rows = withRememberedRows(
			[],
			remembered,
			new Map(),
			[project('a', { status: 'error' }), project('b', { trusted: false })],
			none,
		)
		expect(rows).toEqual([])
		expect(
			withRememberedRows([], remembered, new Map(), [project('a'), project('b')], {
				conversations: new Set(['r1']),
				projects: new Set(['b']),
			}),
		).toEqual([])
	})
})

describe('stableConversationRows', () => {
	const delivered = (rows: readonly ConversationView[]): DeliveredKeys =>
		new Map(rows.map((row) => [row.id, { pinned: row.pinned === true, updatedAt: row.updatedAt }]))
	const first = [
		chat('b', 'p', '2026-10-05'),
		chat('c', 'p', '2026-10-04'),
		chat('d', 'p', '2026-10-03'),
	]
	it('shows everything when nothing is shown yet', () => {
		const rows = stableConversationRows(first, [], delivered(first), false)
		expect(ids(rows)).toEqual(['b', 'c', 'd'])
	})
	it('holds a newer delivered row back, then releases it when the start is over', () => {
		const incoming = [chat('a', 'p', '2026-10-09'), ...first]
		const during = stableConversationRows(incoming, first, delivered(incoming), false)
		expect(ids(during)).toEqual(['b', 'c', 'd'])
		expect(ids(stableConversationRows(incoming, first, delivered(incoming), true))).toEqual([
			'a',
			'b',
			'c',
			'd',
		])
	})
	it('appends a delivered row that sorts below every shown row', () => {
		const incoming = [...first, chat('e', 'p', '2026-10-01')]
		expect(ids(stableConversationRows(incoming, first, delivered(incoming), false))).toEqual([
			'b',
			'c',
			'd',
			'e',
		])
	})
	it('keeps a shown row’s place when a list repeats it with a newer time, and updates its title', () => {
		const incoming = [
			chat('b', 'p', '2026-10-05'),
			chat('c', 'p', '2026-10-04'),
			chat('d', 'p', '2026-10-08', { title: 'renamed elsewhere' }),
		]
		const rows = stableConversationRows(incoming, first, delivered(incoming), false)
		expect(ids(rows)).toEqual(['b', 'c', 'd'])
		expect(rows[2]?.title).toBe('renamed elsewhere')
	})
	it('lets a person’s pin take effect at once', () => {
		const keys = delivered(first)
		const pinned = first.map((row) => (row.id === 'd' ? { ...row, pinned: true as const } : row))
		expect(ids(stableConversationRows(pinned, first, keys, false))).toEqual(['d', 'b', 'c'])
	})
	it('lets a conversation a person made lead at once', () => {
		const made = [chat('z', 'p', '2026-10-12'), ...first]
		expect(ids(stableConversationRows(made, first, delivered(first), false))).toEqual([
			'z',
			'b',
			'c',
			'd',
		])
	})
	it('removes a row the live list says is gone without moving the others', () => {
		const incoming = [first[0] as ConversationView, first[2] as ConversationView]
		expect(ids(stableConversationRows(incoming, first, delivered(incoming), false))).toEqual([
			'b',
			'd',
		])
	})
})

describe('rows to remember', () => {
	const gone = { conversations: new Set<string>(), projects: new Set<string>() }
	const mk = (id: string, projectId: string) => chat(id, projectId, '2026-10-01T00:00:00Z')
	it('keeps the remembered rows of a project whose list failed', () => {
		const rows = rowsToRemember(
			[mk('a1', 'a')],
			[mk('a1', 'a'), mk('b1', 'b'), mk('c1', 'c')],
			new Map<string, ListOutcome>([
				['a', 'listed'],
				['b', 'failed'],
				['c', 'listed'],
			]),
			gone,
		)
		expect(rows.map((item) => item.id)).toEqual(['a1', 'b1'])
	})
	it('drops a conversation that was removed here', () => {
		const rows = rowsToRemember(
			[],
			[mk('b1', 'b')],
			new Map<string, ListOutcome>([['b', 'failed']]),
			{
				conversations: new Set(['b1']),
				projects: new Set(),
			},
		)
		expect(rows).toEqual([])
	})
})
