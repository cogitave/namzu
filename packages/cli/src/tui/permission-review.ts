import { terminalDisplayText } from './terminal-display.js'

/**
 * Maximum exact permission envelope handed to an interactive reviewer.
 *
 * This is a refusal boundary, not a display truncation boundary. A call above
 * it is not offered for approval and is not executed. Keeping the limit on the
 * complete batch also prevents many individually-small calls from turning one
 * consent prompt into an unbounded allocation.
 */
export const MAX_PERMISSION_REVIEW_BYTES = 8_000

/** Physical rows kept visible without crowding a 24-row terminal. */
export const PERMISSION_REVIEW_PAGE_ROWS = 6

export interface PermissionReviewCall {
	readonly id: string
	readonly name: string
	readonly input: unknown
	readonly isDestructive: boolean
}

export type PermissionReviewResult =
	| { readonly ok: true; readonly text: string; readonly bytes: number }
	| { readonly ok: false; readonly reason: 'too_large' | 'unrepresentable' }

export interface PermissionReviewSummary {
	/** Complete, terminal-safe source for the readable pager. */
	readonly text: string
	/** True only when the formatter knows every executable input field. */
	readonly complete: boolean
}

interface ReadableCallSummary {
	readonly lines: readonly string[]
	readonly complete: boolean
	/** Short batch-row label; the full value remains in `lines`. */
	readonly label?: string
}

/** Actionable fail-closed feedback for a TUI review that cannot be exact. */
export function permissionReviewRefusal(reason: 'too_large' | 'unrepresentable'): string {
	return reason === 'too_large'
		? `Refused: the complete tool batch exceeds the ${MAX_PERMISSION_REVIEW_BYTES}-byte interactive review limit. Split it into smaller calls or add an explicit allow rule after reviewing the operation another way.`
		: 'Refused: this tool batch contains input the interactive permission protocol cannot represent exactly. Use JSON-compatible input or add an explicit allow rule after reviewing the operation another way.'
}

/** One terminal row of the source-preserving permission projection. */
export interface PermissionReviewRow {
	/** Stable absolute position in the projected review. */
	readonly index: number
	readonly text: string
	/** True when this row continues the logical line above it. */
	readonly continuation: boolean
}

class ReviewLimitError extends Error {}
class ReviewShapeError extends Error {}

/**
 * Serialize the exact executable batch without invoking getters or `toJSON`.
 *
 * `ToolRegistry.prepareExecution()` already publishes detached JSON values,
 * but this is a host boundary and structural SDK implementations can still
 * supply `unknown`. Ordinary `JSON.stringify` would execute an accessor and
 * could silently turn a Date/Map/custom object into something other than the
 * value being approved. The bounded writer accepts only the JSON graph the
 * permission protocol can preserve and stops building as soon as the complete
 * envelope crosses the limit.
 */
