/**
 * What recall has done with each memory, kept beside the records and never in
 * them.
 *
 * A counter inside a record would rewrite it: that moves its `updatedAt` and
 * its revision, recall would then offer it again as new, and a person's
 * delete or edit in `/memory` would conflict with a bump nobody asked for. So
 * the counters live in one JSON file per project,
 * `<home>/memory-usage/<project>.json`:
 *
 * - `recalls`, `selected`, `lastRecalledAt` for each id the terminal saw
 *   recalled;
 * - `brokenSince`, when recall first found that a file a record names is gone
 *   (see `anchors.ts`); the idle sweep retires a record whose
 *   file stayed gone for a while. A file that only changed never starts it;
 * - `setAside`, the ids a refused request carried. Recall never offers them
 *   again until the person restores them in `/memory`;
 * - `since`, when this file started counting.
 *
 * A file that is missing or cannot be read says nothing about use. It is
 * `unknown`, never "unused": the sweep leaves every record alone for that run.
 * A file that cannot be read is moved aside, not overwritten.
 *
 * Changes are held in memory and written together, by a flush at turn release
 * and when idle. A flush reads the file again, applies the changes made here
 * on top of whatever another terminal wrote, writes a temporary file and
 * renames it over the sidecar, so a reader sees the old file or the new one.
 *
 * Pure of the terminal: the clock and the files are handed in.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LogAttributes } from '@namzu/sdk'

const VERSION = 1

export interface UsageCounters {
	readonly recalls: number
	readonly selected: number
	readonly lastRecalledAt: number
	/** When recall first found a file the record names gone; absent while it is there. */
	readonly brokenSince?: number
}

export interface SetAside {
	readonly at: number
	readonly reason: 'refused'
}

interface UsageFile {
	readonly version: typeof VERSION
	readonly since: number
	readonly records: Readonly<Record<string, UsageCounters>>
	readonly setAside: Readonly<Record<string, SetAside>>
}

export type UsageState = 'unknown' | 'known'

export interface UsageFs {
	readFile(path: string): Promise<string>
	writeFile(path: string, data: string): Promise<void>
	rename(from: string, to: string): Promise<void>
	mkdir(path: string): Promise<void>
	rm(path: string): Promise<void>
}

export const nodeUsageFs: UsageFs = {
	readFile: (path) => readFile(path, 'utf8'),
	writeFile: (path, data) => writeFile(path, data, { mode: 0o600 }),
	rename,
	mkdir: async (path) => {
		await mkdir(path, { recursive: true, mode: 0o700 })
	},
	rm: (path) => rm(path, { force: true }),
}

export interface MemoryUsageDeps {
	readonly file: string
	readonly now: () => number
	readonly fs?: UsageFs
	/** Counts and codes only; never a title or a claim. */
	readonly log?: (message: string, fields: LogAttributes) => void
}

interface Delta {
	recalls: number
	selected: number
	lastRecalledAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** The parsed file, or undefined when it is not one this version wrote. */
function parse(text: string): UsageFile | undefined {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return undefined
	}
	if (!isRecord(raw) || raw.version !== VERSION) return undefined
	const since = count(raw.since)
	if (since === undefined || !isRecord(raw.records) || !isRecord(raw.setAside)) return undefined
	const records: Record<string, UsageCounters> = {}
	for (const [id, value] of Object.entries(raw.records)) {
		if (!isRecord(value)) return undefined
		const recalls = count(value.recalls)
		const selected = count(value.selected)
		const lastRecalledAt = count(value.lastRecalledAt)
		if (recalls === undefined || selected === undefined || lastRecalledAt === undefined)
			return undefined
		const brokenSince = value.brokenSince === undefined ? undefined : count(value.brokenSince)
		if (value.brokenSince !== undefined && brokenSince === undefined) return undefined
		records[id] = {
			recalls,
			selected,
			lastRecalledAt,
			...(brokenSince === undefined ? {} : { brokenSince }),
		}
	}
	const setAside: Record<string, SetAside> = {}
	for (const [id, value] of Object.entries(raw.setAside)) {
		if (!isRecord(value)) return undefined
		const at = count(value.at)
		if (at === undefined) return undefined
		setAside[id] = { at, reason: 'refused' }
	}
	return { version: VERSION, since, records, setAside }
}

