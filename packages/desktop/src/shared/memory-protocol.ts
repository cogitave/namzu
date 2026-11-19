/**
 * What the Namzu host says about the person's own memory: the standing instructions every
 * conversation starts from, and the memories saved for a project. The desktop half of
 * `packages/cli/src/commands/desktop-host-memory.ts`. Every answer is read before anything trusts
 * it: a field that is not what it should be is dropped, not guessed.
 */

export interface StandingInstructionsView {
	readonly text: string
	readonly limit: number
	/** The version read; a save names it and is refused when the file changed since. */
	readonly revision?: string
	/** A save was refused because the file changed since it was read; `text` is the current one. */
	readonly changed?: true
	/** The file cannot be edited here; the person edits it by hand. */
	readonly locked: boolean
}

export type SavedMemoryOrigin = 'you' | 'namzu' | 'conversation'
export type SavedMemoryState = 'active' | 'set-aside' | 'retired'

export interface SavedMemory {
	readonly id: string
	readonly title: string
	readonly type?: string
	readonly origin: SavedMemoryOrigin
	readonly state: SavedMemoryState
	readonly createdAt: number
	readonly updatedAt: number
	/** The version listed; an edit or a delete names it and is refused when the file changed since. */
	readonly revision: string
	readonly excerpt: string
}

export interface SavedMemoriesView {
	/** False when the folder has no project yet. */
	readonly project: boolean
	readonly memories: readonly SavedMemory[]
}

export type SavedMemoryDetail =
	| { found: false }
	| {
			found: true
			id: string
			title: string
			text: string
			revision: string
			updatedAt: number
	  }

export type SavedMemoryOutcome = 'updated' | 'deleted' | 'changed' | 'gone'

const MAX_MEMORIES = 2000
const MAX_TEXT = 100_000
const ORIGINS: readonly string[] = ['you', 'namzu', 'conversation']
const STATES: readonly string[] = ['active', 'set-aside', 'retired']

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown, max: number): string | undefined =>
	typeof value === 'string' && value.length <= max ? value : undefined
const time = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

export function readStandingInstructions(value: unknown): StandingInstructionsView {
	if (!isRecord(value)) throw new Error('Namzu answered in a way this app cannot read.')
	const text = str(value.text, MAX_TEXT)
	const limit = value.limit
	if (text === undefined || typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
		throw new Error('Namzu answered in a way this app cannot read.')
	const revision = str(value.revision, 200)
	return {
		text,
		limit,
		locked: value.locked === true,
		...(revision ? { revision } : {}),
		...(value.changed === true ? { changed: true as const } : {}),
	}
}

export function readSavedMemories(value: unknown): SavedMemoriesView {
	if (!isRecord(value) || !Array.isArray(value.memories))
		throw new Error('Namzu answered in a way this app cannot read.')
	const memories: SavedMemory[] = []
	for (const raw of value.memories.slice(0, MAX_MEMORIES)) {
		if (!isRecord(raw)) continue
		const id = str(raw.id, 200)
		const title = str(raw.title, 400)
		const revision = str(raw.revision, 200)
		if (!id || title === undefined || !revision) continue
		const origin = ORIGINS.includes(raw.origin as string)
			? (raw.origin as SavedMemoryOrigin)
			: 'conversation'
		const state = STATES.includes(raw.state as string) ? (raw.state as SavedMemoryState) : 'active'
		const type = str(raw.type, 40)
		memories.push({
			id,
			title,
			...(type ? { type } : {}),
			origin,
			state,
			createdAt: time(raw.createdAt),
			updatedAt: time(raw.updatedAt),
			revision,
			excerpt: str(raw.excerpt, 2000) ?? '',
		})
	}
	return { project: value.project === true, memories }
}

export function readSavedMemoryDetail(value: unknown): SavedMemoryDetail {
	if (!isRecord(value)) throw new Error('Namzu answered in a way this app cannot read.')
	if (value.found !== true) return { found: false }
	const id = str(value.id, 200)
	const title = str(value.title, 400)
	const text = str(value.text, MAX_TEXT)
	const revision = str(value.revision, 200)
	if (!id || title === undefined || text === undefined || !revision)
		throw new Error('Namzu answered in a way this app cannot read.')
	return { found: true, id, title, text, revision, updatedAt: time(value.updatedAt) }
}

export function readSavedMemoryOutcome(value: unknown): SavedMemoryOutcome {
	const outcome = isRecord(value) ? value.outcome : undefined
	if (outcome === 'updated' || outcome === 'deleted' || outcome === 'changed' || outcome === 'gone')
		return outcome
	throw new Error('Namzu answered in a way this app cannot read.')
}