export function buildPermissionReview(
	calls: readonly PermissionReviewCall[],
	maxBytes = MAX_PERMISSION_REVIEW_BYTES,
): PermissionReviewResult {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		return { ok: false, reason: 'unrepresentable' }
	}

	const chunks: string[] = []
	let bytes = 0
	const active = new WeakSet<object>()

	const append = (chunk: string): void => {
		bytes += Buffer.byteLength(chunk, 'utf8')
		if (bytes > maxBytes) throw new ReviewLimitError()
		chunks.push(chunk)
	}

	const appendString = (value: string): void => {
		// JSON escaping only grows a string. Avoid materialising an escaped copy
		// when the source alone has already crossed the complete-envelope cap.
		if (Buffer.byteLength(value, 'utf8') > maxBytes - bytes) throw new ReviewLimitError()
		append(JSON.stringify(value))
	}

	const write = (value: unknown, indent: number): void => {
		if (value === null) {
			append('null')
			return
		}
		switch (typeof value) {
			case 'string':
				appendString(value)
				return
			case 'boolean':
				append(value ? 'true' : 'false')
				return
			case 'number':
				if (!Number.isFinite(value) || Object.is(value, -0)) throw new ReviewShapeError()
				append(String(value))
				return
			case 'object':
				break
			default:
				throw new ReviewShapeError()
		}

		const object = value as object
		if (active.has(object)) throw new ReviewShapeError()
		active.add(object)
		try {
			if (Array.isArray(value)) {
				const descriptors = Object.getOwnPropertyDescriptors(value)
				if (Object.getOwnPropertySymbols(value).length > 0) throw new ReviewShapeError()
				const names = Object.getOwnPropertyNames(value)
				if (
					names.some(
						(name) =>
							name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= value.length),
					)
				)
					throw new ReviewShapeError()

				append('[')
				if (value.length > 0) append('\n')
				for (let index = 0; index < value.length; index += 1) {
					const descriptor = descriptors[String(index)]
					if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
						throw new ReviewShapeError()
					append(' '.repeat(indent + 2))
					write(descriptor.value, indent + 2)
					append(index === value.length - 1 ? '\n' : ',\n')
				}
				if (value.length > 0) append(' '.repeat(indent))
				append(']')
				return
			}

			const prototype = Object.getPrototypeOf(value)
			if (prototype !== Object.prototype && prototype !== null) throw new ReviewShapeError()
			if (Object.getOwnPropertySymbols(value).length > 0) throw new ReviewShapeError()
			const descriptors = Object.getOwnPropertyDescriptors(value)
			const entries = Object.keys(value)
			for (const name of Object.getOwnPropertyNames(value)) {
				const descriptor = descriptors[name]
				if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
					throw new ReviewShapeError()
			}

			append('{')
			if (entries.length > 0) append('\n')
			for (let index = 0; index < entries.length; index += 1) {
				const key = entries[index] as string
				const descriptor = descriptors[key]
				if (!descriptor || !('value' in descriptor)) throw new ReviewShapeError()
				append(' '.repeat(indent + 2))
				appendString(key)
				append(': ')
				write(descriptor.value, indent + 2)
				append(index === entries.length - 1 ? '\n' : ',\n')
			}
			if (entries.length > 0) append(' '.repeat(indent))
			append('}')
		} finally {
			active.delete(object)
		}
	}

	try {
		const exactCalls = calls.map((call) => {
			const prototype = Object.getPrototypeOf(call)
			if (prototype !== Object.prototype && prototype !== null) throw new ReviewShapeError()
			if (Object.getOwnPropertySymbols(call).length > 0) throw new ReviewShapeError()
			const descriptors = Object.getOwnPropertyDescriptors(call)
			const id = descriptors.id
			const name = descriptors.name
			const input = descriptors.input
			const isDestructive = descriptors.isDestructive
			if (
				!id ||
				!('value' in id) ||
				typeof id.value !== 'string' ||
				!name ||
				!('value' in name) ||
				typeof name.value !== 'string' ||
				!input ||
				!('value' in input) ||
				!isDestructive ||
				!('value' in isDestructive) ||
				typeof isDestructive.value !== 'boolean'
			)
				throw new ReviewShapeError()
			return {
				id: id.value,
				name: name.value,
				input: input.value,
				isDestructive: isDestructive.value,
			}
		})
		write(
			{
				calls: exactCalls,
			},
			0,
		)
		return { ok: true, text: chunks.join(''), bytes }
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof ReviewLimitError ? 'too_large' : 'unrepresentable',
		}
	}
}

/**
 * Derive a readable review from the immutable exact envelope.
 *
 * This never reads the original tool objects: `buildPermissionReview` has
 * already rejected getters, prototypes and non-JSON values. A summary is
 * `complete` when it shows every key of every call, and callers open the
 * readable view by default only then — so a friendly label can never hide a
 * suffix. Two ways to be complete: a formatter below whose key set and value
 * types are exhaustive, or, for a tool no formatter here knows (`read`,
 * `grep`, a connected server's tool), every key with its full JSON-escaped
 * value. A tool that HAS a formatter but arrives in a shape it does not know
 * is the one case that opens exact-first: the formatter is stale, and a
 * reader should see that rather than a projection that happens to be right.
 */
