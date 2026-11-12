/**
 * The spend ledger: a small summary of every session log under the home,
 * kept beside the index so a spend report does not read every log in full.
 *
 * `<home>/spend-ledger.json` holds, for each log, the rows its settled turns
 * folded into (see `fold.ts`), the byte offset the next read resumes from, and
 * the size and modification time the log had then. A refresh stats every log,
 * leaves the unchanged ones alone, reads only what a changed log appended
 * since its resume offset, and writes the file back only when something
 * changed. A log that shrank is read again from the start.
 *
 * The file is derived and safe to delete: a missing, unreadable or
 * other-version file is rebuilt from the logs, which stay the source of truth.
 * It is written to a temporary file and renamed over, so a reader sees the
 * old file or the new one.
 */

import { randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import {
	type Cumulative,
	LogFolder,
	type ModelKey,
	ModelTable,
	type SpendRow,
	ZERO,
	cumulativeOf,
} from './fold.js'

/** Raise when the file's shape changes; an older or newer file is then rebuilt, never migrated. */
export const SPEND_LEDGER_VERSION = 2

export const SPEND_LEDGER_FILE = 'spend-ledger.json'

/** What the ledger keeps of one log. */
export interface LedgerSession {
	/** Project slug the log is filed under. */
	readonly slug: string
	/** Bytes of the log when it was last read. */
	size: number
	/** Modification time of the log when it was last read. */
	mtimeMs: number
	/** Where the next read starts. */
	from: number
	/** Set for a sub-agent log: the kind of child it is. */
	parentKind?: string
	/** Set for a log run by an outside engine. */
	engineId?: string
	/**
	 * What the conversation had settled at `from`, as seven counts (prompt,
	 * completion, total, cache read, cache write, cost, unpriced). The next turn
	 * may start from it. Absent when nothing had settled.
	 */
	cum?: number[]
	/** Rows of turns that settled. */
	rows: SpendRow[]
	/** Rows of a turn still open, recomputed on each read. */
	open: SpendRow[]
}

interface LedgerFile {
	readonly version: number
	readonly models: ModelKey[]
	readonly projects: Record<string, string>
	readonly sessions: Record<string, LedgerSession>
}

export interface Ledger {
	readonly models: ModelTable
	/** Working directory of each project, by slug, when a log said it. */
	readonly projects: Map<string, string>
	/** By log path relative to the home. */
	readonly sessions: Map<string, LedgerSession>
}

export interface RefreshStats {
	/** Logs found. */
	readonly logs: number
	/** Logs whose bytes were read (new, grown or shrunk). */
	readonly read: number
	/** Bytes read from logs. */
	readonly bytesRead: number
	/** Whether the ledger file was written. */
	readonly wrote: boolean
	/** Whether the ledger file was missing or unusable, so everything was read. */
	readonly rebuilt: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function listDir(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true })
	} catch {
		return []
	}
}

/** Every session log of one project: roots at the top, sub-agents under `<id>/subagents/`, to any depth. */
async function discoverProject(home: string, slug: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (dir: string, rel: string, nested: boolean): Promise<void> => {
		const entries = await listDir(dir)
		const dirs: string[] = []
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith('.jsonl')) {
				const id = entry.name.slice(0, -'.jsonl'.length)
				if (UUID.test(id) || nested) out.push(`${rel}/${entry.name}`)
			} else if (entry.isDirectory() && UUID.test(entry.name)) {
				dirs.push(entry.name)
			}
		}
		await mapLimit(dirs, 32, async (name) => {
			await walk(join(dir, name, 'subagents'), `${rel}/${name}/subagents`, true)
		})
	}
	await walk(join(home, 'projects', slug), `projects/${slug}`, false)
	return out
}

async function mapLimit<T>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++] as T
			await run(item)
		}
	})
	await Promise.all(workers)
}

export async function discoverLogs(home: string): Promise<string[]> {
	const slugs = (await listDir(join(home, 'projects'))).filter((e) => e.isDirectory())
	const all: string[] = []
	await mapLimit(slugs, 8, async (slug) => {
		all.push(...(await discoverProject(home, slug.name)))
	})
	return all.sort()
}

