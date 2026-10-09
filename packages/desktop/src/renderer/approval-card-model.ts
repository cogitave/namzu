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
	/** The call writes a whole file rather than editing part of one. */
	write?: boolean
	/** A write to a path that already holds a file. Unknown without a preview. */
	overwrites?: boolean
	command?: string
	/** The text a message to a Pal would carry, drawn whole rather than summarised. */
	message?: string
	/** Who the message is for, when the Pal list names it. */
	palName?: string
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
/** The name of the tool an ordinary conversation uses to message a Pal. */
export const PAL_MESSAGE_TOOL = 'send_pal_message'

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

function palNameOf(call: Call, palNames?: ReadonlyMap<string, string>): string | undefined {
	const id = record(call.input) && typeof call.input.palId === 'string' ? call.input.palId : ''
	return palNames?.get(id)?.trim() || undefined
}

/** "Message to Review", or "Message to a Pal" while the Pal's name is unknown. */
function palMessageTitle(call: Call, palNames?: ReadonlyMap<string, string>): string {
	const name = palNameOf(call, palNames)
	return name ? `Message to ${name}` : 'Message to a Pal'
}

export function buildApprovalCard(
	permission: PermissionView,
	palNames?: ReadonlyMap<string, string>,
): ApprovalCardModel {
	const [first, ...rest] = permission.calls
	const others = rest.map((call) => cardTitle(call, palNames))
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
		const write = name === 'write'
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
				...(write ? { write, overwrites: !created } : {}),
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
			...(write ? { write } : {}),
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

	if (name === PAL_MESSAGE_TOOL && typeof input?.body === 'string') {
		const body = input.body
		return {
			kind: 'other',
			title: palMessageTitle(first, palNames),
			message: body,
			...(palNameOf(first, palNames) ? { palName: palNameOf(first, palNames) } : {}),
			previewMissing: false,
			entries: [],
			destructive: false,
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
function cardTitle(call: Call, palNames?: ReadonlyMap<string, string>): string {
	const name = call.name.toLowerCase()
	if (name === PAL_MESSAGE_TOOL) return palMessageTitle(call, palNames)
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

/** Why the card has no "before" to show, and what is shown instead, in plain words. */
export function previewNote(model: ApprovalCardModel): string {
	if (!model.diff) return 'Namzu couldn’t show a preview of this change.'
	return model.write
		? `Namzu couldn’t show what’s in ${model.fileName ?? 'the file'} now. This is what it wants to write.`
		: 'Namzu couldn’t show the whole file. This is the part it wants to change.'
}

/** The caution under a change that removes or replaces something, naming what it touches. */
export function approvalWarning(model: ApprovalCardModel): string {
	const file = model.fileName
	switch (model.kind) {
		case 'delete':
			return file ? `This deletes ${file}.` : 'This deletes a file.'
		case 'edit':
			if (file && model.overwrites) return `This replaces ${file}, which already exists.`
			if (file && model.write) return `This writes over ${file} if it already exists.`
			return file ? `This changes ${file}.` : 'This changes a file.'
		case 'command':
			return 'This command can change or remove files on your computer.'
		default:
			return 'This action can change or remove data.'
	}
}

/** Commands whose effect on a person's files is hard to take back. */
const RISKY_COMMAND =
	/(^|[\s;&|])(rm\s+-[a-z]*[rf]|rmdir|del\s|rd\s|sudo\s|mkfs|dd\s+if=|shred|truncate\s|chmod\s+-R|chown\s+-R)|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|>\s*\/dev\/sd/i

/** True when a command line looks like it deletes or overwrites data. */
export function riskyCommand(command: string): boolean {
	return RISKY_COMMAND.test(command)
}

/**
 * One sentence on what saying yes lets happen: where it happens and what it can change.
 * Nothing for an action the card already explains by its own content.
 */
export function approvalConsequence(model: ApprovalCardModel, folder?: string): string | undefined {
	const where = folder?.trim()
	if (model.kind === 'command') {
		const risky = model.command !== undefined && riskyCommand(model.command)
		const base = where ? `Runs on your computer in ${where}.` : 'Runs on your computer.'
		return risky
			? `${base} This command looks like it deletes or overwrites files, so check it before you accept.`
			: `${base} It can read and change files there.`
	}
	if (model.kind === 'delete') return 'Removes this file from your computer.'
	if (model.kind === 'create' && model.path) return `Adds a new file at ${model.path}.`
	if (model.kind === 'edit' && model.path) return `Changes the file at ${model.path}.`
	return undefined
}

/**
 * What happens to a message once the person approves it, in the order it happens: it is delivered
 * to the Pal's inbox, the Pal reads it the next time it runs, and starting the Pal is a separate act.
 */
export function palMessageNote(name: string | undefined): string {
	const owner = name ? `${name}’s` : 'the Pal’s'
	const pal = name ?? 'the Pal'
	return `Goes to ${owner} inbox. ${name ?? 'The Pal'} reads it the next time it runs; sending does not start it. To start ${pal}, run “namzu pal dispatch” in a terminal. You are asked again for each message.`
}
