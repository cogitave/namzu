import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoragePart, StoragePartId, StorageReport } from '../shared/storage-protocol.js'

/** A tree larger than this many entries is counted up to here and reported as a lower bound. */
const MAX_ENTRIES = 200_000

/** What the app measures, so a test can name its own folders. */
export interface StorageLayout {
	/** The app's own data folder. */
	userData: string
	/** `NAMZU_HOME`: conversations, the trust list and scheduled tasks. */
	namzuHome: string
}

/** Chromium's cache folders inside the app's data folder. Cleared or rebuilt on their own. */
export const CACHE_FOLDERS = [
	'Cache',
	'Code Cache',
	'GPUCache',
	'DawnCache',
	'GrShaderCache',
	'ShaderCache',
] as const
/** The log being written right now stays: the diagnostics writer owns it. */
const LIVE_LOG = 'desktop.ndjson'

interface Measured {
	bytes: number
	approximate: boolean
}

/** Bytes under `root`, counting files and never following a link. A missing folder is 0. */
export async function measureTree(root: string): Promise<Measured> {
	let bytes = 0
	let seen = 0
	const pending = [root]
	while (pending.length > 0) {
		const path = pending.pop() as string
		let entry: Awaited<ReturnType<typeof lstat>>
		try {
			entry = await lstat(path)
		} catch {
			continue
		}
		seen += 1
		if (seen > MAX_ENTRIES) return { bytes, approximate: true }
		if (entry.isDirectory()) {
			try {
				for (const name of await readdir(path)) pending.push(join(path, name))
			} catch {
				// An unreadable folder counts as empty.
			}
		} else if (entry.isFile()) bytes += entry.size
	}
	return { bytes, approximate: false }
}

interface PartDefinition {
	id: StoragePartId
	label: string
	note: string
	clearable: boolean
	roots: string[]
}

export function storageParts(layout: StorageLayout): PartDefinition[] {
	const { userData } = layout
	return [
		{
			id: 'conversations',
			label: 'Conversations and work',
			note: 'Your conversations, Pals, projects, the trusted folders list and scheduled tasks. Never cleared here.',
			clearable: false,
			roots: [layout.namzuHome],
		},
		{
			id: 'engine',
			label: 'Engine',
			note: 'Newer engines the app downloaded. It fetches them again when needed.',
			clearable: false,
			roots: [join(userData, 'kernel')],
		},
		{
			id: 'voice',
			label: 'Voice models',
			note: 'The downloaded voice and voice input. Remove them under Voice.',
			clearable: false,
			roots: [join(userData, 'local-speech'), join(userData, 'local-listening')],
		},
		{
			id: 'logs',
			label: 'Logs',
			note: 'Diagnostic logs for support. Safe to clear; the log being written stays.',
			clearable: true,
			roots: [join(userData, 'logs')],
		},
		{
			id: 'caches',
			label: 'Caches',
			note: 'Temporary files the windows rebuild. Safe to clear.',
			clearable: true,
			roots: CACHE_FOLDERS.map((name) => join(userData, name)),
		},
	]
}

/** The sizes of every part. The app's own data folder not named above is "Other". */
export async function measureStorage(layout: StorageLayout): Promise<StorageReport> {
	const parts: StoragePart[] = []
	let named = 0
	for (const definition of storageParts(layout)) {
		let bytes = 0
		let partial = false
		for (const root of definition.roots) {
			const size = await measureTree(root)
			bytes += size.bytes
			partial ||= size.approximate
		}
		// The command line's home is inside the app's folder only when someone pointed it there; then
		// the folder's own total already holds it.
		if (definition.id !== 'conversations' || layout.namzuHome.startsWith(layout.userData))
			named += bytes
		parts.push({
			id: definition.id,
			label: definition.label,
			note: definition.note,
			bytes,
			...(partial ? { approximate: true } : {}),
			clearable: definition.clearable,
		})
	}
	const all = await measureTree(layout.userData)
	const other = Math.max(0, all.bytes - named)
	parts.push({
		id: 'other',
		label: 'Other',
		note: 'Settings, open tabs, drafts and the lists the app keeps. Never cleared here.',
		bytes: other,
		...(all.approximate ? { approximate: true } : {}),
		clearable: false,
	})
	return { parts, totalBytes: parts.reduce((sum, part) => sum + part.bytes, 0) }
}

/**
 * Empties one clearable part and answers the new sizes. A part that is not clearable is refused,
 * so a request can never reach the conversations, the settings or a key. A file that cannot be
 * removed (in use) stays, and the new size says so.
 */
export async function clearStorage(layout: StorageLayout, id: unknown): Promise<StorageReport> {
	const definition = storageParts(layout).find((part) => part.id === id)
	if (!definition || !definition.clearable) throw new Error('That part cannot be cleared here.')
	for (const root of definition.roots) {
		let names: string[]
		try {
			names = await readdir(root)
		} catch {
			continue
		}
		for (const name of names) {
			if (definition.id === 'logs' && name === LIVE_LOG) continue
			try {
				await rm(join(root, name), { recursive: true, force: true })
			} catch {
				// In use: it stays, and the size shown afterwards says so.
			}
		}
	}
	return measureStorage(layout)
}
