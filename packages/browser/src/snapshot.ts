import type { BrowserRefDescription } from '@namzu/sdk'
import type { Locator, Page } from 'playwright-core'
import { isCredentialField } from './classifier.js'
import { type InvisibleBoxes, type Rect, fieldFacts, invisibleBoxes } from './page-scripts.js'

/**
 * The accessibility snapshot, and the one place that knows how Playwright
 * produces refs and resolves them.
 *
 * Two Playwright surfaces are used, and they are not equally stable:
 *
 * - `page.ariaSnapshotJSON({ mode: 'ai', boxes: true })` is public API in the
 *   pinned version: the accessibility tree with a `ref` on every element
 *   that can be targeted, stable across snapshots for an element that stays.
 * - `page.locator('aria-ref=eN')` resolves a ref. That selector engine is
 *   NOT documented; it is what Playwright's own agent tooling uses. It is
 *   why `playwright-core` is pinned exactly, and the contract test in
 *   `__tests__/e2e` fails if an upgrade changes it. The fallback, should it
 *   go, is CDP `Accessibility.getFullAXTree` with `DOM.resolveNode` on each
 *   node's `backendDOMNodeId` — behind this module's same three functions.
 *
 * Observed in 1.63.0 and relied on here: a snapshot of a single element
 * REPLACES the page's ref table (refs outside it stop resolving), so a
 * region is always cut out of a whole-page snapshot on this side; and a
 * snapshot hangs while a JavaScript dialog is open, so the host never takes
 * one then.
 */

/** The `playwright-core` version this module was verified against. */
export const PLAYWRIGHT_CORE_VERSION = '1.63.0'

/** One node of `ariaSnapshotJSON({ mode: 'ai' })`. Fields beyond these are ignored. */
export interface AriaNode {
	readonly role: string
	readonly name?: string
	readonly ref?: string
	readonly box?: Rect
	readonly text?: string
	readonly url?: string
	readonly placeholder?: string
	readonly ariaHidden?: boolean
	readonly checked?: boolean | 'mixed'
	readonly disabled?: boolean
	readonly expanded?: boolean
	readonly invalid?: boolean | string
	readonly level?: number
	readonly pressed?: boolean | 'mixed'
	readonly selected?: boolean
	readonly children?: readonly (string | AriaNode)[]
}

/** What a rendered snapshot knows: its lines, and every ref it showed. */
export interface RenderedSnapshot {
	readonly text: string
	readonly refs: ReadonlyMap<string, BrowserRefDescription>
}

const NO_HIDDEN: InvisibleBoxes = { scrollX: 0, scrollY: 0, boxes: [] }

/** Most boxes the page is asked for when looking for invisible text. */
const INVISIBLE_BOX_LIMIT = 5000

function sameBox(a: Rect, b: Rect): boolean {
	return (
		Math.abs(a.x - b.x) < 0.5 &&
		Math.abs(a.y - b.y) < 0.5 &&
		Math.abs(a.width - b.width) < 0.5 &&
		Math.abs(a.height - b.height) < 0.5
	)
}

/**
 * Can nobody see this node? Too small to hold text (the 1px "visually
 * hidden" pattern included), outside the document, or drawn invisibly. Only
 * the main frame's boxes are comparable with the page's; inside a frame only
 * the size counts.
 */
function unseen(node: AriaNode, hidden: InvisibleBoxes, inFrame: boolean): boolean {
	const box = node.box
	if (!box) return false
	if (box.width <= 1 || box.height <= 1) return true
	if (inFrame) return false
	if (box.x + box.width + hidden.scrollX <= 0 || box.y + box.height + hidden.scrollY <= 0)
		return true
	return hidden.boxes.some((b) => sameBox(b, box))
}

