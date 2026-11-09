/**
 * What `/memory` lets a person do with stored memory: see every active
 * memory of the project, read one, and delete one or all of those the turns
 * recorded on their own. Curated files (MEMORY.md, USER.md) are not records
 * and never appear here.
 */

import { join } from 'node:path'

import {
	type MarkdownMemoryStore,
	type MemoryOrigin,
	MemoryRevisionConflictError,
	type MemoryType,
	memoryOrigin,
} from '@namzu/sdk'

import { preview } from './presentation.js'

const DAY_MS = 86_400_000

type MemoryId = Parameters<MarkdownMemoryStore['delete']>[0]

export interface ManagedMemory {
	readonly id: MemoryId
	readonly name: string | undefined
	readonly title: string
	readonly type: MemoryType | undefined
	readonly origin: MemoryOrigin
	readonly createdAt: number
	readonly updatedAt: number
	/** The exact version listed; a delete refuses when the file changed since. */
	readonly revision: string
	readonly path: string
}

export type DeleteOutcome = 'deleted' | 'changed' | 'gone'

/** Active memories of the project, in the order the picker shows them. */
export async function loadManagedMemories(
	store: MarkdownMemoryStore,
	directory: string,
): Promise<readonly ManagedMemory[]> {
	const { entries } = await store.list({ status: 'active' })
	const items: ManagedMemory[] = []
	for (const entry of entries) {
		const record = await store.getVersionedRecord(entry.id)
		if (!record || record.entry.status !== 'active') continue
		items.push({
			id: record.entry.id,
			name: record.entry.name,
			title: record.entry.title,
			type: record.entry.type,
			origin: memoryOrigin(record.content.metadata),
			createdAt: record.entry.createdAt,
			updatedAt: record.entry.updatedAt,
			revision: record.revision,
			path: record.entry.name ? join(directory, `${record.entry.name}.md`) : directory,
		})
	}
	return sortManagedMemories(items)
}

const ORIGIN_RANK: Record<MemoryOrigin, number> = {
	operator: 0,
	model: 1,
	derived: 2,
}

/** Chosen memories first (yours, then Namzu's), then recorded by turns; newest first within each. */
export function sortManagedMemories(items: readonly ManagedMemory[]): readonly ManagedMemory[] {
	return [...items].sort(
		(a, b) =>
			ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] ||
			b.updatedAt - a.updatedAt ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	)
}

export function originLabel(origin: MemoryOrigin): string {
	return origin === 'operator' ? 'you' : origin === 'model' ? 'Namzu saved' : 'recorded by a turn'
}

export function ageLabel(updatedAt: number, now: number = Date.now()): string {
	const days = Math.max(0, Math.floor((now - updatedAt) / DAY_MS))
	if (days === 0) return 'today'
	return `${days} day${days === 1 ? '' : 's'} ago`
}

export function memoryLabel(item: ManagedMemory): string {
	const line = (item.title.trim() || item.name || item.id).replace(/\s+/g, ' ')
	return line
}

export function memoryDescription(item: ManagedMemory, now: number = Date.now()): string {
	return [originLabel(item.origin), item.type, ageLabel(item.updatedAt, now)]
		.filter((part): part is string => Boolean(part))
		.join(' · ')
}

export interface MemoryChoice {
	readonly label: string
	readonly description: string
}

export const DELETE_ALL_RECORDED = '__delete-all-recorded__'
export const DELETE_ALL = '__delete-all__'

export function recordedMemories(items: readonly ManagedMemory[]): readonly ManagedMemory[] {
	return items.filter((item) => item.origin === 'derived')
}

/**
 * The list picker: a row that deletes every memory, a row that deletes those
 * turns recorded when only some were, then every memory.
 */
export function memoryListChoices(
	items: readonly ManagedMemory[],
	now: number = Date.now(),
): {
	readonly values: readonly string[]
	readonly options: readonly MemoryChoice[]
} {
	const values: string[] = []
	const options: MemoryChoice[] = []
	const recorded = recordedMemories(items).length
	if (items.length > 0) {
		values.push(DELETE_ALL)
		options.push({
			label: items.length === 1 ? 'Delete the 1 memory' : `Delete all ${items.length} memories`,
			description: 'Every memory of this project, also those you or Namzu saved.',
		})
	}
	if (recorded > 0 && recorded < items.length) {
		values.push(DELETE_ALL_RECORDED)
		options.push({
			label:
				recorded === 1
					? 'Delete the 1 memory recorded by a turn'
					: `Delete all ${recorded} memories recorded by turns`,
			description: 'Memories you or Namzu saved stay.',
		})
	}
	for (const item of sortManagedMemories(items)) {
		values.push(item.id)
		options.push({
			label: memoryLabel(item),
			description: memoryDescription(item, now),
		})
	}
	return { values, options }
}