export class MemoryUsage {
	readonly #file: string
	readonly #now: () => number
	readonly #fs: UsageFs
	readonly #log: MemoryUsageDeps['log']
	#state: UsageState = 'unknown'
	#since = 0
	#baseRecords: Readonly<Record<string, UsageCounters>> = {}
	#baseAside: Readonly<Record<string, SetAside>> = {}
	#records = new Map<string, UsageCounters>()
	#setAside = new Map<string, SetAside>()
	readonly #deltas = new Map<string, Delta>()
	readonly #asideAdded = new Map<string, SetAside>()
	readonly #asideLifted = new Set<string>()
	readonly #brokenSet = new Map<string, number>()
	readonly #brokenCleared = new Set<string>()
	#flushing: Promise<void> = Promise.resolve()

	constructor(deps: MemoryUsageDeps) {
		this.#file = deps.file
		this.#now = deps.now
		this.#fs = deps.fs ?? nodeUsageFs
		this.#log = deps.log
	}

	/** Whether the counters can be trusted. Before `load`, and after a read that failed, `unknown`. */
	get state(): UsageState {
		return this.#state
	}

	/** When this file began counting; 0 while `unknown`. */
	get since(): number {
		return this.#since
	}

	/** Read the file. Never rejects: a file that cannot be read leaves the state `unknown`. */
	async load(): Promise<void> {
		const read = await this.#read()
		if (read === 'missing' || read === 'unreadable' || read === 'blocked') {
			this.#state = 'unknown'
			this.#merge(undefined)
			return
		}
		this.#state = 'known'
		this.#since = read.since
		this.#baseRecords = read.records
		this.#baseAside = read.setAside
		this.#merge(read)
	}

