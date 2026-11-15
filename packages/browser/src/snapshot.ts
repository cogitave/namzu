import type { BrowserEffect, BrowserRefDescription } from '@namzu/sdk'
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

/** Roles whose children are the choices of a select. */
const CHOICE_PARENTS = new Set(['combobox', 'listbox'])

/** Most options of one select that are listed; the chosen ones are always kept. */
export const SELECT_OPTIONS_SHOWN = 40

/** Text controls: a line shows what they hold, or says they are empty. */
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox'])

function chosenOptions(node: AriaNode): string[] {
	const out: string[] = []
	for (const child of node.children ?? []) {
		if (typeof child !== 'string' && child.role === 'option' && child.selected && child.name) {
			out.push(flat(child.name))
		}
	}
	return out
}

function hasOptions(node: AriaNode): boolean {
	return (node.children ?? []).some((c) => typeof c !== 'string' && c.role === 'option')
}

/**
 * What a control's line says it holds: the text of a field, the chosen
 * option(s) of a select, `undefined` when it holds none. A credential
 * field's value is never shown.
 */
function heldValue(item: AriaNode, redact: ReadonlySet<string>): string | undefined {
	if (item.ref !== undefined && redact.has(item.ref)) {
		return item.text === undefined || item.text === '' ? undefined : REDACTED
	}
	if (item.text !== undefined && item.text !== '') return flat(item.text)
	if (item.role === 'combobox' && hasOptions(item)) {
		const chosen = chosenOptions(item)
		return chosen.length > 0 ? chosen.join(', ') : undefined
	}
	return undefined
}

/** The element's own line, without its indent: role, name, flags, ref and the value it holds. */
function lineOf(item: AriaNode, redact: ReadonlySet<string>): string {
	let line = `- ${item.role}`
	if (item.name) line += ` ${quote(item.name)}`
	line += flags(item)
	if (item.ref) line += ` [ref=${item.ref}]`
	const value = heldValue(item, redact)
	if (value !== undefined) return `${line}: ${value}`
	if (item.ref !== undefined && (item.role === 'textbox' || item.role === 'searchbox')) {
		return `${line} [empty]`
	}
	return line
}

