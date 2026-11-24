import { createHash } from 'node:crypto'
import type {
	ActionDelivery,
	FocusWindowResult,
	Rect,
	UiActFailureCode,
	UiActResult,
	UiElement,
	UiElementAction,
	UiSnapshot,
	UiSnapshotOptions,
	WindowInfo,
	WindowInputAction,
	WindowInputResult,
	WindowScreenshotResult,
} from '@namzu/sdk'
import type { A11ySeq, A11yWindow } from '../a11y/interface.js'
import { A11yError } from '../a11y/interface.js'
import { cgWindowId } from '../a11y/macos.js'
import type { MacA11yHost, MacControlAction, MacNode, MacTree } from '../a11y/macos.js'
import { decodePngSize } from './png.js'

/** A window with more shown controls than this is returned as an outline. */
const OUTLINE_THRESHOLD = 400
/** The most controls an outline shows; the rest are counted, not listed. */
const OUTLINE_BUDGET = 300
/** The most children of one element an outline lists; a long list is opened as a region. */
const OUTLINE_PER_PARENT = 20
/** The children of a region opened by itself that one page lists. */
const OUTLINE_PAGE = 60
/** The most nodes one read asks the helper for. */
const READ_MAX_NODES = 3_000
const READ_MAX_DEPTH = 24
const READ_TIMEOUT_MS = 8_000
/** Refs the model holds; the oldest are forgotten past this. */
const MAX_REFS = 6_000

/** Containers that say nothing: passed through, their children take their place. */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set([
	'AXGroup',
	'AXUnknown',
	'AXLayoutArea',
	'AXLayoutItem',
])
const TEXT_INPUT_ROLES: ReadonlySet<string> = new Set([
	'AXTextField',
	'AXTextArea',
	'AXComboBox',
	'AXSearchField',
	'AXSecureTextField',
])

interface RefEntry {
	readonly windowId: string
	readonly node: MacNode
	/** The ref names a region of hidden children, not a control to act on. */
	readonly region: boolean
}

interface CaptureFrame {
	readonly captureId: string
	readonly window: WindowInfo
	readonly width: number
	readonly height: number
}

export interface MacAxSurfaceOptions {
	readonly host: MacA11yHost
	/** Captured pixels per point of the main display; the adapter binds its own after construction. */
	readonly scale: () => Promise<number>
	/** A key combination as a virtual key code and modifier names; throws on one it cannot press. */
	readonly keyEvent: (combo: string) => { readonly code: number; readonly flags: readonly string[] }
	/** For tests. */
	readonly now?: () => number
}

const stripAx = (role: string): string => role.replace(/^AX/i, '').toLowerCase()

function windowInfo(w: A11yWindow): WindowInfo {
	return {
		id: String(cgWindowId(w.windowId)),
		title: w.title,
		app: w.processName,
		pid: w.processId,
		bounds: w.bounds,
		focused: w.focused,
		minimized: w.minimized,
	}
}

function failure(code: UiActFailureCode, detail: string): UiActResult {
	return { ok: false, delivery: 'not_delivered', retrySafety: 'safe', code, detail }
}

function statesOf(node: MacNode): string[] {
	const states: string[] = []
	if (!node.enabled) states.push('disabled')
	if (node.focused) states.push('focused')
	if (node.selected) states.push('selected')
	if (node.toggle === 'on') states.push('checked')
	else if (node.toggle === 'mixed') states.push('mixed')
	if (node.expand === 'expanded' || node.expand === 'collapsed') states.push(node.expand)
	return states
}

function actionsOf(node: MacNode): UiElementAction[] {
	const out: UiElementAction[] = []
	for (const a of node.actions) {
		if (a === 'invoke') out.push('invoke')
		else if (a === 'value') out.push('set_value')
		else if (a === 'toggle') out.push('toggle')
		else if (a === 'selectionItem') out.push('select')
		else if (a === 'expandCollapse') out.push('expand', 'collapse')
	}
	if (TEXT_INPUT_ROLES.has(node.role) && !out.includes('focus')) out.push('focus')
	return out
}

function refFor(windowId: string, node: MacNode): string {
	const digest = createHash('sha1')
		.update(`${windowId}|${node.fingerprint.runtimeId}`)
		.digest('hex')
	return `ax${digest.slice(0, 8)}`
}

/**
 * macOS windows and accessibility for the macOS adapter, answered by the
 * helper app. A ref names a control by its fingerprint, not by one reading:
 * it survives snapshots, and when the control is rebuilt the helper finds it
 * again by id, name and place, or says `STALE_REF` / `AMBIGUOUS_TARGET`.
 */