async function loadLedger(home: string): Promise<Ledger | undefined> {
	let parsed: LedgerFile
	try {
		parsed = JSON.parse(await readFile(join(home, SPEND_LEDGER_FILE), 'utf8')) as LedgerFile
	} catch {
		return undefined
	}
	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		parsed.version !== SPEND_LEDGER_VERSION ||
		!Array.isArray(parsed.models) ||
		typeof parsed.sessions !== 'object' ||
		parsed.sessions === null
	) {
		return undefined
	}
	const sessions = new Map<string, LedgerSession>()
	for (const [key, entry] of Object.entries(parsed.sessions)) {
		if (!isLedgerSession(entry)) return undefined
		sessions.set(key, entry)
	}
	if (
		!parsed.models.every(
			(m) => m !== null && typeof m === 'object' && typeof (m as ModelKey).model === 'string',
		)
	) {
		return undefined
	}
	return {
		models: new ModelTable(parsed.models),
		projects: new Map(Object.entries(parsed.projects ?? {})),
		sessions,
	}
}

const isRow = (row: unknown): boolean =>
	Array.isArray(row) &&
	row.length === 11 &&
	row.every((n) => typeof n === 'number' && Number.isFinite(n))

/** A session entry of the shape this version writes. Anything else makes the file unusable, so it is rebuilt. */
function isLedgerSession(entry: unknown): entry is LedgerSession {
	if (entry === null || typeof entry !== 'object') return false
	const e = entry as Record<string, unknown>
	return (
		typeof e.slug === 'string' &&
		typeof e.size === 'number' &&
		typeof e.mtimeMs === 'number' &&
		typeof e.from === 'number' &&
		Array.isArray(e.rows) &&
		e.rows.every(isRow) &&
		Array.isArray(e.open) &&
		e.open.every(isRow) &&
		(e.cum === undefined ||
			(Array.isArray(e.cum) &&
				e.cum.length === 7 &&
				e.cum.every((n) => typeof n === 'number' && Number.isFinite(n))))
	)
}

async function saveLedger(home: string, ledger: Ledger): Promise<void> {
	const file: LedgerFile = {
		version: SPEND_LEDGER_VERSION,
		models: ledger.models.list,
		projects: Object.fromEntries(ledger.projects),
		sessions: Object.fromEntries(ledger.sessions),
	}
	const target = join(home, SPEND_LEDGER_FILE)
	const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
	try {
		await writeFile(temp, JSON.stringify(file), { mode: 0o600 })
		await rename(temp, target)
	} catch (cause) {
		await rm(temp, { force: true })
		throw cause
	}
}

/** Bytes read at a time. A log is folded as it streams, so memory does not grow with the log. */
export const READ_CHUNK_BYTES = 1024 * 1024

/** Stream `[from, to)` of a log through a folder, one chunk at a time. Returns the bytes read. */
async function streamRange(
	path: string,
	from: number,
	to: number,
	folder: LogFolder,
	chunkBytes: number,
) {
	const handle = await open(path, 'r')
	try {
		const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(0, to - from)))
		let position = from
		while (position < to) {
			const { bytesRead } = await handle.read(
				buffer,
				0,
				Math.min(buffer.length, to - position),
				position,
			)
			if (bytesRead === 0) break
			folder.feed(buffer.subarray(0, bytesRead))
			position += bytesRead
		}
		return position - from
	} finally {
		await handle.close()
	}
}

/** What a settled turn of a log ended at: the figure a fork of it starts from. */
async function settlementAt(path: string, turnId: string): Promise<Cumulative | undefined> {
	const needle = `"turnId":"${turnId}"`
	let found: Cumulative | undefined
	const handle = await open(path, 'r')
	try {
		const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
		let position = 0
		let tail = ''
		const decoder = new StringDecoder('utf8')
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
			if (bytesRead === 0) break
			position += bytesRead
			const lines = (tail + decoder.write(buffer.subarray(0, bytesRead))).split('\n')
			tail = lines.pop() ?? ''
			for (const line of lines) {
				if (!line.includes(needle) || !/"type":"turn_(?:completed|failed)"/.test(line)) continue
				try {
					const record = JSON.parse(line) as { settlement?: { usage?: unknown; cost?: unknown } }
					if (record.settlement !== undefined) {
						found = cumulativeOf(record.settlement.usage, record.settlement.cost)
					}
				} catch {
					// A damaged line says nothing.
				}
			}
		}
	} finally {
		await handle.close()
	}
	return found
}

