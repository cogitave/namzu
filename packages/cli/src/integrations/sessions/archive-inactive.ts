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
export async function archiveIdleConversations(options: {
	readonly candidates: readonly IdleCandidate[]
	readonly afterMs: number | undefined
	readonly now: number
	readonly archive: (id: string) => Promise<{ readonly archived?: boolean } | undefined>
}): Promise<string[]> {
	const { afterMs } = options
	if (afterMs === undefined) return []
	const archived: string[] = []
	for (const candidate of options.candidates) {
		const idleSince = Date.parse(candidate.updatedAt)
		if (!Number.isFinite(idleSince) || options.now - idleSince < afterMs) continue
		try {
			const result = await options.archive(candidate.id)
			if (result?.archived === true) archived.push(candidate.id)
		} catch {
			// Running, background work, or an untrusted folder: not idle, so not archived.
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
