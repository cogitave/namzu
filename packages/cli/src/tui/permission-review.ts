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
 * already rejected getters, prototypes and non-JSON values. A known formatter
 * is marked complete only when its key set and value types are exhaustive.
 * Unknown or evolved shapes still get a useful projection, but callers open
 * the exact envelope by default so a friendly label can never hide a suffix.
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

	const sections: string[] = []
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
		sections.push(
			[
				`${index + 1}. ${call.name}${call.isDestructive ? ' · destructive' : ''}`,
				...readable.lines.map((line) => `   ${line}`),
			].join('\n'),
		)
	}

	return { text: sections.join('\n\n'), complete }
}

function summarizeKnownCall(
	name: string,
	input: unknown,
): { readonly lines: readonly string[]; readonly complete: boolean } {
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

	if (name === 'Agent' && isRecord(input)) {
		const allowed = new Set(['description', 'prompt', 'role'])
		const keys = Object.keys(input)
		const shapeIsKnown =
			keys.every((key) => allowed.has(key)) &&
			typeof input.description === 'string' &&
			typeof input.prompt === 'string' &&
			(input.role === undefined || typeof input.role === 'string')
		if (shapeIsKnown) {
			return {
				lines: [
					`description: ${JSON.stringify(input.description)}`,
					`prompt: ${JSON.stringify(input.prompt)}`,
					...(input.role !== undefined ? [`role: ${JSON.stringify(input.role)}`] : []),
				],
				complete: true,
			}
		}
	}

	return {
		lines: [`input: ${JSON.stringify(input)}`],
		complete: false,
	}
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