	/**
	 * The file as it is now: 'missing', 'unreadable' (bad content, moved aside),
	 * 'blocked' (there, but neither readable nor movable: never overwritten),
	 * or its content.
	 */
	async #read(): Promise<UsageFile | 'missing' | 'unreadable' | 'blocked'> {
		let text: string
		try {
			text = await this.#fs.readFile(this.#file)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
			this.#log?.('memory usage unreadable', { 'namzu.memory.usage.reason': 'read' })
			// It may hold set-aside ids and counts: it is neither replaced nor moved.
			return 'blocked'
		}
		const parsed = parse(text)
		if (parsed) return parsed
		this.#log?.('memory usage unreadable', { 'namzu.memory.usage.reason': 'corrupt' })
		// Kept, not overwritten: a person may want what was in it.
		try {
			await this.#fs.rename(this.#file, `${this.#file}.corrupt`)
		} catch {
			// A file that cannot be moved is not replaced either.
			return 'blocked'
		}
		return 'unreadable'
	}

	/** The file's content with this process's pending changes laid over it. */
	#merge(file: UsageFile | undefined): void {
		const records = new Map(Object.entries(file?.records ?? {}))
		for (const [id, delta] of this.#deltas) {
			const base = records.get(id)
			records.set(id, {
				recalls: (base?.recalls ?? 0) + delta.recalls,
				selected: (base?.selected ?? 0) + delta.selected,
				lastRecalledAt: Math.max(base?.lastRecalledAt ?? 0, delta.lastRecalledAt),
			})
		}
		for (const [id, at] of this.#brokenSet) {
			const base = records.get(id) ?? { recalls: 0, selected: 0, lastRecalledAt: 0 }
			records.set(id, { ...base, brokenSince: base.brokenSince ?? at })
		}
		for (const id of this.#brokenCleared) {
			const base = records.get(id)
			if (base?.brokenSince === undefined) continue
			const { brokenSince: _cleared, ...rest } = base
			records.set(id, rest)
		}
		const aside = new Map(Object.entries(file?.setAside ?? {}))
		for (const [id, entry] of this.#asideAdded) aside.set(id, entry)
		for (const id of this.#asideLifted) aside.delete(id)
		this.#records = records
		this.#setAside = aside
	}

	/** The counters of one record, or undefined when nothing was counted for it. */
	get(id: string): UsageCounters | undefined {
		return this.#records.get(id)
	}

	/** Recall put these records in front of the model. `selected` are those a selector chose. */
	recalled(ids: readonly string[], selected: readonly string[] = []): void {
		if (ids.length === 0) return
		const at = this.#now()
		const chosen = new Set(selected)
		for (const id of new Set(ids)) {
			const delta = this.#deltas.get(id) ?? { recalls: 0, selected: 0, lastRecalledAt: 0 }
			delta.recalls += 1
			if (chosen.has(id)) delta.selected += 1
			delta.lastRecalledAt = at
			this.#deltas.set(id, delta)
		}
		this.#merge(this.#base())
	}

	/** Recall found a file this record names gone. The first time is kept. */
	anchorsBroken(id: string): void {
		this.#brokenCleared.delete(id)
		if (this.#records.get(id)?.brokenSince === undefined && !this.#brokenSet.has(id)) {
			this.#brokenSet.set(id, this.#now())
			this.#merge(this.#base())
		}
	}

	/** Recall found every file this record names as it was. */
	anchorsHeld(id: string): void {
		this.#brokenSet.delete(id)
		if (this.#records.get(id)?.brokenSince !== undefined) {
			this.#brokenCleared.add(id)
			this.#merge(this.#base())
		}
	}

	/** Set records aside: recall does not offer them again until `restore`. */
	setAside(ids: readonly string[]): void {
		const at = this.#now()
		for (const id of ids) {
			this.#asideLifted.delete(id)
			this.#asideAdded.set(id, { at, reason: 'refused' })
		}
		this.#merge(this.#base())
	}

	/** Lift the set-aside of one record. */
	restore(id: string): void {
		// A restored memory starts its anchors' clock again.
		this.anchorsHeld(id)
		this.#asideAdded.delete(id)
		this.#asideLifted.add(id)
		this.#merge(this.#base())
	}

	isSetAside(id: string): boolean {
		return this.#setAside.has(id)
	}

	/** The ids recall must skip. A fresh set each call. */
	setAsideIds(): Set<string> {
		return new Set(this.#setAside.keys())
	}

	/** What the file held when last read, without pending changes. */
	#base(): UsageFile {
		return {
			version: VERSION,
			since: this.#since,
			records: this.#baseRecords,
			setAside: this.#baseAside,
		}
	}

	/** Whether anything waits to be written. */
	get dirty(): boolean {
		return (
			this.#deltas.size > 0 ||
			this.#asideAdded.size > 0 ||
			this.#asideLifted.size > 0 ||
			this.#brokenSet.size > 0 ||
			this.#brokenCleared.size > 0
		)
	}

	/** Write what is pending. Never rejects; calls queue behind one another. */
	flush(): Promise<void> {
		this.#flushing = this.#flushing.then(() => this.#write())
		return this.#flushing
	}

	async #write(): Promise<void> {
		if (!this.dirty) return
		try {
			const read = await this.#read()
			if (read === 'blocked') {
				// Pending changes stay in memory for the next flush.
				this.#log?.('memory usage not written', { 'namzu.memory.usage.reason': 'blocked' })
				return
			}
			const current = read === 'missing' || read === 'unreadable' ? undefined : read
			const since = current?.since ?? this.#since
			const startedAt = since > 0 ? since : this.#now()
			this.#since = startedAt
			this.#baseRecords = current?.records ?? {}
			this.#baseAside = current?.setAside ?? {}
			this.#merge(current ?? { version: VERSION, since: startedAt, records: {}, setAside: {} })
			const body: UsageFile = {
				version: VERSION,
				since: startedAt,
				records: Object.fromEntries(this.#records),
				setAside: Object.fromEntries(this.#setAside),
			}
			await this.#fs.mkdir(dirname(this.#file))
			const temporary = `${this.#file}.${randomUUID()}.tmp`
			try {
				await this.#fs.writeFile(temporary, `${JSON.stringify(body)}\n`)
				await this.#fs.rename(temporary, this.#file)
			} catch (error) {
				await this.#fs.rm(temporary).catch(() => undefined)
				throw error
			}
			// Written: what was pending is now part of the file.
			this.#deltas.clear()
			this.#asideAdded.clear()
			this.#asideLifted.clear()
			this.#brokenSet.clear()
			this.#brokenCleared.clear()
			this.#baseRecords = body.records
			this.#baseAside = body.setAside
			this.#state = 'known'
			this.#log?.('memory usage written', {
				'namzu.memory.usage.records': Object.keys(body.records).length,
				'namzu.memory.usage.set_aside': Object.keys(body.setAside).length,
			})
		} catch {
			this.#log?.('memory usage not written', { 'namzu.memory.usage.reason': 'write' })
		}
	}
}
