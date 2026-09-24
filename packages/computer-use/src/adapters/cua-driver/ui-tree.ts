import type { Rect, UiElement, UiElementAction } from '@namzu/sdk'

/**
 * cua-driver's `get_window_state` → the host's `UiElement` tree.
 *
 * The driver answers with two views of one UI Automation walk:
 * `structuredContent.elements`, one record per control it can act on (index,
 * token, role, label, value, state, patterns, frame), and `tree_markdown`,
 * every node of the walk as an indented list in which the actionable ones
 * carry `[index]`. The markdown is the only place the rest of the tree
 * lives — a calculator's "Expression is 125 × 8=", a status bar's
 * "Ln 1, Col 1" — so the shape and the unindexed nodes come from it and
 * everything about an indexed node comes from its record. Without markdown
 * the records alone make the tree, nested by `parent_index`.
 *
 * Only a control with a pattern this host can drive gets a `ref` (its
 * element token); the rest are in the tree for what they say.
 */

export interface CuaUiElement {
	readonly element_index?: unknown
	readonly element_token?: unknown
	readonly role?: unknown
	readonly label?: unknown
	readonly value?: unknown
	readonly enabled?: unknown
	readonly selected?: unknown
	readonly actions?: unknown
	readonly frame?: unknown
	readonly parent_index?: unknown
}

/** What `uiAct` needs to know about a ref: the element's current value, for set_value's fallback. */
export interface UiRefFacts {
	readonly value?: string
}

export interface ParsedUiTree {
	readonly root: UiElement
	/** Every ref in the tree, with what `uiAct` needs about it. */
	readonly refs: ReadonlyMap<string, UiRefFacts>
	readonly count: number
}

/** cua-driver's pattern names → the actions this host performs for them. */
const PATTERN_ACTIONS: Readonly<Record<string, readonly UiElementAction[]>> = {
	invoke: ['invoke'],
	set_value: ['set_value'],
	expand: ['expand', 'collapse'],
	collapse: ['expand', 'collapse'],
	toggle: ['toggle'],
	select: ['select'],
}

interface MutableElement {
	ref: string
	role: string
	name: string
	value?: string
	automationId?: string
	bounds?: Rect
	states?: string[]
	actions?: UiElementAction[]
	children: MutableElement[]
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function actionsOf(raw: unknown): UiElementAction[] {
	if (!Array.isArray(raw)) return []
	const out: UiElementAction[] = []
	for (const name of raw) {
		for (const action of PATTERN_ACTIONS[String(name)] ?? []) {
			if (!out.includes(action)) out.push(action)
		}
	}
	return out
}

function boundsOf(raw: unknown): Rect | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const frame = raw as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
	const numbers = [frame.x, frame.y, frame.w, frame.h]
	if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
	const [x, y, width, height] = numbers as number[]
	if ((width as number) <= 0 || (height as number) <= 0) return undefined
	return {
		x: Math.round(x as number),
		y: Math.round(y as number),
		width: Math.round(width as number),
		height: Math.round(height as number),
	}
}

function fromRecord(record: CuaUiElement, automationId: string | undefined): MutableElement {
	const actions = actionsOf(record.actions)
	const token = text(record.element_token)
	const states: string[] = []
	if (record.enabled === false) states.push('disabled')
	if (record.selected === true) states.push('selected')
	const value = text(record.value)
	const bounds = boundsOf(record.frame)
	return {
		// A control this host can do nothing with gets no ref.
		ref: token && actions.length > 0 ? token : '',
		role: text(record.role) ?? 'Element',
		name: text(record.label) ?? '',
		...(value !== undefined ? { value } : {}),
		...(automationId !== undefined ? { automationId } : {}),
		...(bounds ? { bounds } : {}),
		...(states.length > 0 ? { states } : {}),
		...(actions.length > 0 && token ? { actions } : {}),
		children: [],
	}
}

/**
 * An unindexed markdown row: `Role "Name"`, `Role`, or either with a
 * trailing `[attributes]`. Returns undefined for a row it cannot read.
 */
