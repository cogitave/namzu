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

/**
 * The page a terminal of this height gets: the 24-row floor above, and
 * every row past what the box's own furniture needs on a taller one, so
 * a two-call batch is not paged on a screen that could show it whole.
 */
export function permissionReviewPageRows(terminalRows: number | undefined): number {
	const rows = terminalRows ?? 24
	return Math.min(24, Math.max(PERMISSION_REVIEW_PAGE_ROWS, rows - 18))
}

/**
 * Whether an "allow all" answered on one prompt may also answer this queued
 * one, which nobody has seen yet.
 *
 * Not for a call that crosses the turn's boundary: one that leaves the
 * sandbox, or one that reaches a path outside the working directory and the
 * added directories. The kernel asks about each of those every time; a
 * queued prompt settled by an answer given to a DIFFERENT prompt would hand
 * it an approval for a command or a path that was never on screen.
 */
export function releasedByApproveAll(
	toolCalls: readonly {
		readonly escalation?: {
			readonly sandboxEscape?: true
			readonly outsidePaths?: readonly string[]
		}
	}[],
): boolean {
	return !toolCalls.some(
		(call) =>
			call.escalation?.sandboxEscape === true || (call.escalation?.outsidePaths?.length ?? 0) > 0,
	)
}

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
	/** Compact agent plan; full prepared arguments remain available in the exact view. */
	readonly compactText?: string
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
/** What the screen can learn, beyond the envelope, to make a call readable. */
export interface PermissionSummaryContext {
	/**
	 * The control a `computer_use` `ui_act` ref names in the latest UI
	 * snapshot (`Button "Beş" (e30)`), from the session's tool. Absent, the
	 * ref alone is shown.
	 */
	readonly describeUiRef?: (ref: string) => string | undefined
}

