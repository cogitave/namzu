/**
 * What a rewind would change, counted from the saved file bodies.
 *
 * For each file the turns touched, the body it had before the first of them
 * is compared with the body the last of them left. Counting is bounded the
 * way a picker needs it to be: a body past a megabyte, a binary body, a diff
 * past a few hundred edits or an exhausted clock make the line counts
 * unknown, and the file names are still reported.
 */

import { diffLines } from 'diff'

import type { BlobRef, ManifestEntry } from './manifest.js'

/** Per side. A larger body is not read for counting. */
export const REWIND_STATS_BODY_BYTES = 1024 * 1024
/** A diff needing more edits than this is not counted. */
export const REWIND_STATS_MAX_EDITS = 500

export interface RewindSummary {
	/** Absolute paths whose content differs from the rewind point, first touched first. */
	readonly files: readonly string[]
	/** Lines added and removed across those files; absent when any file could not be counted. */
	readonly insertions?: number
	readonly deletions?: number
}

export interface RewindStatsTurn {
	/** Where this turn's bodies live. */
	readonly root: string
	readonly entries: readonly ManifestEntry[]
}

type ReadBody = (root: string, sha256: string) => Promise<Uint8Array>

interface Span {
	readonly before: { readonly ref: BlobRef | null; readonly root: string }
	after: { ref: BlobRef | null; root: string }
}

/** `turns` oldest first. */
export async function summariseRewind(
	turns: readonly RewindStatsTurn[],
	readBody: ReadBody,
	expired: () => boolean,
): Promise<RewindSummary> {
	const spans = new Map<string, Span>()
	for (const turn of turns) {
		for (const entry of turn.entries) {
			const known = spans.get(entry.path)
			if (known) known.after = { ref: entry.after, root: turn.root }
			else
				spans.set(entry.path, {
					before: { ref: entry.before, root: turn.root },
					after: { ref: entry.after, root: turn.root },
				})
		}
	}
	const changed = [...spans].filter(([, span]) => !sameBody(span.before.ref, span.after.ref))
	const files = changed.map(([path]) => path)
	let insertions = 0
	let deletions = 0
	for (const [, span] of changed) {
		if (expired()) return { files }
		const counted = await countLines(span, readBody)
		if (!counted) return { files }
		insertions += counted.added
		deletions += counted.removed
	}
	return { files, insertions, deletions }
}

function sameBody(a: BlobRef | null, b: BlobRef | null): boolean {
	if (a === null || b === null) return a === b
	return a.sha256 === b.sha256
}

async function body(
	side: { ref: BlobRef | null; root: string },
	readBody: ReadBody,
): Promise<string | null | undefined> {
	if (side.ref === null) return null
	if (side.ref.stored === false || side.ref.size > REWIND_STATS_BODY_BYTES) return undefined
	try {
		const data = await readBody(side.root, side.ref.sha256)
		if (data.includes(0)) return undefined
		return Buffer.from(data).toString('utf8')
	} catch {
		return undefined
	}
}

async function countLines(
	span: Span,
	readBody: ReadBody,
): Promise<{ added: number; removed: number } | undefined> {
	const before = await body(span.before, readBody)
	const after = await body(span.after, readBody)
	if (before === undefined || after === undefined) return undefined
	const parts = diffLines(before ?? '', after ?? '', { maxEditLength: REWIND_STATS_MAX_EDITS })
	if (parts === undefined) return undefined
	let added = 0
	let removed = 0
	for (const part of parts) {
		if (part.added) added += part.count ?? 0
		else if (part.removed) removed += part.count ?? 0
	}
	return { added, removed }
}