function fromMarkdownRow(rest: string): MutableElement | undefined {
	const role = /^([A-Za-z][\w-]*)/.exec(rest)?.[1]
	if (!role) return undefined
	let tail = rest.slice(role.length)
	let name = ''
	if (tail.startsWith(' "')) {
		const close = tail.endsWith('"') ? tail.length - 1 : tail.lastIndexOf('" [')
		if (close > 1) {
			name = tail.slice(2, close)
			tail = tail.slice(close + 1)
		}
	}
	const automationId = automationIdOf(tail)
	return {
		ref: '',
		role,
		name,
		...(automationId !== undefined ? { automationId } : {}),
		children: [],
	}
}

function automationIdOf(attributes: string): string | undefined {
	return /\[(?:[^\]]*\s)?id=([A-Za-z0-9_.:-]+)/.exec(attributes)?.[1]
}

function freeze(element: MutableElement): UiElement {
	const { children, ...rest } = element
	return Object.freeze({
		...rest,
		...(children.length > 0 ? { children: Object.freeze(children.map(freeze)) } : {}),
	}) as UiElement
}

function collectRefs(element: MutableElement, into: Map<string, UiRefFacts>): number {
	let count = 1
	if (element.ref)
		into.set(element.ref, element.value !== undefined ? { value: element.value } : {})
	for (const child of element.children) count += collectRefs(child, into)
	return count
}

/** The whole tree of one `get_window_state` answer. */
export function toUiTree(state: Record<string, unknown>): ParsedUiTree {
	const records = Array.isArray(state.elements) ? (state.elements as CuaUiElement[]) : []
	const byIndex = new Map<number, CuaUiElement>()
	for (const record of records) {
		if (typeof record.element_index === 'number') byIndex.set(record.element_index, record)
	}
	const title = text(state.window_title) ?? ''
	const markdown = text(state.tree_markdown)
	const top: MutableElement[] = []
	const used = new Set<number>()

	if (markdown) {
		// The open ancestors with their depths: a row's parent is the latest
		// row above it that is less indented. The driver skips a level where
		// it leaves a node out, so depth is compared, not counted.
		const stack: { depth: number; node: MutableElement }[] = []
		for (const line of markdown.split('\n')) {
			const row = /^( *)- (.*)$/.exec(line)
			if (!row) continue
			const depth = Math.floor((row[1] ?? '').length / 2)
			const rest = row[2] ?? ''
			const indexed = /^\[(\d+)\] (.*)$/.exec(rest)
			let node: MutableElement | undefined
			if (indexed) {
				const index = Number(indexed[1])
				const record = byIndex.get(index)
				if (record) {
					used.add(index)
					node = fromRecord(record, automationIdOf(indexed[2] ?? ''))
				} else {
					node = fromMarkdownRow(indexed[2] ?? '')
				}
			} else {
				node = fromMarkdownRow(rest)
			}
			if (!node) continue
			while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop()
			const parent = stack[stack.length - 1]
			if (parent) parent.node.children.push(node)
			else top.push(node)
			stack.push({ depth, node })
		}
	}

	// Records the markdown did not place (or no markdown at all): nested by
	// parent_index where that parent is known, else at the top.
	const placed = new Map<number, MutableElement>()
	for (const record of records) {
		const index = record.element_index
		if (typeof index !== 'number' || used.has(index)) continue
		placed.set(index, fromRecord(record, undefined))
	}
	for (const record of records) {
		const index = record.element_index
		if (typeof index !== 'number') continue
		const node = placed.get(index)
		if (!node) continue
		const parent =
			typeof record.parent_index === 'number' ? placed.get(record.parent_index) : undefined
		if (parent) parent.children.push(node)
		else top.push(node)
	}

	const root: MutableElement =
		top.length === 1 && top[0] ? top[0] : { ref: '', role: 'Window', name: title, children: top }
	const refs = new Map<string, UiRefFacts>()
	const count = collectRefs(root, refs)
	return { root: freeze(root), refs, count }
}
