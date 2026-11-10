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
import { RETIRED_DUPLICATE, isUnused, retiredReasonOf } from './sweep.js'
import type { MemoryUsage } from './usage.js'

const DAY_MS = 86_400_000

type MemoryId = Parameters<MarkdownMemoryStore['delete']>[0]

/**
 * `active`: recall may offer it. `set-aside`: a refused request carried it, so
 * recall does not offer it until it is restored. `retired`: the sweep archived
 * it. Retired and set-aside memories stay on disk.
 */
export type ManagedMemoryState = 'active' | 'set-aside' | 'retired'

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
	/** The title of the memory this one replaced, when the small model superseded one. */
	readonly replaces?: string
	/** Absent means `active`. */
	readonly state?: ManagedMemoryState
	/** Why the sweep retired it. Only with `state: 'retired'`. */
	readonly retiredReason?: string
	/** A retired memory a refused request had also set aside: restoring lifts both. */
	readonly alsoSetAside?: true
	/** You or Namzu saved it and it has not been recalled for a long time. Nothing was changed. */
	readonly possiblyStale?: true
}

export interface ManagedMemoryLookups {
	readonly usage?: MemoryUsage
	readonly now?: number
	/** Days; with `usage`, marks a memory you or Namzu saved that recall has not offered for that long. */
	readonly retireAfterDays?: number
}

export type DeleteOutcome = 'deleted' | 'changed' | 'gone'

/**
 * The memories of the project, in the order the picker shows them: those
 * recall may offer, those a refused request set aside, and those the sweep
 * retired.
 */
export async function loadManagedMemories(
	store: MarkdownMemoryStore,
	directory: string,
	lookups: ManagedMemoryLookups = {},
): Promise<readonly ManagedMemory[]> {
	const items: ManagedMemory[] = []
	const { usage } = lookups
	const at = lookups.now ?? Date.now()
	for (const status of ['active', 'archived'] as const) {
		const { entries } = await store.list({ status })
		for (const entry of entries) {
			const record = await store.getVersionedRecord(entry.id)
			if (!record || record.entry.status !== status) continue
			const metadata = record.content.metadata
			const retiredReason = status === 'archived' ? retiredReasonOf(metadata) : undefined
			// An archived record the sweep did not retire was put away on purpose.
			if (status === 'archived' && retiredReason === undefined) continue
			const origin = memoryOrigin(metadata)
			const supersedes = metadata?.supersedes
			const replaced =
				typeof supersedes === 'string'
					? (await store.getRecord(supersedes as MemoryId))?.entry.title
					: undefined
			const state: ManagedMemoryState =
				status === 'archived' ? 'retired' : usage?.isSetAside(entry.id) ? 'set-aside' : 'active'
			const stale =
				status === 'active' &&
				origin !== 'derived' &&
				usage !== undefined &&
				lookups.retireAfterDays !== undefined &&
				lookups.retireAfterDays > 0 &&
				usage.state === 'known' &&
				isUnused({
					usage,
					id: entry.id,
					touchedAt: record.entry.updatedAt,
					at,
					retireAfterDays: lookups.retireAfterDays,
				})
			items.push({
				id: record.entry.id,
				name: record.entry.name,
				title: record.entry.title,
				type: record.entry.type,
				origin,
				createdAt: record.entry.createdAt,
				updatedAt: record.entry.updatedAt,
				revision: record.revision,
				path: record.entry.name ? join(directory, `${record.entry.name}.md`) : directory,
				...(replaced ? { replaces: replaced } : {}),
				...(state !== 'active' ? { state } : {}),
				...(retiredReason !== undefined ? { retiredReason } : {}),
				...(state === 'retired' && usage?.isSetAside(entry.id)
					? { alsoSetAside: true as const }
					: {}),
				...(stale ? { possiblyStale: true as const } : {}),
			})
		}
	}
	return sortManagedMemories(items)
}

const STATE_RANK: Record<ManagedMemoryState, number> = { active: 0, 'set-aside': 1, retired: 2 }

const ORIGIN_RANK: Record<MemoryOrigin, number> = {
	operator: 0,
	model: 1,
	derived: 2,
}

/** Chosen memories first (yours, then Namzu's), then recorded by turns; newest first within each. */
export function sortManagedMemories(items: readonly ManagedMemory[]): readonly ManagedMemory[] {
	return [...items].sort(
		(a, b) =>
			STATE_RANK[a.state ?? 'active'] - STATE_RANK[b.state ?? 'active'] ||
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

/** The marker a set-aside, retired or possibly stale memory carries in lists. */
export function stateLabel(item: ManagedMemory): string | undefined {
	if (item.state === 'set-aside') return 'set aside: a refused request carried it'
	if (item.state === 'retired') {
		const why =
			item.retiredReason === RETIRED_DUPLICATE ? 'a newer copy exists' : 'not recalled for a while'
		return item.alsoSetAside ? `retired and set aside: ${why}` : `retired: ${why}`
	}
	return item.possiblyStale ? 'possibly stale: not recalled for a while' : undefined
}

export function memoryDescription(item: ManagedMemory, now: number = Date.now()): string {
	return [stateLabel(item), originLabel(item.origin), item.type, ageLabel(item.updatedAt, now)]
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
		...(stateLabel(item) ? [`State: ${stateLabel(item)}`] : []),
		...(item.replaces ? [`Replaced: ${item.replaces.replace(/\s+/g, ' ').trim()}`] : []),
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

export type RestoreOutcome = 'restored' | 'changed' | 'gone' | 'not-needed'

/**
 * Bring a set-aside or retired memory back. A set-aside one is offered by
 * recall again; a retired one becomes active, without the marks the sweep
 * left, and lifted from the set-aside too when a refusal had set it aside. A record changed since it was listed stays as it is.
 */
export async function restoreManagedMemory(
	store: MarkdownMemoryStore,
	item: ManagedMemory,
	liftSetAside: (id: string) => Promise<void>,
): Promise<RestoreOutcome> {
	if (item.state === 'set-aside') {
		await liftSetAside(item.id)
		return 'restored'
	}
	if (item.state !== 'retired') return 'not-needed'
	try {
		const record = await store.getVersionedRecord(item.id)
		if (!record) return 'gone'
		const { retiredAt: _at, retiredReason: _reason, ...rest } = record.content.metadata ?? {}
		await store.updateIfRevision(item.id, { status: 'active', metadata: rest }, item.revision)
		// A refusal may have set it aside before the sweep retired it; recall
		// would still skip it. Harmless when it was not set aside.
		await liftSetAside(item.id)
		return 'restored'
	} catch (error) {
		if (!(error instanceof MemoryRevisionConflictError)) throw error
		return (await store.getRecord(item.id)) ? 'changed' : 'gone'
	}
}

export function restoreOutcomeLine(item: ManagedMemory, outcome: RestoreOutcome): string {
	if (outcome === 'restored') return `Restored “${memoryLabel(item)}”. Namzu may recall it again.`
	if (outcome === 'changed')
		return `“${memoryLabel(item)}” changed since it was listed, so it was left as it was. /memory lists it again.`
	if (outcome === 'gone') return `“${memoryLabel(item)}” was already gone.`
	return `“${memoryLabel(item)}” needs no restoring.`
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
