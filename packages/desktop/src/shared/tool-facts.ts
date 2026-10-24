import type { ToolFacts, ToolFailureReason } from '@namzu/sdk'

/**
 * The closed shape of what a tool reported about a call, read back from a saved conversation.
 *
 * The same rules as the SDK's `admitToolFacts`, kept here because the renderer must not pull the
 * whole SDK in at runtime for one function. A command's streams are never kept in a saved
 * conversation, so a restored row is headlined by its exit code and never shows output.
 */

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
const MAX_TEXT = 2_000

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined
const count = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const flag = (value: unknown): true | undefined => (value === true ? true : undefined)

function compact<T extends object>(entries: Record<string, unknown>): T {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value
	return out as T
}

export function publicFacts(value: unknown): ToolFacts | undefined {
	if (!record(value)) return undefined
	switch (value.kind) {
		case 'command':
			return compact<ToolFacts>({
				kind: 'command',
				command: text(value.command),
				exitCode:
					typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)
						? value.exitCode
						: undefined,
				timedOut: flag(value.timedOut),
				signal: text(value.signal),
				binary:
					record(value.binary) && count(value.binary.bytes) !== undefined
						? { bytes: count(value.binary.bytes) }
						: undefined,
				background: flag(value.background),
			})
		case 'read': {
			const path = text(value.path)
			if (path === undefined) return undefined
			return compact<ToolFacts>({
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
			return compact<ToolFacts>({
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
			return compact<ToolFacts>({
				kind: 'list',
				pattern,
				path: text(value.path),
				count: count(value.count),
				truncated: flag(value.truncated),
			})
		}
		case 'edit':
			return compact<ToolFacts>({
				kind: 'edit',
				path: text(value.path),
				replacements: count(value.replacements),
				added: count(value.added),
				removed: count(value.removed),
			})
		case 'write': {
			const path = text(value.path)
			const operation = WRITE_OPERATIONS.find((candidate) => candidate === value.operation)
			if (path === undefined || operation === undefined) return undefined
			return compact<ToolFacts>({
				kind: 'write',
				path,
				operation,
				bytes: count(value.bytes),
				added: count(value.added),
				removed: count(value.removed),
			})
		}
		case 'failure': {
			const reason = FAILURE_REASONS.find((candidate) => candidate === value.reason)
			if (reason === undefined) return undefined
			return compact<ToolFacts>({
				kind: 'failure',
				reason,
				subject: text(value.subject),
			})
		}
		default:
			return undefined
	}
}
