import {
	type FileHit,
	type PreparedIndex,
	directoryOf,
	searchFiles,
} from './file-panel/file-search.js'
import { baseNameOf } from './file-panel/project-refs.js'

/** The project's file list as the "@" menu keeps it: waiting, failed, or read. */
export type MentionIndex =
	| { state: 'loading' }
	| { state: 'failed' }
	| { state: 'ready'; index: PreparedIndex; truncated: boolean }

export interface MentionRow {
	path: string
	name: string
	directory: string
	/** The path's runs, with the matched letters marked, so the name can draw them strong. */
	segments: FileHit['segments']
}

export type MentionList =
	| { kind: 'closed' }
	| { kind: 'loading' }
	| { kind: 'rows'; rows: MentionRow[]; note?: string }

/** The empty query lists this many paths from the front of the index. */
export const MENTION_EMPTY_LIMIT = 8

const TRUNCATED_NOTE = 'Showing part of a large project; type more to narrow'

/**
 * What the "@" menu shows. A failed read opens nothing, because a menu that only says it failed
 * offers no action, and a query that matches nothing closes it as well.
 */
export function mentionList(index: MentionIndex, query: string): MentionList {
	if (index.state === 'failed') return { kind: 'closed' }
	if (index.state === 'loading') return { kind: 'loading' }
	const hits = searchFiles(index.index, query, query.trim() ? 50 : MENTION_EMPTY_LIMIT)
	if (hits.length === 0) return { kind: 'closed' }
	return {
		kind: 'rows',
		rows: hits.map((hit) => ({
			path: hit.path,
			name: baseNameOf(hit.path),
			directory: directoryOf(hit.path),
			segments: hit.segments,
		})),
		...(index.truncated ? { note: TRUNCATED_NOTE } : {}),
	}
}

/** The matched letters that fall inside the file's name, for the strong weight; the rest of the path is the folder. */
export function nameSegments(row: MentionRow): FileHit['segments'] {
	const folderLength = row.directory.length === 0 ? 0 : row.directory.length + 1
	const out: FileHit['segments'] = []
	let seen = 0
	for (const segment of row.segments) {
		const start = seen
		seen += segment.text.length
		if (seen <= folderLength) continue
		const text = segment.text.slice(Math.max(0, folderLength - start))
		if (text) out.push({ text, match: segment.match })
	}
	return out
}