export function buildPermissionSummary(review: string): PermissionReviewSummary {
	let parsed: unknown
	try {
		parsed = JSON.parse(review)
	} catch {
		return { text: review, complete: false }
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.calls)) {
		return { text: review, complete: false }
	}

	const calls: Array<{
		readonly name: string
		readonly isDestructive: boolean
		readonly readable: ReadableCallSummary
	}> = []
	let complete = true
	for (let index = 0; index < parsed.calls.length; index += 1) {
		const call = parsed.calls[index]
		if (
			!isRecord(call) ||
			typeof call.name !== 'string' ||
			typeof call.isDestructive !== 'boolean' ||
			!Object.hasOwn(call, 'input')
		) {
			return { text: review, complete: false }
		}
		const readable = summarizeKnownCall(call.name, call.input)
		complete &&= readable.complete
		calls.push({ name: call.name, isDestructive: call.isDestructive, readable })
	}

	if (
		complete &&
		calls.length > 1 &&
		calls.every((call) => call.name === 'Agent' && call.readable.label !== undefined)
	) {
		const overview = calls.map((call, index) => `${index + 1}. ${call.readable.label as string}`)
		const details = calls.map((call, index) =>
			[
				`${index + 1}. ${call.readable.label as string}`,
				...call.readable.lines.map((line) => `   ${line}`),
			].join('\n'),
		)
		return {
			text: [...overview, '', 'Task details', '', ...details].join('\n'),
			complete: true,
		}
	}

	return {
		text: calls
			.map((call, index) =>
				[
					`${index + 1}. ${call.name}${call.isDestructive ? ' · destructive' : ''}`,
					...call.readable.lines.map((line) => `   ${line}`),
				].join('\n'),
			)
			.join('\n\n'),
		complete,
	}
}

function summarizeKnownCall(name: string, input: unknown): ReadableCallSummary {
	if (name === 'bash' && isRecord(input)) {
		const allowed = new Set(['command', 'timeout', 'run_in_background'])
		const keys = Object.keys(input)
		const shapeIsKnown =
			keys.every((key) => allowed.has(key)) &&
			typeof input.command === 'string' &&
			(input.timeout === undefined || typeof input.timeout === 'number') &&
			(input.run_in_background === undefined || typeof input.run_in_background === 'boolean')
		if (shapeIsKnown) {
			return {
				lines: [
					`$ ${JSON.stringify(input.command)}`,
					...(input.timeout !== undefined ? [`timeout: ${String(input.timeout)} ms`] : []),
					...(input.run_in_background !== undefined
						? [`background: ${input.run_in_background ? 'yes' : 'no'}`]
						: []),
				],
				complete: true,
			}
		}
	}

	if (name === 'edit' && isRecord(input)) {
		const summary = summarizeEdit(input)
		if (summary) return summary
	}

	if (name === 'write' && isRecord(input)) {
		const allowed = new Set(['path', 'content', 'newStr'])
		const keys = Object.keys(input)
		const body = typeof input.content === 'string' ? input.content : input.newStr
		const shapeIsKnown =
			keys.every((key) => allowed.has(key)) &&
			typeof input.path === 'string' &&
			typeof body === 'string' &&
			// One body, not two: a call carrying both is an evolved shape the
			// exact view has to show, not one this summary may pick a half of.
			(input.content === undefined) !== (input.newStr === undefined)
		if (shapeIsKnown) {
			const lines = (body as string).split('\n')
			return {
				lines: [
					`${input.path as string} · write ${lines.length} line${lines.length === 1 ? '' : 's'}`,
					...diffLines('+', lines),
				],
				complete: true,
			}
		}
	}

	if (name === 'Agent' && isRecord(input)) {
		const allowed = new Set([
			'description',
			'prompt',
			'subagent_type',
			'role',
			'workflow',
			'phase',
			'phase_order',
		])
		const keys = Object.keys(input)
		const shapeIsKnown =
			keys.every((key) => allowed.has(key)) &&
			typeof input.description === 'string' &&
			typeof input.prompt === 'string' &&
			(input.subagent_type === undefined || typeof input.subagent_type === 'string') &&
			(input.role === undefined || typeof input.role === 'string') &&
			(input.workflow === undefined || typeof input.workflow === 'string') &&
			(input.phase === undefined || typeof input.phase === 'string') &&
			(input.phase_order === undefined ||
				(typeof input.phase_order === 'number' && Number.isSafeInteger(input.phase_order)))
		if (shapeIsKnown) {
			const known = input as {
				description: string
				prompt: string
				subagent_type?: string
				role?: string
				workflow?: string
				phase?: string
				phase_order?: number
			}
			return {
				lines: [
					...readableField('Task', known.description),
					...(known.subagent_type !== undefined
						? [
								`Type: ${known.subagent_type}${known.subagent_type === 'explore' ? ' (read-only)' : ''}`,
							]
						: []),
					...readableField('Instructions', known.prompt),
					...(known.role !== undefined ? readableField('Specialist', known.role) : []),
					...(known.workflow !== undefined ? readableField('Workflow', known.workflow) : []),
					...(known.phase !== undefined ? readableField('Phase', known.phase) : []),
					...(known.phase_order !== undefined
						? [`Phase order: ${String(known.phase_order + 1)}`]
						: []),
				],
				complete: true,
				label: oneLine(known.description),
			}
		}
	}

	if (FORMATTED_TOOLS.has(name)) {
		// A shape this file formats, in a form it does not know: the formatter
		// is stale. Exact-first, so nobody reads a projection that merely
		// happens to be right.
		return { lines: [`input: ${JSON.stringify(input)}`], complete: false }
	}

	// A name that is not a plain token — a control character, a bidi mark —
	// is the kind of thing the exact view exists to expose. Exact-first.
	if (!PLAIN_TOOL_NAME.test(name)) {
		return { lines: [`input: ${JSON.stringify(input)}`], complete: false }
	}

	// No formatter, so nothing can be stale: every key, every value, escaped
	// so a value cannot pose as a key or drive the terminal.
	if (isRecord(input)) {
		const keys = Object.keys(input)
		return {
			lines:
				keys.length === 0
					? ['(no input)']
					: keys.map((key) => `${key}: ${JSON.stringify(input[key])}`),
			complete: true,
		}
	}
	return { lines: [`input: ${JSON.stringify(input)}`], complete: true }
}

