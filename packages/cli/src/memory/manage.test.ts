import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MarkdownMemoryStore } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	DELETE_ALL_RECORDED,
	ageLabel,
	deleteManagedMemory,
	deleteOutcomeLine,
	deleteRecordedLine,
	deleteRecordedMemories,
	historyHoldsMemory,
	listMatches,
	loadManagedMemories,
	matchMemories,
	memoryDescription,
	memoryListChoices,
	readMemoryBody,
	renderMemoryDetail,
} from './manage.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function tempStore(): { store: MarkdownMemoryStore; directory: string } {
	const directory = mkdtempSync(join(tmpdir(), 'namzu-memory-manage-'))
	roots.push(directory)
	return { store: new MarkdownMemoryStore({ directory }), directory }
}

async function seed(store: MarkdownMemoryStore) {
	const mine = await store.create({
		title: 'Use pnpm',
		summary: 'pnpm for tests',
		content: 'Run pnpm test.',
		name: 'use-pnpm',
		type: 'project',
	})
	const saved = await store.create({
		title: 'Answer tersely',
		summary: 'terse',
		content: 'Keep replies short.',
		name: 'answer-tersely',
		type: 'feedback',
		metadata: { source: 'agent-memory' },
	})
	const recorded = await store.create({
		title: 'Fixed the flake',
		summary: 'a turn',
		content: 'The turn fixed a flaky test.',
		name: 'fixed-the-flake',
		type: 'project',
		metadata: { source: 'session-memory' },
	})
	return { mine, saved, recorded }
}

describe('loadManagedMemories', () => {
	it('lists chosen memories before recorded ones, with who wrote each', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const items = await loadManagedMemories(store, directory)
		expect(items.map((item) => [item.name, item.origin])).toEqual([
			['use-pnpm', 'operator'],
			['answer-tersely', 'model'],
			['fixed-the-flake', 'derived'],
		])
		expect(items[0]?.path).toBe(join(directory, 'use-pnpm.md'))
	})

	it('leaves archived memories out', async () => {
		const { store, directory } = tempStore()
		const { mine } = await seed(store)
		await store.update(mine.entry.id, { status: 'archived' })
		const items = await loadManagedMemories(store, directory)
		expect(items.map((item) => item.name)).not.toContain('use-pnpm')
	})
})

describe('memoryListChoices', () => {
	it('puts the bulk row first only when turns recorded memories, and words each row plainly', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const items = await loadManagedMemories(store, directory)
		const now = Date.now()
		const { values, options } = memoryListChoices(items, now)
		expect(values[0]).toBe(DELETE_ALL_RECORDED)
		expect(options[0]?.label).toBe('Delete all 1 recorded by turns')
		expect(options.slice(1).map((option) => option.label)).toEqual([
			'Use pnpm',
			'Answer tersely',
			'Fixed the flake',
		])
		expect(options.slice(1).map((option) => option.description)).toEqual([
			'you · project · today',
			'Namzu saved · feedback · today',
			'recorded by a turn · project · today',
		])
		const chosen = items.filter((item) => item.origin !== 'derived')
		expect(memoryListChoices(chosen, now).values).not.toContain(DELETE_ALL_RECORDED)
	})

	it('orders newest first within a group', () => {
		const base = {
			name: undefined,
			type: undefined,
			createdAt: 0,
			revision: 'r',
			path: '/d',
		} as const
		const { values } = memoryListChoices([
			{
				...base,
				id: 'old' as never,
				title: 'a',
				origin: 'operator',
				updatedAt: 1,
			},
			{
				...base,
				id: 'new' as never,
				title: 'b',
				origin: 'operator',
				updatedAt: 2,
			},
			{
				...base,
				id: 'rec' as never,
				title: 'c',
				origin: 'derived',
				updatedAt: 9,
			},
		])
		expect(values).toEqual([DELETE_ALL_RECORDED, 'new', 'old', 'rec'])
	})
})

describe('ageLabel', () => {
	it('says today, then days', () => {
		const now = Date.UTC(2026, 10, 8)
		expect(ageLabel(now - 1000, now)).toBe('today')
		expect(ageLabel(now - 86_400_000, now)).toBe('1 day ago')
		expect(ageLabel(now - 3 * 86_400_000, now)).toBe('3 days ago')
	})
})

