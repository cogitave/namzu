import { PERMISSION_FEEDBACK_MAX } from '../shared/permission-protocol.js'
import type { PermissionPreview, PermissionView } from '../shared/protocol.js'
import { changeTotals } from './changes-totals.js'

type Call = PermissionView['calls'][number]

export type ApprovalKind = 'edit' | 'create' | 'delete' | 'command' | 'other'

export interface ApprovalCardModel {
	kind: ApprovalKind
	title: string
	fileName?: string
	/** The full path, for the tooltip. */
	path?: string
	/** The diff to draw: the real preview, or the fragment the call itself carries. */
	diff?: { path: string; before: string; after: string; fragment: boolean }
	added?: number
	removed?: number
	/** A file change from an engine that sent no preview: the card says so. */
	previewMissing: boolean
	command?: string
	/** A readable summary of any other tool's arguments. */
	entries: { label: string; value: string }[]
	destructive: boolean
	/** Titles of the other calls of the same batch, which one answer covers. */
	others: string[]
}

const FILE_TOOLS = new Set(['edit', 'write', 'multiedit'])
const DELETE_TOOLS = new Set(['delete', 'delete_file', 'remove', 'remove_file'])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'run_command', 'exec'])
const VALUE_MAX = 240

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

export function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '')
	return trimmed.split(/[\\/]/).pop() || trimmed || path
}

/** "web_fetch" reads as "web fetch" in a sentence. */
function plainName(name: string): string {
	return name.replace(/[_-]+/g, ' ').trim() || 'this action'
}

function sentenceCase(value: string): string {
	return value ? value[0]?.toUpperCase() + value.slice(1) : value
}

function clip(text: string): string {
	return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX)}…` : text
}

export function summarizeInput(input: unknown): { label: string; value: string }[] {
	if (!record(input)) {
		if (input === undefined || input === null) return []
		return [{ label: 'Input', value: clip(String(input)) }]
	}
	return Object.entries(input)
		.slice(0, 8)
		.map(([key, value]) => ({
			label: sentenceCase(plainName(key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())),
			value:
				typeof value === 'string'
					? clip(value)
					: typeof value === 'number' || typeof value === 'boolean'
						? String(value)
						: clip(JSON.stringify(value) ?? ''),
		}))
}

/** The pieces of a file change a call carries in its own arguments, joined into one before and after. */
function fragmentOf(call: Call): { before: string; after: string } | undefined {
	const input = call.input
	if (!record(input)) return undefined
	const name = call.name.toLowerCase()
	const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
	if (name === 'write') {
		const body = text(input.content) ?? text(input.newStr)
		return body === undefined
			? undefined
			: { before: '', after: body.endsWith('\n') || body === '' ? body : `${body}\n` }
	}
	const pairs: { before: string; after: string }[] = []
	const edits = Array.isArray(input.edits) ? input.edits : [input]
	for (const edit of edits) {
		if (!record(edit)) continue
		const before = text(edit.old_string) ?? text(edit.oldStr)
		const after = text(edit.new_string) ?? text(edit.newStr)
		if (after === undefined) continue
		pairs.push({ before: before ?? '', after })
	}
	if (pairs.length === 0) return undefined
	// A fragment is not a whole file, so it ends in the newline a diff expects rather than
	// drawing "No newline at end of file" under every side.
	const joined = (parts: string[]) => {
		const text = parts.join('\n')
		return text === '' || text.endsWith('\n') ? text : `${text}\n`
	}
	return {
		before: joined(pairs.map((pair) => pair.before)),
		after: joined(pairs.map((pair) => pair.after)),
	}
}

function pathOf(call: Call): string | undefined {
	if (call.preview) return call.preview.path
	if (!record(call.input)) return undefined
	const path = call.input.path ?? call.input.file_path ?? call.input.filePath
	return typeof path === 'string' && path.trim() ? path : undefined
}

function counts(before: string, after: string, path: string) {
	const totals = changeTotals([{ path, before, after }])
	return { added: totals.added, removed: totals.removed }
}

function fromPreview(preview: PermissionPreview) {
	return {
		path: preview.path,
		before: preview.before ?? '',
		after: preview.after,
		fragment: false,
	}
}

export function buildApprovalCard(permission: PermissionView): ApprovalCardModel {
	const [first, ...rest] = permission.calls
	const others = rest.map((call) => cardTitle(call))
	if (!first) {
		return {
			kind: 'other',
			title: 'Allow this action?',
			previewMissing: false,
			entries: [],
			destructive: false,
			others,
		}
	}
	const name = first.name.toLowerCase()
	const destructive = permission.calls.some((call) => call.isDestructive)
	const path = pathOf(first)
	const input = record(first.input) ? first.input : undefined

	if (FILE_TOOLS.has(name) && path) {
		const fileName = baseName(path)
		const created = name === 'write' && first.preview?.before === null
		const kind: ApprovalKind = created ? 'create' : 'edit'
		const title = `${created ? 'Create' : name === 'write' ? 'Write' : 'Edit'} ${fileName}?`
		if (first.preview) {
			const diff = fromPreview(first.preview)
			return {
				kind,
				title,
				fileName,
				path,
				diff,
				...counts(diff.before, diff.after, path),
				previewMissing: false,
				entries: [],
				destructive,
				others,
			}
		}
		const fragment = fragmentOf(first)
		return {
			kind,
			title,
			fileName,
			path,
			...(fragment
				? {
						diff: { path, ...fragment, fragment: true },
						...counts(fragment.before, fragment.after, path),
					}
				: {}),
			previewMissing: true,
			entries: [],
			destructive,
			others,
		}
	}

	if (DELETE_TOOLS.has(name) && path) {
		return {
			kind: 'delete',
			title: `Delete ${baseName(path)}?`,
			fileName: baseName(path),
			path,
			previewMissing: false,
			entries: [],
			destructive: true,
			others,
		}
	}

	const command = typeof input?.command === 'string' ? input.command : undefined
	if (command !== undefined && (COMMAND_TOOLS.has(name) || !input?.path)) {
		return {
			kind: 'command',
			title: 'Run this command?',
			command,
			previewMissing: false,
			entries: [],
			destructive,
			others,
		}
	}

	return {
		kind: 'other',
		title: `Allow ${plainName(first.name)}?`,
		previewMissing: false,
		entries: summarizeInput(first.input),
		destructive,
		others,
	}
}

/** One-line title for a call that is only mentioned, not drawn. */
function cardTitle(call: Call): string {
	const name = call.name.toLowerCase()
	const path = pathOf(call)
	if (FILE_TOOLS.has(name) && path)
		return `${name === 'write' ? 'Write' : 'Edit'} ${baseName(path)}`
	if (DELETE_TOOLS.has(name) && path) return `Delete ${baseName(path)}`
	if (record(call.input) && typeof call.input.command === 'string')
		return `Run ${clip(call.input.command)}`
	return sentenceCase(plainName(call.name))
}

const FEEDBACK_PREFIX = 'The user declined this change and said: '
/** What the person can type, so the note plus its prefix still fits the wire limit. */
export const FEEDBACK_NOTE_MAX = PERMISSION_FEEDBACK_MAX - FEEDBACK_PREFIX.length

/** The text that reaches the model when the person redirects instead of just rejecting. */
export function declineFeedback(note: string): string {
	return `${FEEDBACK_PREFIX}${note.trim()}`
}