const PLAIN_TOOL_NAME = /^[\w.:-]+$/u

/** The tools with a formatter above; an evolved shape of one opens exact-first. */
const FORMATTED_TOOLS: ReadonlySet<string> = new Set(['bash', 'edit', 'write', 'Agent'])

function oneLine(value: string): string {
	return value.replace(/\s+/gu, ' ').trim() || '(untitled task)'
}

/** Lines of one side of a change shown before the rest is counted. */
const DIFF_PREVIEW_LINES = 40

/**
 * One side of a change as review lines: `- old` / `+ new`, one per source
 * line, cut at `DIFF_PREVIEW_LINES` with the remainder counted. The prefix is
 * what the overlay colours on; the exact view (`d`) still has every byte.
 */
function diffLines(sign: '+' | '-', lines: readonly string[]): readonly string[] {
	const shown = lines.slice(0, DIFF_PREVIEW_LINES).map((line) => `${sign} ${line}`)
	const hidden = lines.length - shown.length
	return hidden > 0 ? [...shown, `${sign} … ${hidden} more line${hidden === 1 ? '' : 's'}`] : shown
}

/**
 * An `edit` as the change it makes, not as the JSON it arrived in.
 *
 * The tool has three shapes — one replacement (`old_string`/`new_string`, with
 * the `oldStr`/`newStr` aliases), an insertion (`insertLine` + new text), and a
 * list of replacements (`edits`) applied as one write — and each becomes `-`
 * and `+` lines under the path. Returns `null` for a shape this does not know
 * so the caller falls through to the exact-input view rather than showing a
 * half of the call.
 */
