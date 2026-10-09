import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelCatalogueView } from '../shared/protocol.js'

const FILE = 'model-lists.json'
const VERSION = 1
const MAX_BYTES = 1024 * 1024
const MAX_ENTRIES = 64
const MAX_MODELS = 4096

type Rows = ModelCatalogueView['models']

export interface StoredModelList {
	/** Exactly the rows `models()` returned to the renderer; no credential or account data. */
	rows: { models: Rows; notice: string | null }
	/** Epoch milliseconds of the last successful read. */
	fetchedAt: number
	/** ISO time each model id was first seen. Empty on the very first store for a key. */
	firstSeen: Record<string, string>
}

export interface ModelListFs {
	mkdirSync(path: string): void
	readFileSync(path: string): Buffer
	statSync(path: string): { size: number }
	writeFileSync(path: string, data: string): void
	renameSync(from: string, to: string): void
	unlinkSync(path: string): void
}

const realFs: ModelListFs = {
	mkdirSync: (path) => void mkdirSync(path, { recursive: true }),
	readFileSync: (path) => readFileSync(path),
	statSync: (path) => statSync(path),
	writeFileSync: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
	renameSync,
	unlinkSync,
}

/**
 * The key names the list's source and the credential path it was read through. The
 * provider status exposes only an id and a label (its `defaultModel` echoes the current
 * choice, so it is left out); session ids are never part of it.
 */
export function modelListKey(input: {
	engine: string
	id: string
	label: string
	/** The engine build behind the row. A new build is a new key, so an upgrade drops the old list. */
	identity?: string
}): string {
	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify(
				input.identity === undefined
					? [input.engine, input.id, input.label]
					: [input.engine, input.id, input.label, input.identity],
			),
		)
		.digest('hex')
		.slice(0, 16)
	return `${input.engine}/${input.id}/${fingerprint}`
}