function flat(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

function quote(value: string): string {
	return JSON.stringify(flat(value))
}

const FLAGS = [
	'checked',
	'disabled',
	'expanded',
	'invalid',
	'level',
	'pressed',
	'selected',
] as const

function flags(node: AriaNode): string {
	let out = ''
	for (const flag of FLAGS) {
		const value = node[flag]
		if (value === undefined || value === false) continue
		out += value === true ? ` [${flag}]` : ` [${flag}=${flat(String(value))}]`
	}
	return out
}

/** What a credential field's value is shown as. */
export const REDACTED = '[value hidden: password or one-time code]'

/**
 * Render nodes as the snapshot text the model reads, one element per line:
 *
 * ```text
 * - link "Pricing" [ref=e7]:
 *   - /url: /pricing
 * - textbox "Email" [ref=e9]
 * ```
 *
 * Dropped: `aria-hidden` subtrees, and the own text of nodes nobody can see
 * (their visible children are kept, one level up). With `rootRef`, only that
 * element's subtree; `undefined` when the ref is not in the tree.
 */
export function renderAriaTree(
	nodes: readonly (string | AriaNode)[],
	hidden: InvisibleBoxes = NO_HIDDEN,
	rootRef?: string,
	redact: ReadonlySet<string> = new Set(),
): RenderedSnapshot | undefined {
	const lines: string[] = []
	const refs = new Map<string, BrowserRefDescription>()

	const emit = (item: string | AriaNode, depth: number, inFrame: boolean): void => {
		const indent = '  '.repeat(depth)
		if (typeof item === 'string') {
			const text = flat(item)
			if (text) lines.push(`${indent}- text: ${text}`)
			return
		}
		if (item.ariaHidden) return
		const childFrame = inFrame || item.role === 'iframe'
		if (unseen(item, hidden, inFrame)) {
			for (const child of item.children ?? []) {
				if (typeof child !== 'string') emit(child, depth, childFrame)
			}
			return
		}
		let line = `${indent}- ${item.role}`
		if (item.name) line += ` ${quote(item.name)}`
		line += flags(item)
		if (item.ref) {
			line += ` [ref=${item.ref}]`
			refs.set(item.ref, {
				role: item.role,
				...(item.name ? { name: flat(item.name) } : {}),
			})
		}
		const text =
			item.text === undefined || item.text === ''
				? ''
				: item.ref !== undefined && redact.has(item.ref)
					? REDACTED
					: flat(item.text)
		const hasChildren =
			(item.children?.length ?? 0) > 0 || item.url !== undefined || item.placeholder !== undefined
		if (text) line += `: ${text}`
		else if (hasChildren) line += ':'
		lines.push(line)
		const inner = `${indent}  `
		if (item.url !== undefined) lines.push(`${inner}- /url: ${flat(item.url)}`)
		if (item.placeholder !== undefined)
			lines.push(`${inner}- /placeholder: ${quote(item.placeholder)}`)
		for (const child of item.children ?? []) emit(child, depth + 1, childFrame)
	}

	if (rootRef === undefined) {
		for (const node of nodes) emit(node, 0, false)
		return { text: lines.join('\n'), refs }
	}
	const found = findRef(nodes, rootRef, false)
	if (!found) return undefined
	emit(found.node, 0, found.inFrame)
	return { text: lines.join('\n'), refs }
}

function findRef(
	nodes: readonly (string | AriaNode)[],
	ref: string,
	inFrame: boolean,
): { node: AriaNode; inFrame: boolean } | undefined {
	for (const node of nodes) {
		if (typeof node === 'string' || node.ariaHidden) continue
		if (node.ref === ref) return { node, inFrame }
		const hit = findRef(node.children ?? [], ref, inFrame || node.role === 'iframe')
		if (hit) return hit
	}
	return undefined
}

/**
 * Take a whole-page snapshot. `ariaSnapshotJSON` returns one root node or a
 * list; either way the result is a list.
 */
export async function captureAriaTree(
	page: Page,
	timeoutMs: number,
): Promise<{ nodes: (string | AriaNode)[]; hidden: InvisibleBoxes; redact: Set<string> }> {
	const [tree, hidden] = await Promise.all([
		page.ariaSnapshotJSON({ mode: 'ai', boxes: true, timeout: timeoutMs }),
		page.evaluate(invisibleBoxes, INVISIBLE_BOX_LIMIT).catch(() => NO_HIDDEN),
	])
	const nodes = (Array.isArray(tree) ? tree : [tree]) as unknown as (string | AriaNode)[]
	return { nodes, hidden, redact: await credentialRefs(page, nodes) }
}

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox'])

/**
 * Refs of text fields that hold a value AND are a password or one-time-code
 * field. The accessibility tree carries an input's value as its text, a
 * password's included — an autofilled profile would hand the model the
 * password. Each candidate is asked about individually through its ref, which
 * reaches into frames as the boxes cannot. A field that cannot be asked is
 * hidden too.
 */
async function credentialRefs(
	page: Page,
	nodes: readonly (string | AriaNode)[],
): Promise<Set<string>> {
	const candidates: string[] = []
	const walk = (items: readonly (string | AriaNode)[]): void => {
		for (const item of items) {
			if (typeof item === 'string') continue
			if (item.ref && item.text && TEXT_ROLES.has(item.role)) candidates.push(item.ref)
			walk(item.children ?? [])
		}
	}
	walk(nodes)
	const redact = new Set<string>()
	await Promise.all(
		candidates.map(async (ref) => {
			try {
				const facts = await locateRef(page, ref).evaluate(fieldFacts, undefined, { timeout: 2000 })
				if (isCredentialField(facts)) redact.add(ref)
			} catch {
				redact.add(ref)
			}
		}),
	)
	return redact
}

/** The element a ref names, in whichever frame it lives. */
export function locateRef(page: Page, ref: string): Locator {
	return page.locator(`aria-ref=${ref}`)
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Longest snapshot text kept for paging, in characters. Past it: cut, with a note. */
export const SNAPSHOT_TOTAL_MAX_CHARS = 400_000

export interface SnapshotPage {
	readonly text: string
	readonly nextCursor?: string
}

/**
 * Pages of one snapshot, cut at line boundaries. A cursor names the snapshot
 * and the offset, so a cursor from an older snapshot is refused rather than
 * silently reading the new page from the middle.
 */
export class SnapshotPager {
	private id = 0
	private text = ''

	constructor(private readonly pageChars: number) {}

	/** Start a new snapshot and return its first page. */
	start(text: string): SnapshotPage {
		this.id += 1
		this.text =
			text.length > SNAPSHOT_TOTAL_MAX_CHARS
				? `${text.slice(0, SNAPSHOT_TOTAL_MAX_CHARS)}\n[The page's snapshot was cut at ${SNAPSHOT_TOTAL_MAX_CHARS} characters. Take a snapshot of one region with ref to read the rest.]`
				: text
		return this.pageAt(0)
	}

	/** The page a cursor names, or `undefined` when the cursor is not from the latest snapshot. */
	resume(cursor: string): SnapshotPage | undefined {
		const match = /^s(\d+):(\d+)$/.exec(cursor)
		if (!match || Number(match[1]) !== this.id) return undefined
		const offset = Number(match[2])
		if (offset <= 0 || offset >= this.text.length) return undefined
		return this.pageAt(offset)
	}

	private pageAt(offset: number): SnapshotPage {
		const rest = this.text.slice(offset)
		if (rest.length <= this.pageChars) return { text: rest }
		const window = rest.slice(0, this.pageChars)
		const lastBreak = window.lastIndexOf('\n')
		const cut = lastBreak > 0 ? lastBreak : this.pageChars
		const next = offset + cut + (lastBreak > 0 ? 1 : 0)
		return { text: rest.slice(0, cut), nextCursor: `s${this.id}:${next}` }
	}
}