/**
 * Render nodes as the snapshot text the model reads, one element per line:
 *
 * ```text
 * - link "Pricing" [ref=e7]:
 *   - /url: /pricing
 * - textbox "Email" [ref=e9]: ada@example.com
 * - combobox "Plan" [ref=e11]: Gold
 *   - option "Free"
 *   - option "Gold" [selected]
 * ```
 *
 * Every control's line carries what it holds. A native select lists its
 * options, the chosen ones marked: the browser reports them with empty boxes,
 * which would read as invisible, so an option under a combobox or listbox is
 * never dropped for its size.
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

	const emit = (
		item: string | AriaNode,
		depth: number,
		inFrame: boolean,
		parentRole?: string,
	): void => {
		const indent = '  '.repeat(depth)
		if (typeof item === 'string') {
			const text = flat(item)
			if (text) lines.push(`${indent}- text: ${text}`)
			return
		}
		if (item.ariaHidden) return
		const childFrame = inFrame || item.role === 'iframe'
		const choice =
			item.role === 'option' && parentRole !== undefined && CHOICE_PARENTS.has(parentRole)
		if (!choice && unseen(item, hidden, inFrame)) {
			for (const child of item.children ?? []) {
				if (typeof child !== 'string') emit(child, depth, childFrame, item.role)
			}
			return
		}
		if (item.ref) {
			refs.set(item.ref, {
				role: item.role,
				...(item.name ? { name: flat(item.name) } : {}),
			})
		}
		const holds = heldValue(item, redact) !== undefined
		const hasChildren =
			(item.children?.length ?? 0) > 0 || item.url !== undefined || item.placeholder !== undefined
		let line = `${indent}${lineOf(item, redact)}`
		if (!holds && hasChildren) line += ':'
		lines.push(line)
		const inner = `${indent}  `
		if (item.url !== undefined) lines.push(`${inner}- /url: ${flat(item.url)}`)
		if (item.placeholder !== undefined)
			lines.push(`${inner}- /placeholder: ${quote(item.placeholder)}`)
		let children = item.children ?? []
		let omitted = 0
		if (CHOICE_PARENTS.has(item.role)) {
			const options = children.filter((c) => typeof c !== 'string' && c.role === 'option')
			if (options.length > SELECT_OPTIONS_SHOWN) {
				const keep = new Set<string | AriaNode>(
					options.filter((o) => typeof o !== 'string' && o.selected),
				)
				for (const o of options) if (keep.size < SELECT_OPTIONS_SHOWN) keep.add(o)
				omitted = options.length - keep.size
				children = children.filter(
					(c) => typeof c === 'string' || c.role !== 'option' || keep.has(c),
				)
			}
		}
		for (const child of children) emit(child, depth + 1, childFrame, item.role)
		if (omitted > 0) {
			lines.push(
				`${inner}- (${omitted} more options not listed; read the chosen one with the value action, or find an option by name with snapshot query)`,
			)
		}
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

/** The element a ref names as a one-node tree, so a view can be cut to it; `undefined` when it is not there. */
export function subtreeOf(
	nodes: readonly (string | AriaNode)[],
	ref: string,
): readonly AriaNode[] | undefined {
	const found = findRef(nodes, ref, false)
	return found ? [found.node] : undefined
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

// ---------------------------------------------------------------------------
// Other views of the same tree
// ---------------------------------------------------------------------------

/** Roles a call can act on. */
const INTERACTIVE_ROLES = new Set([
	'button',
	'link',
	'textbox',
	'searchbox',
	'combobox',
	'checkbox',
	'radio',
	'switch',
	'slider',
	'spinbutton',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'treeitem',
	'listbox',
])

interface Seen {
	readonly node: AriaNode
	/** Ancestors, outermost first, that the page shows. */
	readonly parents: readonly AriaNode[]
}

/** Every element the snapshot shows, in document order, with the ancestors that are shown. */
function shownNodes(
	nodes: readonly (string | AriaNode)[],
	hidden: InvisibleBoxes,
): { seen: Seen[]; strings: Map<AriaNode, string[]> } {
	const seen: Seen[] = []
	const strings = new Map<AriaNode, string[]>()
	const walk = (
		items: readonly (string | AriaNode)[],
		parents: readonly AriaNode[],
		inFrame: boolean,
		parentRole?: string,
	): void => {
		for (const item of items) {
			if (typeof item === 'string') continue
			if (item.ariaHidden) continue
			const childFrame = inFrame || item.role === 'iframe'
			const choice =
				item.role === 'option' && parentRole !== undefined && CHOICE_PARENTS.has(parentRole)
			if (!choice && unseen(item, hidden, inFrame)) {
				walk(item.children ?? [], parents, childFrame, item.role)
				continue
			}
			seen.push({ node: item, parents })
			strings.set(
				item,
				(item.children ?? []).filter((c): c is string => typeof c === 'string').map(flat),
			)
			walk(item.children ?? [], [...parents, item], childFrame, item.role)
		}
	}
	walk(nodes, [], false)
	return { seen, strings }
}

/** The nearest ancestor that has a name, as `role "name"`; absent when none has. */
function contextOf(parents: readonly AriaNode[]): string | undefined {
	for (let i = parents.length - 1; i >= 0; i--) {
		const p = parents[i]
		if (p?.name) return `${p.role} ${quote(p.name)}`
	}
	return undefined
}

/** The nearest ancestor that can be acted on or read by ref, as `role "name" [ref=eN]`. */
function refContextOf(parents: readonly AriaNode[]): string | undefined {
	for (let i = parents.length - 1; i >= 0; i--) {
		const p = parents[i]
		if (p?.ref) return `${p.role}${p.name ? ` ${quote(p.name)}` : ''} [ref=${p.ref}]`
	}
	return undefined
}

/**
 * Only the elements a call can act on, one line each, in page order, with the
 * heading or landmark they sit under. Cheap to read and to re-read; refs are
 * the same as in the full tree.
 */
export function renderInteractive(
	nodes: readonly (string | AriaNode)[],
	hidden: InvisibleBoxes = NO_HIDDEN,
	redact: ReadonlySet<string> = new Set(),
): string {
	const { seen } = shownNodes(nodes, hidden)
	const lines: string[] = []
	for (const { node, parents } of seen) {
		if (!node.ref || !INTERACTIVE_ROLES.has(node.role)) continue
		if (node.role === 'option' && parents.at(-1)?.ref === undefined) continue
		const context = contextOf(parents)
		const url = node.url === undefined ? '' : ` -> ${flat(node.url)}`
		lines.push(`${lineOf(node, redact)}${url}${context ? ` (in ${context})` : ''}`)
	}
	return lines.join('\n')
}

/** What a find looks for. */
export interface FindQuery {
	readonly query?: string
	readonly role?: string
}

/** The result of a find: the matching lines (at most `max`) and how many matched in all. */
export interface FindResult {
	readonly lines: readonly string[]
	readonly total: number
}

/**
 * Elements whose name, own text or direct text contains `query`
 * (case-insensitive), and/or that have the given role. Each match is its tree
 * line with its ref and the nearest named ancestor, so a model can reach
 * something a long page keeps out of sight. A match with no ref of its own (a
 * table cell, a label) is listed with its text and the nearest ref above it.
 */
export function findInTree(
	nodes: readonly (string | AriaNode)[],
	hidden: InvisibleBoxes,
	redact: ReadonlySet<string>,
	find: FindQuery,
	max: number,
): FindResult {
	const needle = find.query?.toLowerCase().trim()
	const role = find.role?.toLowerCase().trim()
	const { seen, strings } = shownNodes(nodes, hidden)
	const out: string[] = []
	let total = 0
	for (const { node, parents } of seen) {
		if (role && node.role.toLowerCase() !== role) continue
		const own = strings.get(node) ?? []
		if (needle) {
			const haystack = [node.name ?? '', node.text ?? '', ...own].join(' ').toLowerCase()
			if (!haystack.includes(needle)) continue
		} else if (!node.ref) {
			// Without a text to look for, only elements a call can name.
			continue
		}
		total += 1
		if (out.length >= max) continue
		let line = lineOf(node, redact)
		if (!node.name && own.length > 0 && heldValue(node, redact) === undefined) {
			const text = own.join(' ')
			line += `: ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`
		}
		// A match that has no ref of its own (a table cell, a label) points at the
		// nearest element above it that has one.
		const context = node.ref ? contextOf(parents) : (refContextOf(parents) ?? contextOf(parents))
		out.push(`${line}${context ? ` (in ${context})` : ''}`)
	}
	return { lines: out, total }
}

/**
 * The page's text without markup: headings as `#` lines, then paragraphs,
 * list items, cells and the like, one per line. For reading an article, where
 * a tree costs more than it tells.
 */
export function renderReading(
	nodes: readonly (string | AriaNode)[],
	hidden: InvisibleBoxes = NO_HIDDEN,
	redact: ReadonlySet<string> = new Set(),
): string {
	const lines: string[] = []
	const push = (text: string): void => {
		const t = flat(text)
		if (t && lines.at(-1) !== t) lines.push(t)
	}
	const walk = (
		items: readonly (string | AriaNode)[],
		inFrame: boolean,
		parentRole?: string,
	): void => {
		for (const item of items) {
			if (typeof item === 'string') {
				push(item)
				continue
			}
			if (item.ariaHidden) continue
			const childFrame = inFrame || item.role === 'iframe'
			// The choices of a select are not text to read; the chosen one is the control's value.
			if (item.role === 'option' && parentRole !== undefined && CHOICE_PARENTS.has(parentRole))
				continue
			if (unseen(item, hidden, inFrame)) {
				walk(item.children ?? [], childFrame, item.role)
				continue
			}
			const ownText = heldValue(item, redact) ?? ''
			const textChildren = (item.children ?? []).some((c) => typeof c === 'string')
			if (item.role === 'heading')
				push(`${'#'.repeat(Math.min(item.level ?? 1, 6))} ${item.name ?? ownText}`)
			else if (item.role === 'img') {
				if (item.name) push(`[image: ${flat(item.name)}]`)
			} else if (ownText) push(ownText)
			else if (!textChildren && item.name && (item.children?.length ?? 0) === 0) push(item.name)
			walk(item.children ?? [], childFrame, item.role)
		}
	}
	walk(nodes, false)
	return lines.join('\n')
}

/** What changed between two renderings of a page's tree. */
export interface LineDiff {
	readonly added: number
	readonly removed: number
	/** The first `shown` lines that appeared, in page order, indentation and the list dash dropped. */
	readonly addedLines: readonly string[]
	readonly removedLines: readonly string[]
}

/** Longest line kept in a diff, in characters. */
const DIFF_LINE_MAX = 160

/**
 * Lines present after and not before (added) and before and not after
 * (removed), compared as a multiset on the trimmed line. Refs of an element
 * that stays do not change between snapshots, so a line that is unchanged is
 * the same text on both sides; a control whose value changed shows as one
 * line removed and one added.
 */
export function diffLines(before: string, after: string, shown = 8): LineDiff {
	const norm = (text: string): string[] =>
		text
			.split('\n')
			.map((l) => l.trim().replace(/^- /, ''))
			.filter((l) => l !== '')
	const a = norm(before)
	const b = norm(after)
	const counts = new Map<string, number>()
	for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1)
	const added: string[] = []
	for (const l of b) {
		const n = counts.get(l) ?? 0
		if (n > 0) counts.set(l, n - 1)
		else added.push(l)
	}
	const left = new Map<string, number>()
	for (const l of b) left.set(l, (left.get(l) ?? 0) + 1)
	const removed: string[] = []
	for (const l of a) {
		const n = left.get(l) ?? 0
		if (n > 0) left.set(l, n - 1)
		else removed.push(l)
	}
	const cut = (l: string): string =>
		l.length > DIFF_LINE_MAX ? `${l.slice(0, DIFF_LINE_MAX - 1)}…` : l
	return {
		added: added.length,
		removed: removed.length,
		addedLines: added.slice(0, shown).map(cut),
		removedLines: removed.slice(0, Math.max(1, Math.floor(shown / 2))).map(cut),
	}
}

/** What the host knew of an action's surroundings, before and after it. */
export interface EffectFacts {
	readonly beforeTree: string
	readonly afterTree: string
	readonly urlBefore: string
	readonly urlNow: string
	readonly tabsBefore: number
	readonly tabsNow: number
	readonly settle: { readonly quiet: boolean; readonly waitedMs: number; readonly capMs: number }
}

/**
 * The effect of one action, computed from the tree before and after it. The
 * host reads the two trees; everything the model is told about the result
 * comes from here, so a test can feed two trees and check the line.
 */
export function buildEffect(facts: EffectFacts, shown = 10): BrowserEffect {
	const diff = diffLines(facts.beforeTree, facts.afterTree, shown)
	const urlChanged = facts.urlNow !== facts.urlBefore
	const changed = diff.added > 0 || diff.removed > 0 || urlChanged
	return {
		...(urlChanged ? { urlChanged: { from: facts.urlBefore, to: facts.urlNow } } : {}),
		added: diff.added,
		removed: diff.removed,
		addedLines: diff.addedLines,
		removedLines: diff.removedLines,
		...(!changed && facts.tabsNow > facts.tabsBefore ? { newTab: true } : {}),
		settle: facts.settle,
	}
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
