/**
 * Archive conversations left idle (`archiveInactive`). The sweep only picks the ones idle long
 * enough and hands each to the ordinary archive, which already refuses a conversation with an open
 * turn, one with background work, and one in a folder that is not trusted. Archiving moves a
 * conversation to the archive; it never deletes anything, and it never touches a worktree's files.
 */

import { loadBootstrapConfigWithProvenance } from '../../config/load.js'
import type { ArchiveInactiveAfter } from '../../config/schema.js'

const DAY_MS = 24 * 60 * 60 * 1000

const AFTER_MS: Readonly<Record<ArchiveInactiveAfter, number | undefined>> = {
	never: undefined,
	'1d': DAY_MS,
	'7d': 7 * DAY_MS,
	'30d': 30 * DAY_MS,
}

/** How long a conversation may sit idle, in milliseconds; `undefined` means never archive. */
export function archiveAfterMs(setting: ArchiveInactiveAfter | undefined): number | undefined {
	return setting === undefined ? undefined : AFTER_MS[setting]
}

export interface IdleCandidate {
	readonly id: string
	/** When the conversation last changed, as an ISO time. */
	readonly updatedAt: string
}

/**
 * Archive each candidate idle for `afterMs` or longer. `archive` is the host's own archive: it
 * throws for a conversation that is running or has background work, and that one is simply left
 * for a later sweep. Returns the ids archived.
 */
/** At most this many conversations are archived by one listing, so a first listing stays quick. */
export const ARCHIVE_PER_SWEEP = 5
/** A conversation that was refused is not tried again for this long. */
export const ARCHIVE_RETRY_MS = 10 * 60 * 1000

export async function archiveIdleConversations(options: {
	readonly candidates: readonly IdleCandidate[]
	readonly afterMs: number | undefined
	readonly now: number
	readonly archive: (id: string) => Promise<{ readonly archived?: boolean } | undefined>
	/** Most to archive in this call; the rest wait for the next listing. */
	readonly limit?: number
	/** Ids refused earlier, with when; kept by the host between listings. */
	readonly refused?: Map<string, number>
}): Promise<string[]> {
	const { afterMs } = options
	if (afterMs === undefined) return []
	const limit = options.limit ?? ARCHIVE_PER_SWEEP
	const archived: string[] = []
	// Longest idle first: those are the ones the setting is for.
	const idle = options.candidates
		.map((candidate) => ({ id: candidate.id, since: Date.parse(candidate.updatedAt) }))
		.filter((entry) => Number.isFinite(entry.since) && options.now - entry.since >= afterMs)
		.sort((a, b) => a.since - b.since)
	for (const entry of idle) {
		if (archived.length >= limit) break
		const refusedAt = options.refused?.get(entry.id)
		if (refusedAt !== undefined && options.now - refusedAt < ARCHIVE_RETRY_MS) continue
		try {
			const result = await options.archive(entry.id)
			if (result?.archived === true) archived.push(entry.id)
			else options.refused?.set(entry.id, options.now)
		} catch {
			// Running, background work, or an untrusted folder: not idle, so not archived.
			options.refused?.set(entry.id, options.now)
		}
	}
	return archived
}

/**
 * The setting in force, read from the user's own file and the managed file each time the
 * conversation list is drawn, so a change takes effect on the next listing. A file that cannot be
 * read archives nothing.
 */
export function readArchiveInactive(): ArchiveInactiveAfter | undefined {
	try {
		return loadBootstrapConfigWithProvenance({}).config.archiveInactive
	} catch {
		return undefined
	}
}