const toCumulative = (cum: readonly number[] | undefined): Cumulative =>
	cum === undefined
		? ZERO
		: {
				prompt: cum[0] as number,
				completion: cum[1] as number,
				total: cum[2] as number,
				cacheRead: cum[3] as number,
				cacheWrite: cum[4] as number,
				cost: cum[5] as number,
				unpriced: cum[6] as number,
			}

const fromCumulative = (c: Cumulative): number[] | undefined =>
	c.total > 0
		? [c.prompt, c.completion, c.total, c.cacheRead, c.cacheWrite, c.cost, c.unpriced]
		: undefined

export interface RefreshOptions {
	readonly home: string
	/** Read logs and compute, but never write the ledger file. */
	readonly readOnly?: boolean
	/** Bytes read at a time; tests make it small to cross line and turn boundaries. */
	readonly chunkBytes?: number
}

/** Bring the ledger up to date with the logs and return it. */
export async function refreshLedger(
	options: RefreshOptions,
): Promise<{ ledger: Ledger; stats: RefreshStats }> {
	const home = options.home
	const chunkBytes = Math.max(1, options.chunkBytes ?? READ_CHUNK_BYTES)
	const loaded = await loadLedger(home)
	const ledger: Ledger = loaded ?? {
		models: new ModelTable(),
		projects: new Map(),
		sessions: new Map(),
	}
	const rebuilt = loaded === undefined
	const logs = await discoverLogs(home)
	const present = new Set(logs)
	let changed = rebuilt
	let read = 0
	let bytesRead = 0

	for (const key of [...ledger.sessions.keys()]) {
		if (!present.has(key)) {
			ledger.sessions.delete(key)
			changed = true
		}
	}

	await mapLimit(logs, 32, async (key) => {
		const path = join(home, key)
		let info: Awaited<ReturnType<typeof stat>>
		try {
			info = await stat(path)
		} catch {
			return
		}
		const slug = key.split('/')[1] as string
		let entry = ledger.sessions.get(key)
		if (entry !== undefined && entry.size === info.size && entry.mtimeMs === info.mtimeMs) return
		if (entry === undefined || info.size < entry.size) {
			entry = { slug, size: 0, mtimeMs: 0, from: 0, rows: [], open: [] }
		}
		let result: ReturnType<LogFolder['finish']>
		let size = 0
		try {
			const start = { settled: toCumulative(entry.cum) }
			let folder = new LogFolder(ledger.models, entry.from, start)
			size = await streamRange(path, entry.from, info.size, folder, chunkBytes)
			result = folder.finish()
			const fork = result.facts.forkedFrom
			if (entry.from === 0 && fork !== undefined) {
				// A fork's first turn starts from what its parent had settled at the fork.
				const parentKey =
					logs.find((k) => k === `projects/${slug}/${fork.sessionId}.jsonl`) ??
					logs.find((k) => k.endsWith(`/${fork.sessionId}.jsonl`))
				const base =
					parentKey === undefined
						? undefined
						: await settlementAt(join(home, parentKey), fork.turnId)
				if (base !== undefined) {
					folder = new LogFolder(ledger.models, 0, { settled: base })
					size = await streamRange(path, 0, info.size, folder, chunkBytes)
					result = folder.finish()
				}
			}
		} catch {
			return
		}
		read += 1
		bytesRead += size
		const next: LedgerSession = {
			slug,
			size: info.size,
			mtimeMs: info.mtimeMs,
			from: result.from,
			...(fromCumulative(result.settledCumulative) !== undefined
				? { cum: fromCumulative(result.settledCumulative) as number[] }
				: {}),
			rows: result.settled.length > 0 ? [...entry.rows, ...result.settled] : entry.rows,
			open: result.open,
			...((result.facts.parentKind ?? entry.parentKind) !== undefined
				? { parentKind: (result.facts.parentKind ?? entry.parentKind) as string }
				: {}),
			...((result.facts.engineId ?? entry.engineId) !== undefined
				? { engineId: (result.facts.engineId ?? entry.engineId) as string }
				: {}),
		}
		ledger.sessions.set(key, next)
		if (result.facts.cwd !== undefined && !ledger.projects.has(slug)) {
			ledger.projects.set(slug, result.facts.cwd)
		}
		changed = true
	})

	let wrote = false
	if (changed && options.readOnly !== true) {
		try {
			await saveLedger(home, ledger)
			wrote = true
		} catch {
			// The ledger is a convenience. An unwritable home costs the next report a re-read.
		}
	}
	return { ledger, stats: { logs: logs.length, read, bytesRead, wrote, rebuilt } }
}
