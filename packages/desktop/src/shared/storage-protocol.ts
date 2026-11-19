/**
 * What the Storage view and the Trusted folders view show: how much space Namzu uses by part,
 * and the folders the engine trusts. The main process measures and changes; the page only draws.
 */

export const STORAGE_PART_IDS = [
	'conversations',
	'engine',
	'voice',
	'logs',
	'caches',
	'other',
] as const
export type StoragePartId = (typeof STORAGE_PART_IDS)[number]

export interface StoragePart {
	id: StoragePartId
	label: string
	/** One plain line about what is in it. */
	note: string
	bytes: number
	/** The folder was too large to count every file, so the size is a lower bound. */
	approximate?: boolean
	/** Only logs and caches: clearing them loses nothing a person made. */
	clearable: boolean
}

export interface StorageReport {
	parts: StoragePart[]
	totalBytes: number
}

export function isStoragePartId(value: unknown): value is StoragePartId {
	return typeof value === 'string' && (STORAGE_PART_IDS as readonly string[]).includes(value)
}

/** The list that really decides trust is the engine's `trust.json`; Desktop keeps a fingerprint beside it. */
export interface TrustedFoldersView {
	/** Where the list is kept, so the page can say which list this is. */
	file: string
	folders: string[]
	/** The file exists but cannot be read, so the list shown may be incomplete. */
	unreadable?: boolean
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** `1.4 GB`, `820 KB`: a size a person can read, rounded to one place above 10 of a unit. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024
		unit += 1
	}
	const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1)
	return `${text} ${UNITS[unit]}`
}