function summarizeEdit(input: Record<string, unknown>): ReadableCallSummary | null {
	const allowed = new Set([
		'path',
		'old_string',
		'oldStr',
		'new_string',
		'newStr',
		'insertLine',
		'replace_all',
		'edits',
	])
	if (!Object.keys(input).every((key) => allowed.has(key))) return null
	if (typeof input.path !== 'string') return null
	const path = input.path

	const oldText = pickString(input, 'old_string', 'oldStr')
	const newText = pickString(input, 'new_string', 'newStr')
	if (oldText === undefined || newText === undefined) return null
	const replaceAll = input.replace_all
	if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return null

	// A list of replacements, applied together.
	if (input.edits !== undefined) {
		if (!Array.isArray(input.edits) || oldText.value !== null || newText.value !== null) return null
		const lines: string[] = [
			`${path} · ${input.edits.length} replacement${input.edits.length === 1 ? '' : 's'}`,
		]
		for (const [index, edit] of input.edits.entries()) {
			if (
				!isRecord(edit) ||
				typeof edit.old_string !== 'string' ||
				typeof edit.new_string !== 'string'
			) {
				return null
			}
			if (edit.replace_all !== undefined && typeof edit.replace_all !== 'boolean') return null
			if (
				!Object.keys(edit).every(
					(key) => key === 'old_string' || key === 'new_string' || key === 'replace_all',
				)
			) {
				return null
			}
			lines.push(`@ ${index + 1}${edit.replace_all ? ' · every occurrence' : ''}`)
			lines.push(...diffLines('-', edit.old_string.split('\n')))
			lines.push(...diffLines('+', edit.new_string.split('\n')))
		}
		return { lines, complete: true }
	}

	// An insertion: new text at a line, nothing removed.
	if (input.insertLine !== undefined) {
		const at = input.insertLine
		if (at !== 'end' && !(typeof at === 'number' && Number.isSafeInteger(at))) return null
		if (oldText.value !== null || newText.value === null) return null
		return {
			lines: [
				`${path} · insert at ${at === 'end' ? 'end' : `line ${String(at)}`}`,
				...diffLines('+', newText.value.split('\n')),
			],
			complete: true,
		}
	}

	// One replacement.
	if (oldText.value === null || newText.value === null) return null
	return {
		lines: [
			`${path}${replaceAll ? ' · every occurrence' : ''}`,
			...diffLines('-', oldText.value.split('\n')),
			...diffLines('+', newText.value.split('\n')),
		],
		complete: true,
	}
}

/**
 * A field that has two spellings. `undefined` when both are present or one
 * is not a string — an evolved shape — and `{ value: null }` when neither is.
 */
function pickString(
	input: Record<string, unknown>,
	name: string,
	alias: string,
): { value: string | null } | undefined {
	const a = input[name]
	const b = input[alias]
	if (a !== undefined && b !== undefined) return undefined
	const value = a ?? b
	if (value === undefined) return { value: null }
	return typeof value === 'string' ? { value } : undefined
}

/** Keep multi-line model input readable without making continuation lines look like new fields. */
function readableField(label: string, value: string): readonly string[] {
	const lines = value.split('\n')
	return lines.map((line, index) =>
		index === 0 ? `${label}: ${line}` : `${' '.repeat(label.length + 2)}${line}`,
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Project and wrap exact review text into PHYSICAL terminal rows.
 *
 * JSON strings can contain thousands of characters on one logical line. Ink
 * would wrap that line after pagination, leaving the suffix below the viewport
 * while the pager still believed there was only one row. Wrapping first makes
 * the pager's unit the same row the operator sees. Non-ASCII code points count
 * conservatively as two cells; overestimating produces shorter rows, never a
 * hidden tail.
 */
export function permissionReviewRows(
	review: string,
	terminalColumns: number | undefined,
): readonly PermissionReviewRow[] {
	// App padding (2), border (2), horizontal padding (2), inner indentation
	// (2) and the row marker (2) are outside the source text. Keep wrapping at
	// one cell even in an unusually narrow terminal; truncating would make the
	// exact approval envelope incomplete precisely where it matters most.
	const width = Math.max(1, (terminalColumns ?? 80) - 10)
	const visible = terminalDisplayText(review)
	const rows: PermissionReviewRow[] = []

	for (const logical of visible.split('\n')) {
		let text = ''
		let cells = 0
		let continuation = false
		for (const point of logical) {
			const codePoint = point.codePointAt(0)
			const pointCells = codePoint !== undefined && codePoint <= 0x7e ? 1 : 2
			if (text.length > 0 && cells + pointCells > width) {
				rows.push({ index: rows.length, text, continuation })
				text = ''
				cells = 0
				continuation = true
			}
			text += point
			cells += pointCells
		}
		rows.push({ index: rows.length, text, continuation })
	}

	return rows
}