function plain(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validRows(value: unknown): value is StoredModelList['rows'] {
	if (!plain(value) || !Array.isArray(value.models) || value.models.length > MAX_MODELS)
		return false
	if (value.notice !== null && typeof value.notice !== 'string') return false
	return value.models.every(
		(model) =>
			plain(model) &&
			typeof model.id === 'string' &&
			model.id.length > 0 &&
			model.id.length <= 400 &&
			typeof model.label === 'string' &&
			(model.note === undefined || typeof model.note === 'string') &&
			(model.default === undefined || model.default === true) &&
			(model.current === undefined || model.current === true) &&
			(model.group === undefined || model.group === 'free' || model.group === 'key'),
	)
}

function validEntry(value: unknown): value is StoredModelList {
	if (!plain(value) || !validRows(value.rows)) return false
	if (typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) return false
	return (
		plain(value.firstSeen) &&
		Object.values(value.firstSeen).every(
			(seen) => typeof seen === 'string' && !Number.isNaN(Date.parse(seen)),
		)
	)
}

/** Only the fields the renderer is allowed to see, so a foreign extra key never rides along. */
function cleanRows(rows: StoredModelList['rows']): StoredModelList['rows'] {
	return {
		models: rows.models.map((model) => ({
			id: model.id,
			label: model.label,
			...(model.note === undefined ? {} : { note: model.note }),
			...(model.default ? { default: true as const } : {}),
			...(model.current ? { current: true as const } : {}),
			...(model.group === undefined ? {} : { group: model.group }),
		})),
		notice: rows.notice,
	}
}

export function sameRows(a: StoredModelList['rows'], b: StoredModelList['rows']): boolean {
	return JSON.stringify(cleanRows(a)) === JSON.stringify(cleanRows(b))
}

/** Last good model lists in the app's userData, read once and rewritten atomically. */
export class ModelListStore {
	private readonly file: string
	private entries?: Map<string, StoredModelList>

	constructor(
		private readonly directory: string,
		private readonly options: {
			now?: () => number
			fs?: ModelListFs
			/** Told about a failed write; the in-memory lists stay usable. */
			onError?: (error: unknown) => void
		} = {},
	) {
		this.file = join(directory, FILE)
	}

	private get fs(): ModelListFs {
		return this.options.fs ?? realFs
	}

	private load(): Map<string, StoredModelList> {
		if (this.entries) return this.entries
		const entries = new Map<string, StoredModelList>()
		this.entries = entries
		try {
			if (this.fs.statSync(this.file).size > MAX_BYTES) return entries
			const parsed: unknown = JSON.parse(this.fs.readFileSync(this.file).toString('utf8'))
			if (!plain(parsed) || parsed.version !== VERSION || !plain(parsed.entries)) return entries
			const found = Object.entries(parsed.entries)
			if (found.length > MAX_ENTRIES || !found.every(([, entry]) => validEntry(entry)))
				return entries
			for (const [key, entry] of found as [string, StoredModelList][])
				entries.set(key, {
					rows: cleanRows(entry.rows),
					fetchedAt: entry.fetchedAt,
					firstSeen: { ...entry.firstSeen },
				})
		} catch {
			// A missing, unreadable or foreign file is ignored; the next success rewrites it.
			entries.clear()
		}
		return entries
	}

	get(key: string): StoredModelList | undefined {
		return this.load().get(key)
	}

	/**
	 * Records a successful read. Returns whether the rows differ from the previous list for
	 * this key (a first store is not a change: nobody was shown anything before).
	 */
	put(key: string, rows: StoredModelList['rows']): { changed: boolean; entry: StoredModelList } {
		const entries = this.load()
		const now = (this.options.now ?? Date.now)()
		const previous = entries.get(key)
		const next = cleanRows(rows)
		const stamp = new Date(now).toISOString()
		const known = new Set(previous?.rows.models.map((model) => model.id))
		const seen: [string, string][] = []
		// Nothing is new on a key's first store; later, an id absent before is stamped once.
		if (previous)
			for (const model of next.models) {
				const earlier = Object.hasOwn(previous.firstSeen, model.id)
					? previous.firstSeen[model.id]
					: undefined
				if (earlier !== undefined) seen.push([model.id, earlier])
				else if (!known.has(model.id)) seen.push([model.id, stamp])
			}
		const firstSeen = Object.fromEntries(seen)
		const entry: StoredModelList = { rows: next, fetchedAt: now, firstSeen }
		const changed = previous !== undefined && !sameRows(previous.rows, next)
		entries.delete(key)
		entries.set(key, entry)
		this.trim(entries, key)
		this.persist(entries)
		return { changed, entry }
	}

	/**
	 * Drops every list of this engine whose key is not in `keep`. The provider status is the
	 * only sign of a sign-out or an account change, so a list for a row that is gone, or whose
	 * row changed, must not outlive it and be shown to whoever signs in next.
	 */
	prune(engine: string, keep: ReadonlySet<string>): boolean {
		const entries = this.load()
		let removed = false
		for (const key of [...entries.keys()])
			if (key.startsWith(`${engine}/`) && !keep.has(key)) {
				entries.delete(key)
				removed = true
			}
		if (removed) this.persist(entries)
		return removed
	}

	/** Drops every list of this engine, whatever build it came from: the engine itself changed. */
	forgetEngine(engine: string): boolean {
		const entries = this.load()
		let removed = false
		for (const key of [...entries.keys()])
			if (key.startsWith(`${engine}/`)) {
				entries.delete(key)
				removed = true
			}
		if (removed) this.persist(entries)
		return removed
	}

	private trim(entries: Map<string, StoredModelList>, keep: string): void {
		const order = () => [...entries].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
		while (entries.size > MAX_ENTRIES) {
			const oldest = order().find(([key]) => key !== keep)
			if (!oldest) break
			entries.delete(oldest[0])
		}
		while (this.serialize(entries).length > MAX_BYTES) {
			const oldest = order().find(([key]) => key !== keep)
			if (!oldest) {
				// One list alone is over the cap; it is not worth keeping.
				entries.delete(keep)
				break
			}
			entries.delete(oldest[0])
		}
	}

	private serialize(entries: Map<string, StoredModelList>): string {
		return JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) })
	}

	private persist(entries: Map<string, StoredModelList>): void {
		// Per process, so two app instances never rename each other's half-written file.
		const temporary = `${this.file}.${process.pid}.tmp`
		try {
			this.fs.mkdirSync(this.directory)
			this.fs.writeFileSync(temporary, this.serialize(entries))
			this.fs.renameSync(temporary, this.file)
		} catch (error) {
			try {
				this.fs.unlinkSync(temporary)
			} catch {
				/* Nothing was written. */
			}
			this.options.onError?.(error)
		}
	}
}