export class MacAxSurface {
	private readonly refs = new Map<string, RefEntry>()
	private readonly frames = new Map<string, CaptureFrame>()
	private readonly marks = new Map<string, A11ySeq>()
	private captureCounter = 0

	private scaleOf: () => Promise<number>

	constructor(private readonly options: MacAxSurfaceOptions) {
		this.scaleOf = options.scale
	}

	/** Uses the adapter's own pixels-per-point, which a capture keeps exact. */
	bindScale(scale: () => Promise<number>): void {
		this.scaleOf = scale
	}

	async close(): Promise<void> {
		await this.host.close()
	}

	release(): void {
		this.host.release()
	}

	private get host(): MacA11yHost {
		return this.options.host
	}

	async listWindows(): Promise<readonly WindowInfo[]> {
		return (await this.host.listWindows({ includeOwned: true })).map(windowInfo)
	}

	async focusWindow(id: string): Promise<FocusWindowResult> {
		const result = await this.host.focus(String(cgWindowId(id)))
		return {
			ok: result.ok,
			focusedId: result.focusedId,
			...(result.ok
				? {}
				: {
						detail: 'macOS did not put that window in front; another app may be holding the focus',
					}),
		}
	}

	private async windowById(id: string): Promise<WindowInfo> {
		const wanted = String(cgWindowId(id))
		const found = (await this.listWindows()).find((w) => w.id === wanted)
		if (!found)
			throw new Error(`window ${wanted} is not on screen; list the windows again and pick one`)
		return found
	}

	async captureWindow(id: string): Promise<WindowScreenshotResult> {
		const window = await this.windowById(id)
		const shot = await this.host.captureWindow(window.id)
		const size = decodePngSize(shot.data) ?? { width: shot.width, height: shot.height }
		const captureId = `mac-${window.id}-${++this.captureCounter}`
		this.frames.set(window.id, { captureId, window, width: size.width, height: size.height })
		return {
			data: shot.data,
			mimeType: 'image/png',
			width: size.width,
			height: size.height,
			window,
			captureId,
			captureCoverage:
				shot.via === 'screencapturekit' ? 'window only' : 'window only (screencapture)',
		}
	}

	/** Global screen points for a pixel of the capture. */
	private async pointOf(
		frame: CaptureFrame,
		x: number,
		y: number,
	): Promise<{ x: number; y: number }> {
		const scale = await this.scaleOf()
		const b = frame.window.bounds
		const ratioX = frame.width > 0 ? b.width / frame.width : 1
		const ratioY = frame.height > 0 ? b.height / frame.height : 1
		return { x: (b.x + x * ratioX) / scale, y: (b.y + y * ratioY) / scale }
	}

