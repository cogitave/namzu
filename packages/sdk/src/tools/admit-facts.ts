import type { ToolDiffHunk, ToolFacts, ToolFailureReason } from '../types/tool/presentation.js'

const FAILURE_REASONS: readonly ToolFailureReason[] = [
	'not_found',
	'permission_denied',
	'not_a_file',
	'already_exists',
	'blocked',
	'needs_administrator',
	'unknown_tool',
	'timed_out',
	'invalid_input',
]

const WRITE_OPERATIONS = ['created', 'updated', 'unchanged', 'wrote'] as const

/** Bounds on what a saved record is allowed to hold. */
const MAX_TEXT = 2_000
const MAX_COUNT = Number.MAX_SAFE_INTEGER

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= MAX_COUNT
		? value
		: undefined
}

function flag(value: unknown): true | undefined {
	return value === true ? true : undefined
}

function pick<T extends object>(entries: Record<string, unknown>): T {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value
	return out as T
}

const MAX_HUNKS = 100
const MAX_HUNK_ROWS = 400
const MAX_ROW_CHARS = 600

/** Hunks read back from a record: bounded, every row marked, or dropped as a whole. */
function hunks(value: unknown): readonly ToolDiffHunk[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_HUNKS) return undefined
	const out: ToolDiffHunk[] = []
	let rows = 0
	for (const entry of value) {
		if (!isRecord(entry) || !Array.isArray(entry.lines)) return undefined
		const oldStart = count(entry.oldStart)
		const oldLines = count(entry.oldLines)
		const newStart = count(entry.newStart)
		const newLines = count(entry.newLines)
		if (
			oldStart === undefined ||
			oldLines === undefined ||
			newStart === undefined ||
			newLines === undefined
		)
			return undefined
		rows += entry.lines.length
		if (rows > MAX_HUNK_ROWS) return undefined
		const lines: string[] = []
		for (const row of entry.lines) {
			if (
				typeof row !== 'string' ||
				row.length > MAX_ROW_CHARS ||
				!(row.startsWith(' ') || row.startsWith('+') || row.startsWith('-'))
			)
				return undefined
			lines.push(row)
		}
		out.push({ oldStart, oldLines, newStart, newLines, lines })
	}
	return out.length > 0 ? out : undefined
}

/**
 * Read a recorded `ToolFacts` back into the closed shape, or `undefined` when
 * it is not one. A journal is read by hosts that did not write it, and an
 * extension field must not travel on into a screen.
 *
 * The text of a command's streams is a live-only convenience and a saved
 * conversation does not keep it, so it is dropped here: what remains is
 * enough to headline the row ("Ran npm test, failed (exit 1)") and never the
 * output itself.
 */
export function admitToolFacts(value: unknown): ToolFacts | undefined {
	if (!isRecord(value)) return undefined
	switch (value.kind) {
		case 'command':
			return pick<ToolFacts>({
				kind: 'command',
				command: text(value.command),
				exitCode:
					typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)
						? value.exitCode
						: undefined,
				exitNote: text(value.exitNote),
				timedOut: flag(value.timedOut),
				signal: text(value.signal),
				binary:
					isRecord(value.binary) && count(value.binary.bytes) !== undefined
						? { bytes: count(value.binary.bytes) }
						: undefined,
				background: flag(value.background),
			})
		case 'read': {
			const path = text(value.path)
			if (path === undefined) return undefined
			return pick<ToolFacts>({
				kind: 'read',
				path,
				binary: flag(value.binary),
				bytes: count(value.bytes),
				totalLines: count(value.totalLines),
				returnedLines: count(value.returnedLines),
				partial: flag(value.partial),
			})
		}
		case 'search': {
			const pattern = text(value.pattern)
			if (pattern === undefined) return undefined
			return pick<ToolFacts>({
				kind: 'search',
				pattern,
				path: text(value.path),
				matches: count(value.matches),
				filesMatched: count(value.filesMatched),
				filesSearched: count(value.filesSearched),
				truncated: flag(value.truncated),
			})
		}
		case 'list': {
			const pattern = text(value.pattern)
			if (pattern === undefined) return undefined
			return pick<ToolFacts>({
				kind: 'list',
				pattern,
				path: text(value.path),
				count: count(value.count),
				truncated: flag(value.truncated),
			})
		}
		case 'edit':
			return pick<ToolFacts>({
				kind: 'edit',
				path: text(value.path),
				replacements: count(value.replacements),
				added: count(value.added),
				removed: count(value.removed),
				hunks: hunks(value.hunks),
				hunksTruncated: flag(value.hunksTruncated),
			})
		case 'write': {
			const path = text(value.path)
			const operation = WRITE_OPERATIONS.find((candidate) => candidate === value.operation)
			if (path === undefined || operation === undefined) return undefined
			return pick<ToolFacts>({
				kind: 'write',
				path,
				operation,
				bytes: count(value.bytes),
				added: count(value.added),
				removed: count(value.removed),
				hunks: hunks(value.hunks),
				hunksTruncated: flag(value.hunksTruncated),
			})
		}
		case 'failure': {
			const reason = FAILURE_REASONS.find((candidate) => candidate === value.reason)
			if (reason === undefined) return undefined
			return pick<ToolFacts>({
				kind: 'failure',
				reason,
				subject: text(value.subject),
			})
		}
		default:
			return undefined
	}
}