describe('matchMemories', () => {
	it('matches an exact name or id, and several when asked loosely twice', async () => {
		const { store, directory } = tempStore()
		const { mine } = await seed(store)
		const items = await loadManagedMemories(store, directory)
		expect(matchMemories(items, 'use-pnpm')).toHaveLength(1)
		expect(matchMemories(items, 'USE-PNPM')).toHaveLength(1)
		expect(matchMemories(items, mine.entry.id)).toHaveLength(1)
		expect(matchMemories(items, 'pnpm')).toHaveLength(0)
		expect(matchMemories(items, '')).toHaveLength(0)
		expect(listMatches(items)).toContain('use-pnpm · Use pnpm')
	})
})

describe('deleting', () => {
	it('removes the file of one memory and keeps the others', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const items = await loadManagedMemories(store, directory)
		const target = items.find((item) => item.name === 'use-pnpm')
		if (!target) throw new Error('seed missing')
		expect(await deleteManagedMemory(store, target)).toBe('deleted')
		expect(existsSync(join(directory, 'use-pnpm.md'))).toBe(false)
		expect(readdirSync(directory)).toContain('answer-tersely.md')
		expect(deleteOutcomeLine(target, 'deleted')).toBe(
			'Deleted “Use pnpm”. Namzu will not recall it again.',
		)
		expect(await deleteManagedMemory(store, target)).toBe('gone')
	})

	it('says when the conversation already holds the deleted record', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const items = await loadManagedMemories(store, directory)
		const target = items.find((item) => item.name === 'use-pnpm')
		if (!target) throw new Error('seed missing')
		const entry = `header\n${JSON.stringify({ id: target.id, updatedAt: 1 })}`
		expect(historyHoldsMemory([entry], target)).toBe(true)
		expect(historyHoldsMemory(['{"id":"other","updatedAt":1}', 'plain'], target)).toBe(false)
		expect(deleteOutcomeLine(target, 'deleted', true)).toContain('/clear starts fresh without it.')
		expect(deleteOutcomeLine(target, 'deleted', false)).not.toContain('/clear')
	})

	it('keeps a memory that changed after it was listed', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const items = await loadManagedMemories(store, directory)
		const target = items.find((item) => item.name === 'use-pnpm')
		if (!target) throw new Error('seed missing')
		await store.update(target.id, { content: 'Run pnpm lint too.' })
		expect(await deleteManagedMemory(store, target)).toBe('changed')
		expect(existsSync(join(directory, 'use-pnpm.md'))).toBe(true)
		expect(deleteOutcomeLine(target, 'changed')).toContain('changed since it was listed')
	})

	it('deletes only the recorded ones in bulk, and counts those that changed', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const extra = await store.create({
			title: 'Another turn',
			summary: 's',
			content: 'c',
			name: 'another-turn',
			metadata: { source: 'session-memory' },
		})
		const items = await loadManagedMemories(store, directory)
		await store.update(extra.entry.id, { content: 'changed meanwhile' })
		const result = await deleteRecordedMemories(store, items)
		expect(result).toEqual({ deleted: 1, kept: 1 })
		expect(
			readdirSync(directory)
				.filter((file) => file.endsWith('.md'))
				.sort(),
		).toEqual(['MEMORY.md', 'another-turn.md', 'answer-tersely.md', 'use-pnpm.md'].sort())
		expect(deleteRecordedLine(result)).toBe(
			'Deleted 1 memory recorded by turns. 1 memory changed meanwhile and stayed.',
		)
		expect(deleteRecordedLine({ deleted: 3, kept: 0 })).toBe(
			'Deleted 3 memories recorded by turns.',
		)
	})
})

describe('renderMemoryDetail', () => {
	it('shows who wrote it, the file and the body', async () => {
		const { store, directory } = tempStore()
		await seed(store)
		const [first] = await loadManagedMemories(store, directory)
		if (!first) throw new Error('seed missing')
		const body = await readMemoryBody(store, first.id)
		const text = renderMemoryDetail(first, body ?? '')
		expect(text).toContain('Use pnpm')
		expect(text).toContain('Written by: you')
		expect(text).toContain(`File: ${join(directory, 'use-pnpm.md')}`)
		expect(text).toContain('Run pnpm test.')
		expect(memoryDescription(first)).toBe('you · project · today')
	})
})
