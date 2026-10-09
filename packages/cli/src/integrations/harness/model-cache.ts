import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { codexRecord } from './codex-protocol.js'
import type { HarnessCatalogueModel } from './codex-protocol.js'

const VERSION = 1
const MAX_BYTES = 256 * 1024
const MAX_ENTRIES = 8
const MAX_MODELS = 512

/** The last good model list of each installed engine build. */
export interface EngineModelCache {
	read(
		engine: string,
		identity: string,
	): Promise<{ rows: readonly HarnessCatalogueModel[]; at: number } | undefined>
	write(
		engine: string,
		identity: string,
		rows: readonly HarnessCatalogueModel[],
		at: number,
	): Promise<void>
}

function efforts(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function row(value: unknown): HarnessCatalogueModel | undefined {
	const record = codexRecord(value)
	if (
		!record ||
		typeof record.id !== 'string' ||
		!record.id ||
		record.id.length > 400 ||
		typeof record.label !== 'string' ||
		(record.effortLevels !== undefined && !efforts(record.effortLevels)) ||
		(record.defaultEffort !== undefined && typeof record.defaultEffort !== 'string') ||
		(record.default !== undefined && record.default !== true) ||
		(record.current !== undefined && record.current !== true)
	)
		return undefined
	// Only the fields a catalogue row has; a foreign extra key never rides along.
	return {
		id: record.id,
		label: record.label,
		...(record.effortLevels ? { effortLevels: record.effortLevels } : {}),
		...(record.defaultEffort ? { defaultEffort: record.defaultEffort } : {}),
		...(record.default ? { default: true as const } : {}),
		...(record.current ? { current: true as const } : {}),
	} as HarnessCatalogueModel
}

type Entries = Record<string, { rows: HarnessCatalogueModel[]; at: number }>

async function load(file: string): Promise<Entries> {
	try {
		if ((await stat(file)).size > MAX_BYTES) return {}
		const parsed = codexRecord(JSON.parse(await readFile(file, 'utf8')))
		const entries = codexRecord(parsed?.entries)
		if (!parsed || parsed.version !== VERSION || !entries) return {}
		const clean: Entries = {}
		for (const [key, value] of Object.entries(entries)) {
			const entry = codexRecord(value)
			if (!entry || typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue
			if (!Array.isArray(entry.rows) || entry.rows.length > MAX_MODELS) continue
			const rows = entry.rows.map(row)
			if (rows.some((item) => item === undefined)) continue
			clean[key] = { rows: rows as HarnessCatalogueModel[], at: entry.at }
		}
		return clean
	} catch {
		// Missing, unreadable or foreign: ignored, and the next success writes it again.
		return {}
	}
}

/**
 * A small file in the application home. Lists are keyed by engine and installed build, so an
 * upgrade finds nothing and reads the engine again. It holds ids, labels and effort levels the engine
 * itself reported; no path, account or credential.
 */
export function createEngineModelCache(file: string): EngineModelCache {
	const key = (engine: string, identity: string) => JSON.stringify([engine, identity])
	return {
		async read(engine, identity) {
			const found = (await load(file))[key(engine, identity)]
			return found ? { rows: found.rows, at: found.at } : undefined
		},
		async write(engine, identity, rows, at) {
			const entries = await load(file)
			const name = key(engine, identity)
			delete entries[name]
			entries[name] = { rows: [...rows], at }
			const kept = Object.entries(entries)
				.sort((a, b) => a[1].at - b[1].at)
				.slice(-MAX_ENTRIES)
			const temporary = `${file}.${process.pid}.tmp`
			try {
				await mkdir(dirname(file), { recursive: true })
				await writeFile(
					temporary,
					JSON.stringify({ version: VERSION, entries: Object.fromEntries(kept) }),
					{
						mode: 0o600,
					},
				)
				await rename(temporary, file)
			} catch {
				await rm(temporary, { force: true }).catch(() => undefined)
			}
		},
	}
}