/** An exact name or id among the active memories; several may share a title, so a name is not title-matched. */
export function matchMemories(
	items: readonly ManagedMemory[],
	query: string,
): readonly ManagedMemory[] {
	const wanted = query.trim().toLowerCase()
	if (!wanted) return []
	return items.filter(
		(item) => String(item.id).toLowerCase() === wanted || item.name?.toLowerCase() === wanted,
	)
}

export function listMatches(items: readonly ManagedMemory[]): string {
	return items.map((item) => `  ${item.name ?? item.id} · ${memoryLabel(item)}`).join('\n')
}

export function renderMemoryDetail(item: ManagedMemory, body: string): string {
	const stamp = (value: number): string =>
		new Date(value).toISOString().slice(0, 16).replace('T', ' ')
	return [
		memoryLabel(item),
		`Written by: ${originLabel(item.origin)}`,
		...(item.type ? [`Type: ${item.type}`] : []),
		`Created: ${stamp(item.createdAt)}`,
		`Updated: ${stamp(item.updatedAt)}`,
		`File: ${item.path}`,
		'',
		preview(body, item.path),
	].join('\n')
}

export async function readMemoryBody(
	store: MarkdownMemoryStore,
	id: MemoryId,
): Promise<string | undefined> {
	return (await store.get(id))?.content
}

/** Delete exactly the version that was listed; a record that changed meanwhile stays. */
export async function deleteManagedMemory(
	store: MarkdownMemoryStore,
	item: ManagedMemory,
): Promise<DeleteOutcome> {
	try {
		await store.deleteIfRevision(item.id, item.revision)
		return 'deleted'
	} catch (error) {
		if (!(error instanceof MemoryRevisionConflictError)) throw error
		return (await store.getRecord(item.id)) ? 'changed' : 'gone'
	}
}

export interface BulkDeleteResult {
	readonly deleted: number
	/** Changed since they were listed, so they stayed. */
	readonly kept: number
}

/** Delete each listed memory at the version listed; one changed meanwhile stays. */
export async function deleteMemories(
	store: MarkdownMemoryStore,
	items: readonly ManagedMemory[],
): Promise<BulkDeleteResult> {
	let deleted = 0
	let kept = 0
	for (const item of items) {
		const outcome = await deleteManagedMemory(store, item)
		if (outcome === 'deleted') deleted += 1
		else if (outcome === 'changed') kept += 1
	}
	return { deleted, kept }
}

export function deleteRecordedMemories(
	store: MarkdownMemoryStore,
	items: readonly ManagedMemory[],
): Promise<BulkDeleteResult> {
	return deleteMemories(store, recordedMemories(items))
}

/** The key the SDK's memory recall records its context entries under. */
export const RECALLED_MEMORY_KEY = 'memory'

/**
 * Whether a recorded memory context entry still carries the record. Recall
 * writes one JSON line per record; any version of the id counts, since the
 * copy the model holds stays after the file is gone.
 */
export function historyHoldsMemory(entries: readonly string[], item: ManagedMemory): boolean {
	for (const entry of entries) {
		for (const line of entry.split('\n')) {
			if (!line.startsWith('{')) continue
			try {
				if ((JSON.parse(line) as { id?: unknown }).id === item.id) return true
			} catch {
				// a line of the entry that is not a record
			}
		}
	}
	return false
}

export function historyHoldsAnyMemory(
	entries: readonly string[],
	items: readonly ManagedMemory[],
): boolean {
	return items.some((item) => historyHoldsMemory(entries, item))
}

export function deletedLine(item: ManagedMemory, inHistory = false): string {
	const line = `Deleted “${memoryLabel(item)}”. Namzu will not recall it again.`
	return inHistory
		? `${line} This conversation already has it; /clear starts fresh without it.`
		: line
}

export function deleteOutcomeLine(
	item: ManagedMemory,
	outcome: DeleteOutcome,
	inHistory = false,
): string {
	if (outcome === 'deleted') return deletedLine(item, inHistory)
	if (outcome === 'changed')
		return `“${memoryLabel(item)}” changed since it was listed, so it was kept. /memory lists it again.`
	return `“${memoryLabel(item)}” was already gone.`
}

const memories = (n: number): string => `${n} ${n === 1 ? 'memory' : 'memories'}`

function bulkLine(done: string, result: BulkDeleteResult, inHistory: boolean): string {
	const kept = result.kept > 0 ? ` ${memories(result.kept)} changed meanwhile and stayed.` : ''
	const history = !inHistory
		? ''
		: result.deleted === 1
			? ' This conversation already has it; /clear starts fresh without it.'
			: ' This conversation already has some of them; /clear starts fresh without them.'
	return `${done}${kept}${history}`
}

export function deleteRecordedLine(result: BulkDeleteResult, inHistory = false): string {
	return bulkLine(`Deleted ${memories(result.deleted)} recorded by turns.`, result, inHistory)
}

export function deleteAllLine(result: BulkDeleteResult, inHistory = false): string {
	const them = result.deleted === 1 ? 'it' : 'them'
	return bulkLine(
		`Deleted ${memories(result.deleted)}. Namzu will not recall ${them} again.`,
		result,
		inHistory,
	)
}