	async executeWindow(
		captureId: string,
		action: WindowInputAction,
	): Promise<WindowInputResult | undefined> {
		const frame = [...this.frames.values()].find((f) => f.captureId === captureId)
		if (!frame || this.frames.get(frame.window.id)?.captureId !== captureId)
			throw new Error('that capture is out of date; capture the window again before acting on it')
		const current = await this.windowById(frame.window.id)
		const a = frame.window.bounds
		const b = current.bounds
		if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height)
			throw new Error('the window moved or changed size since the capture; capture it again')
		const windowId = frame.window.id
		this.marks.set(windowId, await this.host.seq(windowId).catch(() => 0))
		const unverified = (detail?: string): WindowInputResult => ({
			delivery: 'delivered_unverified' as ActionDelivery,
			retrySafety: 'unsafe',
			...(detail ? { detail } : {}),
		})
		switch (action.type) {
			case 'mouse_click': {
				const at = await this.pointOf(frame, action.at.x, action.at.y)
				await this.host.click({
					windowId,
					...at,
					...(action.button === 'right' ? { button: 'right' as const } : {}),
					...(action.count ? { count: action.count } : {}),
				})
				return unverified()
			}
			case 'mouse_drag': {
				const from = await this.pointOf(frame, action.from.x, action.from.y)
				const to = await this.pointOf(frame, action.to.x, action.to.y)
				await this.host.click({ windowId, ...from, to })
				return unverified()
			}
			case 'scroll': {
				const at = await this.pointOf(frame, action.at.x, action.at.y)
				await this.host.scroll({
					windowId,
					direction: action.direction,
					amount: action.amount,
					at,
				})
				return unverified()
			}
			case 'type_text': {
				if (action.delivery_mode === 'foreground') await this.host.focus(windowId)
				await this.host.typeText({ windowId, text: action.text })
				return unverified()
			}
			case 'key': {
				if (action.delivery_mode === 'foreground') await this.host.focus(windowId)
				const key = this.options.keyEvent(action.keys)
				await this.host.pressKey({ windowId, code: key.code, flags: key.flags })
				return unverified()
			}
		}
	}

	async settleAfterInput(
		request: { readonly windowId?: string; readonly budgetMs: number },
		signal?: AbortSignal,
	): Promise<{ readonly waitedMs: number; readonly changed: boolean } | undefined> {
		if (request.windowId === undefined || !this.host.isReady) return undefined
		const windowId = String(cgWindowId(request.windowId))
		const since = this.marks.get(windowId)
		try {
			const waited = await this.host.waitForChange(
				{
					windowId,
					timeoutMs: request.budgetMs,
					quietMs: 120,
					...(since !== undefined ? { since } : {}),
				},
				signal,
			)
			return waited.changed
				? { waitedMs: waited.settledMs, changed: true }
				: { waitedMs: waited.settledMs, changed: false }
		} catch {
			return undefined
		}
	}

	async scrollAt(
		at: { readonly x: number; readonly y: number },
		direction: 'up' | 'down' | 'left' | 'right',
		amount: number,
	): Promise<void> {
		const scale = await this.scaleOf()
		await this.host.scroll({ direction, amount, at: { x: at.x / scale, y: at.y / scale } })
	}

	// --- accessibility tree -------------------------------------------------

	private remember(windowId: string, node: MacNode, region: boolean): string {
		const ref = refFor(windowId, node)
		this.refs.delete(ref)
		this.refs.set(ref, { windowId, node, region })
		if (this.refs.size > MAX_REFS) {
			const oldest = this.refs.keys().next().value
			if (oldest !== undefined) this.refs.delete(oldest)
		}
		return ref
	}

	private async pickWindow(requested: string | undefined): Promise<WindowInfo> {
		if (requested !== undefined) return this.windowById(requested)
		const windows = await this.listWindows()
		const front = windows.find((w) => w.focused) ?? windows[0]
		if (!front) throw new Error('no window is on screen')
		return front
	}

	async uiSnapshot(requested?: string, options: UiSnapshotOptions = {}): Promise<UiSnapshot> {
		let windowId = requested === undefined ? undefined : String(cgWindowId(requested))
		let rootEntry: RefEntry | undefined
		if (options.root !== undefined) {
			rootEntry = this.refs.get(options.root)
			if (!rootEntry)
				throw new Error(
					`STALE_REF: ${options.root} is not a region or control this session was shown. Take a ui_snapshot of the window and use a ref from it.`,
				)
			if (windowId !== undefined && windowId !== rootEntry.windowId)
				throw new Error(
					`${options.root} belongs to window ${rootEntry.windowId}, not ${windowId}. Pass the window it came from, or leave window_id out.`,
				)
			windowId = rootEntry.windowId
		}
		const window = await this.pickWindow(windowId)
		const tree = await this.host.readTree({
			windowId: window.id,
			maxNodes: READ_MAX_NODES,
			maxDepth: READ_MAX_DEPTH,
			timeoutMs: READ_TIMEOUT_MS,
			allowChromium: true,
			...(rootEntry ? { root: rootEntry.node.fingerprint } : {}),
		})
		const built = this.buildTree(tree)
		const query = options.query?.trim().toLowerCase()
		const roles = new Set(
			(options.role ?? '')
				.split(',')
				.map((r) => stripAx(r.trim()))
				.filter((r) => r.length > 0),
		)
		let root = built.element
		let regions = false
		let next: number | undefined
		if (query || roles.size > 0) {
			root = prune(root, (el) => {
				const text = `${el.name} ${el.value ?? ''}`.toLowerCase()
				const textOk = !query || text.includes(query)
				const roleOk = roles.size === 0 || roles.has(stripAx(el.role))
				return textOk && roleOk
			})
		} else if (visibleCount(root) > OUTLINE_THRESHOLD) {
			const out = outlineOf(
				root,
				OUTLINE_BUDGET,
				rootEntry ? { offset: options.offset ?? 0 } : undefined,
			)
			root = out.root
			regions = out.regions
			next = out.next
		}
		root = this.bindRefs(window.id, root, built.nodes)
		return {
			windowId: window.id,
			...(window.title ? { title: tree.title || window.title } : {}),
			app: tree.app || window.app,
			root,
			...(tree.truncated ? { truncated: true } : {}),
			...(regions ? { outline: true } : {}),
			total: tree.total,
			...(rootEntry ? { region: true } : {}),
			...(next !== undefined ? { next } : {}),
			...(tree.selectedText ? { selectedText: tree.selectedText } : {}),
		}
	}

	/** The tree as elements; each element's `ref` is its fingerprint's key until bound. */
	private buildTree(tree: MacTree): { element: UiElement; nodes: Map<UiElement, MacNode> } {
		const byIndex = new Map<number, MacNode[]>()
		for (const node of tree.nodes) {
			const list = byIndex.get(node.parent) ?? []
			list.push(node)
			byIndex.set(node.parent, list)
		}
		const nodes = new Map<UiElement, MacNode>()
		const make = (node: MacNode): UiElement[] => {
			const kids = (byIndex.get(node.index) ?? []).flatMap(make)
			const hidden = kids.length === 0 && (node.childCount ?? 0) > 0 ? (node.childCount ?? 0) : 0
			const actions = actionsOf(node)
			const name = node.name ?? ''
			if (
				TRANSPARENT_ROLES.has(node.role) &&
				name === '' &&
				node.value === undefined &&
				actions.length === 0 &&
				hidden === 0 &&
				node.index !== 0
			)
				return kids
			const states = statesOf(node)
			const r = node.bounds
			const bounds: Rect | undefined =
				r.width > 0 && r.height > 0 && !node.offscreen
					? { x: r.x, y: r.y, width: r.width, height: r.height }
					: undefined
			const element: UiElement = {
				ref: '',
				role: node.role,
				name,
				...(node.value !== undefined ? { value: node.value } : {}),
				...(node.automationId ? { automationId: node.automationId } : {}),
				...(bounds ? { bounds } : {}),
				...(states.length > 0 ? { states } : {}),
				...(actions.length > 0 ? { actions } : {}),
				...(kids.length > 0 ? { children: kids } : {}),
				...(hidden > 0 ? { hiddenChildren: hidden } : {}),
			}
			nodes.set(element, node)
			return [element]
		}
		const top = tree.nodes.find((n) => n.parent === -1)
		const made = top ? make(top) : []
		const element = made[0] ?? { ref: '', role: 'AXWindow', name: tree.title }
		return { element, nodes }
	}

	/** Gives the kept elements their refs: controls that can be acted on, and regions with hidden children. */
	private bindRefs(windowId: string, root: UiElement, nodes: Map<UiElement, MacNode>): UiElement {
		const walk = (el: UiElement): UiElement => {
			const children = (el.children ?? []).map(walk)
			const node = nodes.get(el) ?? nodes.get(original.get(el) as UiElement)
			const actionable = (el.actions?.length ?? 0) > 0
			const isRegion = (el.hiddenChildren ?? 0) > 0
			const ref = node && (actionable || isRegion) ? this.remember(windowId, node, !actionable) : ''
			const { children: _children, ...rest } = el
			return Object.freeze({
				...rest,
				ref,
				...(children.length > 0 ? { children: Object.freeze(children) } : {}),
			}) as UiElement
		}
		return walk(root)
	}

	async uiAct(ref: string, action: UiElementAction, value?: string): Promise<UiActResult> {
		const entry = this.refs.get(ref)
		if (!entry)
			return failure(
				'STALE_REF',
				`${ref} is not a control this session was shown. Take a ui_snapshot and use a ref from it.`,
			)
		if (entry.region)
			return failure(
				'STALE_REF',
				`${ref} names a region, not a control. Open it with ui_snapshot root.`,
			)
		const mapped: Record<UiElementAction, MacControlAction> = {
			invoke: 'invoke',
			focus: 'focus',
			set_value: 'set_value',
			toggle: 'toggle',
			select: 'select',
			expand: 'expand',
			collapse: 'collapse',
			scroll_into_view: 'scroll_into_view',
		}
		if (action === 'set_value' && value === undefined)
			return failure('STALE_REF', 'set_value needs a value')
		this.marks.set(entry.windowId, await this.host.seq(entry.windowId).catch(() => 0))
		try {
			const result = await this.host.act({
				windowId: entry.windowId,
				fingerprint: entry.node.fingerprint,
				action: mapped[action],
				...(value !== undefined ? { value } : {}),
			})
			if (!result.done)
				return {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: result.detail ?? 'the control did not accept that action',
				}
			const readBack =
				result.expected !== undefined || result.after !== undefined
					? {
							...(result.expected !== undefined ? { expected: result.expected } : {}),
							...(result.after !== undefined ? { observed: result.after } : {}),
						}
					: undefined
			if (result.verified === false)
				return {
					ok: true,
					delivery: 'delivered_unverified',
					retrySafety: 'unsafe',
					detail: 'the control took the action but its state did not read back as asked',
					...(readBack ? { readBack } : {}),
				}
			return {
				ok: true,
				delivery: result.verified === true ? 'delivered_verified' : 'delivered_unverified',
				retrySafety: 'unsafe',
				...(readBack ? { readBack } : {}),
			}
		} catch (error) {
			if (error instanceof A11yError) {
				if (error.code === 'STALE_REF' || error.code === 'AMBIGUOUS_TARGET')
					return failure(error.code, error.message)
				return { ok: false, delivery: 'not_delivered', retrySafety: 'safe', detail: error.message }
			}
			throw error
		}
	}

	forgetRefs(): void {
		this.refs.clear()
	}
}

