import { open, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative } from 'node:path'

import type { FileReadTracker } from '@namzu/sdk'
import { structuredPatch } from 'diff'

import { frameReminder } from './frame.js'

/**
 * Files the model read whole that someone else has since changed.
 *
 * An edit against a file that moved under the model is refused, which costs a
 * turn and tells the model only that its copy is stale. This says so first, with
 * what changed, so the model plans against the file as it is now and does not
 * put the old text back. A notice is not a full read: it may omit content or
 * show only a diff. Keep the mutation ledger unchanged until a real read
 * supplies the current file, even when the notice is delivered only once.
 */

// The tracker retains at most 512 Ki characters. UTF-8 needs at most four
// bytes per character; larger files cannot equal a retained body. Read one
// sentinel byte beyond the ceiling so growth after stat cannot allocate freely.
const MAX_COMPARISON_BYTES = 2 * 1024 * 1024

async function comparisonBody(path: string, size: number): Promise<string | undefined> {
	if (size > MAX_COMPARISON_BYTES) return undefined
	const file = await open(path, 'r')
	try {
		const buffer = Buffer.alloc(MAX_COMPARISON_BYTES + 1)
		let used = 0
		while (used < buffer.length) {
			const { bytesRead } = await file.read(buffer, used, buffer.length - used, used)
			if (bytesRead === 0) break
			used += bytesRead
		}
		return used > MAX_COMPARISON_BYTES ? undefined : buffer.toString('utf8', 0, used)
	} finally {
		await file.close()
	}
}

/** Unchanged lines shown around each changed part. */
export const CHANGED_FILE_CONTEXT_LINES = 8
/** Most characters of changed text for one file. */
export const CHANGED_FILE_MAX_CHARS = 8192
/** Most characters of complete reminders per request, including names, frames and separators. */
export const CHANGED_FILES_TOTAL_MAX_CHARS = 16384
/** A diff that takes longer than this is not shown; the notice then says to read the file. */
const DIFF_TIMEOUT_MS = 2000

const SECRET_NAME =
	/^(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\..*)?)$/i
const SECRET_EXTENSION = /\.(pem|key|p12|pfx|keystore|jks)$/i

/** Whether the text of a file with this name stays out of a reminder, which the transcript keeps. */
export function keepsContentOut(path: string): boolean {
	const name = basename(path)
	return SECRET_NAME.test(name) || SECRET_EXTENSION.test(name)
}

/**
 * The changed parts of a file as the model should see them now: the new-side
 * lines of each changed part with eight lines of context and their line
 * numbers, parts separated by `...`, within both the file and remaining total
 * budget, including the truncation marker.
 */
export function changedSnippet(
	before: string,
	after: string,
	maxChars = CHANGED_FILE_MAX_CHARS,
): string {
	const limit = Math.max(0, Math.min(CHANGED_FILE_MAX_CHARS, maxChars))
	if (limit === 0) return ''
	const patch = structuredPatch('a', 'a', before, after, undefined, undefined, {
		context: CHANGED_FILE_CONTEXT_LINES,
		timeout: DIFF_TIMEOUT_MS,
	})
	if (patch === undefined) return ''
	const parts = patch.hunks.map((hunk) => {
		let line = hunk.newStart
		const rows: string[] = []
		for (const row of hunk.lines) {
			if (row.startsWith('\\') || row.startsWith('-')) continue
			rows.push(`${line}\t${row.slice(1)}`)
			line++
		}
		return rows.join('\n')
	})
	const text = parts.join('\n...\n')
	if (text.length <= limit) return text
	const marker = '\n... [more lines not shown; read the file for the rest] ...'
	if (marker.length >= limit) return ''
	const room = limit - marker.length
	const cut = text.lastIndexOf('\n', room)
	const kept = text.slice(0, cut > 0 ? cut : room)
	return `${kept}${marker}`
}

function notice(shown: string, snippet: string): string {
	const head = `${shown} changed on disk since you last read it. That is usually deliberate: treat the file as it is now and do not put the old text back. If the change looks wrong, say so instead of undoing it; otherwise there is no need to mention it.`
	return snippet === ''
		? `${head} The changes are not shown here; read the file if you need its current content.`
		: `${head} The changed parts, with line numbers:\n${snippet}`
}

/** When each file was last compared, so a quiet file costs a stat and not a read. */
const compared = new WeakMap<object, Map<string, number>>()

export interface ChangedFilesInput {
	readonly tracker: Pick<FileReadTracker, 'fullBody' | 'fullBodyPaths' | 'recordDriftObserved'>
	/** Paths in the notice are shown relative to this directory when they lie under it. */
	readonly cwd: string
}

/** One reminder per fully read file whose content is no longer what the model read; empty when nothing moved. */
export async function changedFileReminders(input: ChangedFilesInput): Promise<string[]> {
	const { tracker } = input
	if (!tracker.fullBodyPaths || !tracker.fullBody) return []
	let seen = compared.get(tracker)
	if (!seen) {
		seen = new Map()
		compared.set(tracker, seen)
	}
	const out: string[] = []
	let shownChars = 0
	for (const path of tracker.fullBodyPaths()) {
		const before = tracker.fullBody(path)
		if (before === undefined || !isAbsolute(path)) continue
		let after: string | undefined
		try {
			const { mtimeMs, size } = await stat(path)
			if (seen.get(path) === mtimeMs) continue
			seen.set(path, mtimeMs)
			after = await comparisonBody(path, size)
		} catch {
			// A file that is gone or unreadable is the edit tool's to report.
			continue
		}
		if (after === before) continue
		tracker.recordDriftObserved?.(path)
		const rel = relative(input.cwd, path)
		const shown = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
		const separator = out.length === 0 ? 0 : 1
		const remaining = CHANGED_FILES_TOTAL_MAX_CHARS - shownChars - separator
		const plain = frameReminder('changed-file', notice(shown, ''))
		if (plain.length > remaining) {
			// A withheld notice is still owed, even if the file never changes again.
			seen.delete(path)
			continue
		}
		const overhead = frameReminder('changed-file', notice(shown, ' ')).length - 1
		const snippet =
			after === undefined || keepsContentOut(path) || before === ''
				? ''
				: changedSnippet(before, after, remaining - overhead)
		const text = snippet === '' ? plain : frameReminder('changed-file', notice(shown, snippet))
		shownChars += separator + text.length
		out.push(text)
	}
	return out
}