export function buildPermissionSummary(
	review: string,
	context: PermissionSummaryContext = {},
): PermissionReviewSummary {
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
		readonly input: unknown
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
		const readable = summarizeKnownCall(call.name, call.input, context)
		complete &&= readable.complete
		calls.push({
			name: call.name,
			isDestructive: call.isDestructive,
			readable,
			input: call.input,
		})
	}

	const compactText =
		complete &&
		calls.length > 0 &&
		calls.every((call) => call.name === 'Agent' && call.readable.label !== undefined)
			? compactAgentPlan(calls)
			: undefined

	if (
		complete &&
		calls.length > 1 &&
		calls.every((call) => call.name === 'Agent' && call.readable.label !== undefined)
	) {
		const overview = calls.map(
			(call, index) =>
				`${index + 1}. ${call.readable.label as string}${call.isDestructive ? ' · destructive' : ''}`,
		)
		const details = calls.map((call, index) =>
			[
				`${index + 1}. ${call.readable.label as string}${call.isDestructive ? ' · destructive' : ''}`,
				...call.readable.lines.map((line) => `   ${line}`),
			].join('\n'),
		)
		return {
			text: [...overview, '', 'Task details', '', ...details].join('\n'),
			...(compactText !== undefined ? { compactText } : {}),
			complete: true,
		}
	}

	return {
		...(compactText !== undefined ? { compactText } : {}),
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

/**
 * A shell command as the operator would type it: its quotes and backslashes
 * verbatim, never JSON-escaped (`printf '%s\n' "$x"`, not
 * `printf '%s\\n' \"$x\"`). Each line of a multi-line command is its own
 * row, the first after `$ ` and every later one indented under it, so a
 * newline in the command cannot pose as a field of the prompt or as another
 * call of the batch. A carriage return is spelled out rather than kept: the
 * rows' terminal projection would fold CRLF into a plain newline, and to the
 * shell the CR is part of the word. Every other control and invisible
 * character is spelled out by that projection (`terminalDisplayText`).
 */
function commandLines(command: string): string[] {
	const [first = '', ...rest] = command.replace(/\r/g, '\\u{000d}').split('\n')
	return [`$ ${first}`, ...rest.map((line) => `  ${line}`)]
}

function summarizeKnownCall(
	name: string,
	input: unknown,
	context: PermissionSummaryContext = {},
): ReadableCallSummary {
	if (name === 'bash' && isRecord(input)) {
		const allowed = new Set([
			'command',
			'timeout',
			'run_in_background',
			'dangerously_disable_sandbox',
		])
		const keys = Object.keys(input)
		const shapeIsKnown =
			keys.every((key) => allowed.has(key)) &&
			typeof input.command === 'string' &&
			(input.timeout === undefined || typeof input.timeout === 'number') &&
			(input.run_in_background === undefined || typeof input.run_in_background === 'boolean') &&
			(input.dangerously_disable_sandbox === undefined ||
				typeof input.dangerously_disable_sandbox === 'boolean')
		if (shapeIsKnown) {
			return {
				lines: [
					...commandLines(input.command as string),
					...(input.timeout !== undefined ? [`timeout: ${String(input.timeout)} ms`] : []),
					...(input.run_in_background !== undefined
						? [`background: ${input.run_in_background ? 'yes' : 'no'}`]
						: []),
					...(input.dangerously_disable_sandbox === true
						? ['sandbox: OFF for this command (runs on the host)']
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
			const lines = (body as string) === '' ? [] : (body as string).split('\n')
			if (lines.at(-1) === '') lines.pop()
			return {
				lines: [
					`${input.path as string} · write ${lines.length} line${lines.length === 1 ? '' : 's'}`,
					'Full replacement body · may overwrite an existing file',
					...lines.map((line) => `  ${line}`),
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
			'model',
			'provider',
			'effort',
			'role',
			'workflow',
			'phase',
			'phase_order',
			'phase_detail',
			'run_in_background',
		])
		const keys = Object.keys(input)
		const shapeIsKnown =
			keys.every((key) => allowed.has(key)) &&
			typeof input.description === 'string' &&
			typeof input.prompt === 'string' &&
			(input.run_in_background === undefined || typeof input.run_in_background === 'boolean') &&
			(input.subagent_type === undefined || typeof input.subagent_type === 'string') &&
			['model', 'provider', 'effort'].every(
				(key) => input[key] === undefined || typeof input[key] === 'string',
			) &&
			(input.role === undefined || typeof input.role === 'string') &&
			(input.workflow === undefined || typeof input.workflow === 'string') &&
			(input.phase === undefined || typeof input.phase === 'string') &&
			(input.phase_order === undefined ||
				(typeof input.phase_order === 'number' && Number.isSafeInteger(input.phase_order))) &&
			(input.phase_detail === undefined || typeof input.phase_detail === 'string')
		if (shapeIsKnown) {
			const known = input as {
				description: string
				prompt: string
				subagent_type?: string
				model?: string
				provider?: string
				effort?: string
				role?: string
				workflow?: string
				phase?: string
				phase_order?: number
				phase_detail?: string
				run_in_background?: boolean
			}
			return {
				lines: [
					...readableField('Task', known.description),
					...readableField('Agent', agentTypeLabel(known.subagent_type)),
					...(known.model !== undefined ? readableField('Model', known.model) : []),
					...(known.provider !== undefined ? readableField('Provider', known.provider) : []),
					...(known.effort !== undefined ? readableField('Effort', known.effort) : []),
					...(known.run_in_background !== undefined
						? [`Execution: ${known.run_in_background ? 'background' : 'wait for result'}`]
						: []),
					...(known.subagent_type === 'explore'
						? ['Tools: reading and searching only']
						: known.subagent_type === undefined || known.subagent_type === 'general-purpose'
							? ['Tools: files and commands, subject to approval rules']
							: []),
					...(known.role !== undefined ? readableField('Role', known.role) : []),
					...(known.workflow !== undefined ? readableField('Workflow label', known.workflow) : []),
					...(known.phase !== undefined ? readableField('Phase label', known.phase) : []),
					...(known.phase_order !== undefined
						? [`Phase display order: ${String(known.phase_order + 1)}`]
						: []),
					...(known.phase_detail !== undefined
						? readableField('Phase detail', known.phase_detail)
						: []),
					...readableField('Instructions', known.prompt),
				],
				complete: true,
				label: `${oneLine(known.description)} · ${oneLine(agentTypeLabel(known.subagent_type))}`,
			}
		}
	}

	if (name === 'browser' && isRecord(input)) {
		const summary = summarizeBrowserOpen(input)
		if (summary) return summary
	}

	if (name === 'computer_use' && isRecord(input)) {
		const summary = summarizeComputerUse(input, context)
		if (summary) return summary
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

/**
 * A browser navigation, with its address readable: the path and query as a
 * person writes them (`/wiki/İstanbul`, not `/wiki/%C4%B0stanbul`), and the
 * address actually sent below it when the two differ. The host stays in its
 * canonical (punycode) form: that is the part a lookalike would abuse.
 * Any other browser call keeps the generic every-key listing.
 */
function summarizeBrowserOpen(input: Record<string, unknown>): ReadableCallSummary | null {
	const keys = Object.keys(input)
	const navigate =
		input.action === 'navigate' && keys.every((key) => key === 'action' || key === 'url')
	const newTab =
		input.action === 'tabs' &&
		input.op === 'new' &&
		keys.every((key) => key === 'action' || key === 'op' || key === 'url')
	if ((!navigate && !newTab) || typeof input.url !== 'string') return null
	const url = input.url
	let readable = url
	try {
		const parsed = new URL(url)
		readable = `${parsed.protocol}//${parsed.host}${decodeURI(`${parsed.pathname}${parsed.search}${parsed.hash}`)}`
	} catch {
		readable = url
	}
	return {
		lines: [
			`${newTab ? 'Open in a new tab' : 'Open'}: ${readable}`,
			...(readable !== url ? [`sent as: ${url}`] : []),
		],
		complete: true,
	}
}

/**
 * A desktop action, or a batch of them, one numbered line per action in the
 * order they will run: `3 desktop actions, in order` over `1. Click left at
 * (812, 403)`, `2. Type "Bahadır Arda"`, `3. Press ENTER`. Text to be typed is
 * shown whole — it is what lands in whichever window has focus — and the
 * screenshot the coordinates belong to is named, since they are its pixels,
 * not the screen's. An action or field this does not know returns null and
 * the call opens exact-first.
 */
function summarizeComputerUse(
	input: Record<string, unknown>,
	context: PermissionSummaryContext,
): ReadableCallSummary | null {
	if (input.screenshot_id !== undefined && typeof input.screenshot_id !== 'string') return null
	const space =
		typeof input.screenshot_id === 'string'
			? `Coordinates: pixels of screenshot ${input.screenshot_id}`
			: 'Coordinates: pixels of the latest screenshot'
	if (input.type === 'batch') {
		if (!Object.keys(input).every((key) => ['type', 'actions', 'screenshot_id'].includes(key)))
			return null
		if (!Array.isArray(input.actions) || input.actions.length === 0) return null
		const lines: string[] = []
		let coordinates = false
		for (const [index, item] of input.actions.entries()) {
			if (!isRecord(item) || item.type === 'batch' || Object.hasOwn(item, 'screenshot_id'))
				return null
			const action = computerUseAction(item, [], context)
			if (!action) return null
			coordinates ||= action.coordinates
			lines.push(`${index + 1}. ${action.line}`)
		}
		const count = input.actions.length
		return {
			lines: [
				`${count} desktop action${count === 1 ? '' : 's'}, in order; stops at the first that fails`,
				...lines,
				...(coordinates ? [space] : []),
			],
			complete: true,
		}
	}
	if (input.actions !== undefined) return null
	const action = computerUseAction(input, ['screenshot_id'], context)
	if (!action) return null
	return { lines: [action.line, ...(action.coordinates ? [space] : [])], complete: true }
}

/** How a person reads each `ui_act` action, before the control it acts on. */
const UI_ACT_VERBS: Readonly<Record<string, string>> = {
	invoke: 'Press',
	toggle: 'Toggle',
	select: 'Select',
	expand: 'Expand',
	collapse: 'Collapse',
	focus: 'Focus',
	scroll_into_view: 'Scroll to',
}

function computerUseAction(
	item: Record<string, unknown>,
	extra: readonly string[] = [],
	context: PermissionSummaryContext = {},
): { readonly line: string; readonly coordinates: boolean } | null {
	const point = (value: unknown): string | null =>
		isRecord(value) &&
		Object.keys(value).every((key) => key === 'x' || key === 'y') &&
		Number.isInteger(value.x) &&
		Number.isInteger(value.y)
			? `(${value.x as number}, ${value.y as number})`
			: null
	const fields = (...names: string[]): boolean =>
		Object.keys(item).every((key) => key === 'type' || names.includes(key) || extra.includes(key))
	const text = (value: unknown): value is string => typeof value === 'string'
	switch (item.type) {
		case 'screenshot':
			return fields() ? { line: 'Take a screenshot', coordinates: false } : null
		case 'cursor_position':
			return fields() ? { line: 'Read the cursor position', coordinates: false } : null
		case 'list_windows':
			return fields() ? { line: 'List the open windows', coordinates: false } : null
		case 'wait':
			return fields('ms') && Number.isInteger(item.ms)
				? { line: `Wait ${item.ms as number} ms`, coordinates: false }
				: null
		case 'focus_window':
			return fields('window_id') && text(item.window_id)
				? {
						line: `Bring window ${JSON.stringify(item.window_id)} to the front`,
						coordinates: false,
					}
				: null
		case 'type_text':
			return fields('text') && text(item.text)
				? { line: `Type ${JSON.stringify(item.text)}`, coordinates: false }
				: null
		case 'key':
			return fields('keys') && text(item.keys)
				? { line: `Press ${JSON.stringify(item.keys)}`, coordinates: false }
				: null
		case 'mouse_move': {
			const to = point(item.to)
			return fields('to') && to ? { line: `Move the pointer to ${to}`, coordinates: true } : null
		}
		case 'mouse_click': {
			const at = point(item.at)
			return fields('at', 'button') && at && text(item.button)
				? { line: `Click ${item.button} at ${at}`, coordinates: true }
				: null
		}
		case 'mouse_drag': {
			const from = point(item.from)
			const to = point(item.to)
			return fields('from', 'to', 'button') && from && to && text(item.button)
				? { line: `Drag ${item.button} from ${from} to ${to}`, coordinates: true }
				: null
		}
		case 'scroll': {
			const at = point(item.at)
			return fields('at', 'direction', 'amount') &&
				at &&
				text(item.direction) &&
				Number.isInteger(item.amount)
				? { line: `Scroll ${item.direction} ${item.amount as number} at ${at}`, coordinates: true }
				: null
		}
		case 'ui_snapshot':
			return fields('window_id') && (item.window_id === undefined || text(item.window_id))
				? {
						line:
							item.window_id === undefined
								? 'Read the controls of the window in front'
								: `Read the controls of window ${JSON.stringify(item.window_id)}`,
						coordinates: false,
					}
				: null
		case 'ui_act': {
			if (!fields('ref', 'action', 'value') || !text(item.ref) || !text(item.action)) return null
			if (item.value !== undefined && !text(item.value)) return null
			// The application's own words for the control, as the session's tool
			// last read them; the ref stays, since that is what runs.
			const target = context.describeUiRef?.(item.ref) ?? `control ${item.ref}`
			if (item.action === 'set_value')
				return {
					line: `Set ${target} to ${JSON.stringify(item.value ?? '')}`,
					coordinates: false,
				}
			const verb = UI_ACT_VERBS[item.action]
			return verb ? { line: `${verb} ${target}`, coordinates: false } : null
		}
		case 'zoom': {
			const region = item.region
			return fields('region') &&
				isRecord(region) &&
				Object.keys(region).every((key) => ['x', 'y', 'width', 'height'].includes(key)) &&
				['x', 'y', 'width', 'height'].every((key) => Number.isInteger(region[key]))
				? {
						line: `Zoom into ${region.width as number}x${region.height as number} at (${region.x as number}, ${region.y as number})`,
						coordinates: true,
					}
				: null
		}
		default:
			return null
	}
}

const PLAIN_TOOL_NAME = /^[\w.:-]+$/u

/** The tools with a formatter above; an evolved shape of one opens exact-first. */
const FORMATTED_TOOLS: ReadonlySet<string> = new Set([
	'bash',
	'edit',
	'write',
	'Agent',
	'computer_use',
])

/** Labels group only the calls in this approval; they never invent execution phases. */
function compactAgentPlan(calls: readonly { input: unknown; isDestructive: boolean }[]): string {
	const lines: string[] = []
	let previousGroup = ''
	for (const [index, call] of calls.entries()) {
		const input = call.input as Record<string, unknown>
		const workflow = typeof input.workflow === 'string' ? oneLine(input.workflow) : ''
		const phase = typeof input.phase === 'string' ? oneLine(input.phase) : ''
		const phaseDetail = typeof input.phase_detail === 'string' ? oneLine(input.phase_detail) : ''
		// Grouping key stays workflow+phase only, matching the cockpit's phase
		// identity; the detail shown is whichever call in the group declared it
		// first, the same first-writer-wins rule the monitor applies.
		const group = JSON.stringify([workflow, phase])
		if (group !== previousGroup) {
			if (workflow || phase) {
				lines.push([workflow, phase].filter(Boolean).join(' / '))
				if (phaseDetail) lines.push(`  ${phaseDetail}`)
			} else if (previousGroup) lines.push('Other agents')
			previousGroup = group
		}
		const type = input.subagent_type
		const access =
			type === 'explore'
				? 'read-only'
				: type === undefined || type === 'general-purpose'
					? 'files + commands'
					: String(type)
		const background = input.run_in_background === true ? ' · background' : ''
		const selection = [input.provider, input.model, input.effort]
			.filter((value) => typeof value === 'string')
			.map((value) => oneLine(String(value)))
			.join(' / ')
		const modelLabel = selection ? ` · ${selection}` : ''
		lines.push(
			`${index === calls.length - 1 ? '└' : '├'}─ [ ${index + 1}. ${oneLine(String(input.description))} · ${access}${modelLabel}${background}${call.isDestructive ? ' · destructive' : ''} ]`,
		)
	}
	return terminalDisplayText(lines.join('\n'))
}

function agentTypeLabel(type: string | undefined): string {
	if (type === undefined) return 'general-purpose (default)'
	if (type === 'explore') return 'explore (read-only tools)'
	return type
}

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