// ---------------------------------------------------------------------------
// Views of a tree
// ---------------------------------------------------------------------------

/** Original element of a rebuilt (frozen) one, so a pruned view still finds its node. */
const original = new WeakMap<UiElement, UiElement>()

function isSilent(element: UiElement): boolean {
	return (
		(element.actions?.length ?? 0) === 0 &&
		(element.hiddenChildren ?? 0) === 0 &&
		element.name.trim().length === 0 &&
		element.value === undefined
	)
}

function visibleCount(element: UiElement): number {
	let count = isSilent(element) ? 0 : 1
	for (const child of element.children ?? []) count += visibleCount(child)
	return count
}

/** The elements that match, with every element above them. */
function prune(root: UiElement, matches: (element: UiElement) => boolean): UiElement {
	const walk = (element: UiElement): UiElement | undefined => {
		const kept = (element.children ?? []).map(walk).filter((c): c is UiElement => c !== undefined)
		if (!matches(element) && kept.length === 0) return undefined
		const { children: _children, hiddenChildren: _hidden, ...rest } = element
		const copy = Object.freeze({
			...rest,
			...(kept.length > 0 ? { children: Object.freeze(kept) } : {}),
		}) as UiElement
		original.set(copy, element)
		return copy
	}
	const { children: _children, ...bare } = root
	return walk(root) ?? (Object.freeze({ ...bare, hiddenChildren: 0 }) as UiElement)
}

/**
 * The top of a big tree, breadth first, so the window's layout shows before
 * any one region's detail; what is left out is counted on the element that
 * holds it, and that element is a region the model can open.
 */
function outlineOf(
	root: UiElement,
	budget: number,
	page?: { readonly offset: number },
): { root: UiElement; regions: boolean; next: number | undefined } {
	const keep = new Set<UiElement>([root])
	const queue: UiElement[] = [root]
	let used = isSilent(root) ? 0 : 1
	let next: number | undefined
	while (queue.length > 0) {
		const element = queue.shift() as UiElement
		const isRoot = element === root
		const children = element.children ?? []
		const first = isRoot && page ? Math.min(page.offset, children.length) : 0
		const cap = isRoot && page ? OUTLINE_PAGE : OUTLINE_PER_PARENT
		let listed = 0
		let cut = false
		for (let index = first; index < children.length; index++) {
			const child = children[index] as UiElement
			const cost = isSilent(child) ? 0 : 1
			if (cut || used + cost > budget || listed + cost > cap || keep.size > budget * 4) {
				cut = true
				if (isRoot && page && next === undefined) next = index
				continue
			}
			used += cost
			listed += cost
			keep.add(child)
			queue.push(child)
		}
	}
	let regions = false
	const build = (element: UiElement): UiElement => {
		const children = element.children ?? []
		const kept = children.filter((c) => keep.has(c)).map(build)
		const hidden = children.length - kept.length + (element.hiddenChildren ?? 0)
		if (children.length - kept.length > 0) regions = true
		const { children: _children, hiddenChildren: _hidden, ...rest } = element
		const copy = Object.freeze({
			...rest,
			...(kept.length > 0 ? { children: Object.freeze(kept) } : {}),
			...(hidden > 0 ? { hiddenChildren: hidden } : {}),
		}) as UiElement
		original.set(copy, element)
		return copy
	}
	return { root: build(root), regions, next }
}
