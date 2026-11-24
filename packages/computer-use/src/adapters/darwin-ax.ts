import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename } from 'node:path'
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
	/** Waits between looks at a panel that is still listing a folder; for tests. */
	readonly wait?: (ms: number) => Promise<void>
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

	async focusWindow(id: string | number): Promise<FocusWindowResult> {
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

	private async windowById(id: string | number): Promise<WindowInfo> {
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

	private async pickWindow(requested: string | number | undefined): Promise<WindowInfo> {
		if (requested !== undefined) return this.windowById(requested)
		const windows = await this.listWindows()
		const front = windows.find((w) => w.focused) ?? windows[0]
		if (!front) throw new Error('no window is on screen')
		return front
	}

	async uiSnapshot(
		requested?: string | number,
		options: UiSnapshotOptions = {},
	): Promise<UiSnapshot> {
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

	/**
	 * Picks a file in the open or save panel that is in front, through the
	 * panel's accessibility tree: no key shortcut (Cmd+Shift+G does not reach a
	 * panel through posted key events). It uses, in this order, a "Go to the
	 * folder" sheet that is already open; the panel's own path or name field (a
	 * save panel has one); and the panel's "Go to Folder" button when it has
	 * one. It then presses the panel's default button (Open, Choose, Select or
	 * Save) unless `confirm` is false.
	 */
	async pickFile(
		path: string,
		options: {
			readonly windowId?: string | number
			readonly confirm?: boolean
			/** For `~` and for the sidebar's home row; default the current user's home. */
			readonly home?: string
		} = {},
	): Promise<PickFileResult> {
		const wanted = path.trim()
		if (wanted.length === 0) return { ok: false, detail: 'pickFile needs a path' }
		const read = async (query?: string): Promise<readonly Located[]> => {
			const snap = await this.uiSnapshot(options.windowId, {
				...(query === undefined ? { role: PANEL_ROLES } : { query }),
			})
			return flatten(snap.root)
		}
		let elements = await read()
		if (!findPanel(elements.map((e) => e.element)))
			return {
				ok: false,
				detail:
					'no open or save panel is in that window; open it first (its Open, Save or Choose button and Cancel button show it)',
			}
		const confirm = options.confirm !== false
		let sheet = findGoSheet(elements)
		if (!sheet) {
			const field = findPathField(elements)
			if (field) {
				const set = await this.uiAct(field.ref, 'set_value', wanted)
				if (!set.ok)
					return {
						ok: false,
						detail: set.detail ?? 'the path field refused the path',
						via: 'path_field',
					}
				return this.confirmPick(read, confirm, 'path_field')
			}
			const goButton = elements.find(
				(e) =>
					e.element.ref &&
					isRole(e.element, 'button', 'menuitem', 'menubutton') &&
					GO_TO_FOLDER.test(e.element.name),
			)
			if (!goButton) return this.browseTo(wanted, options.home ?? homedir(), read, confirm)
			const opened = await this.uiAct(goButton.element.ref, 'invoke')
			if (!opened.ok)
				return { ok: false, detail: opened.detail ?? 'Go to Folder did not open', via: 'go_sheet' }
			elements = await read()
			sheet = findGoSheet(elements)
			if (!sheet)
				return {
					ok: false,
					detail: 'Go to Folder was pressed but its sheet did not appear',
					via: 'go_sheet',
				}
		}
		const set = await this.uiAct(sheet.field.ref, 'set_value', wanted)
		if (!set.ok)
			return {
				ok: false,
				detail: set.detail ?? 'the Go to Folder field refused the path',
				via: 'go_sheet',
			}
		const go = await this.uiAct(sheet.go.ref, 'invoke')
		if (!go.ok)
			return { ok: false, detail: go.detail ?? 'the Go button did not press', via: 'go_sheet' }
		return this.confirmPick(read, confirm, 'go_sheet')
	}

	/**
	 * An open panel that offers no field for a path (the usual one): start at the sidebar's home (or the
	 * startup disk) and select each folder of the path in the browser, then the file.
	 */
	private async browseTo(
		wanted: string,
		home: string,
		read: (query?: string) => Promise<readonly Located[]>,
		confirm: boolean,
	): Promise<PickFileResult> {
		const via = 'browse' as const
		const absolute = wanted === '~' || wanted.startsWith('~/') ? home + wanted.slice(1) : wanted
		if (!absolute.startsWith('/'))
			return { ok: false, detail: `${wanted} is not an absolute path`, via }
		const underHome = absolute === home || absolute.startsWith(`${home}/`)
		const start = underHome ? basename(home) : 'Macintosh HD'
		const parts = (underHome ? absolute.slice(home.length) : absolute).split('/').filter(Boolean)
		const row = (await read(start)).find(
			(e) => e.inSidebar && isRole(e.element, 'statictext') && e.element.name === start,
		)
		const sidebarRow = row && lastOf(row.ancestors, (a) => isRole(a, 'row') && a.ref !== '')
		if (!sidebarRow)
			return { ok: false, detail: `the panel's sidebar has no "${start}" entry to start from`, via }
		const first = await this.uiAct(sidebarRow.ref, 'select')
		if (!first.ok) return { ok: false, detail: first.detail ?? `${start} did not open`, via }
		for (const [index, part] of parts.entries()) {
			const last = index === parts.length - 1
			const hit = await this.waitForEntry(read, part)
			if (!hit) return { ok: false, detail: `"${part}" is not in the folder the panel shows`, via }
			const act = isRole(hit.element, 'group', 'row') ? 'select' : 'invoke'
			const done = await this.uiAct(hit.element.ref, act)
			if (!done.ok) {
				// Opening the file closes the panel under the call, and macOS answers that call with an error.
				if (last && (await this.panelGone(read)))
					return { ok: true, detail: 'the panel opened the file', via }
				return { ok: false, detail: done.detail ?? `${part} did not open`, via }
			}
			if (!last && hit.element.actions?.includes('expand') && act === 'select')
				await this.uiAct(hit.element.ref, 'expand')
		}
		return this.confirmPick(read, confirm, via)
	}

	private async panelGone(read: (query?: string) => Promise<readonly Located[]>): Promise<boolean> {
		try {
			return !findPanel((await read()).map((e) => e.element))
		} catch {
			return true
		}
	}

	/** The browser entry named `name`, in the rightmost column; the panel needs a moment to list a folder. */
	private async waitForEntry(
		read: (query?: string) => Promise<readonly Located[]>,
		name: string,
	): Promise<{ readonly element: UiElement } | undefined> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const found = (await read(name)).filter(
				(e) =>
					!e.inSidebar &&
					isRole(e.element, 'textfield', 'statictext') &&
					(e.element.value === name || e.element.name === name),
			)
			const hit = found.at(-1)
			// The entry is the row (a list) or the item (a column) that holds the name; `select` picks it. A name
			// whose holder is not in the tree is pressed itself.
			const entry =
				hit &&
				(lastOf(hit.ancestors, (a) => a.ref !== '' && isRole(a, 'group', 'row')) ??
					(hit.element.ref !== '' ? hit.element : undefined))
			if (entry) return { element: entry }
			await (
				this.options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
			)(150)
		}
		return undefined
	}

	private async confirmPick(
		read: (query?: string) => Promise<readonly Located[]>,
		confirm: boolean,
		via: PickFileResult['via'],
	): Promise<PickFileResult> {
		if (!confirm) return { ok: true, detail: 'the path is entered; the panel is still open', via }
		const elements = await read().catch(() => undefined)
		if (!elements || !findPanel(elements.map((e) => e.element)))
			return { ok: true, detail: 'the panel closed with the file chosen', via }
		const button = findDefaultButton(elements)
		if (!button)
			return {
				ok: true,
				detail:
					'the path is entered; the panel has no Open, Choose or Save button in view to press',
				via,
			}
		const pressed = await this.uiAct(button.ref, 'invoke')
		if (!pressed.ok)
			return { ok: false, detail: pressed.detail ?? `${button.name} did not press`, via }
		return { ok: true, detail: `pressed ${button.name}`, via }
	}

	forgetRefs(): void {
		this.refs.clear()
	}
}

// ---------------------------------------------------------------------------
// Open and save panels
// ---------------------------------------------------------------------------

export interface PickFileResult {
	readonly ok: boolean
	readonly detail: string
	/** Which part of the panel took the path. */
	readonly via?: 'go_sheet' | 'path_field' | 'browse'
}

const PANEL_ROLES =
	'AXSheet,AXWindow,AXButton,AXMenuItem,AXMenuButton,AXTextField,AXComboBox,AXSearchField'
const GO_TO_FOLDER = /^go to( the)? folder/i
const DEFAULT_BUTTON = /^(open|choose|select|save)$/i

function lastOf<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
	for (let i = items.length - 1; i >= 0; i--) if (test(items[i] as T)) return items[i]
	return undefined
}

/** An element with the elements above it, and whether it sits in the panel's sidebar. */
interface Located {
	readonly element: UiElement
	readonly ancestors: readonly UiElement[]
	readonly inSidebar: boolean
}

function flatten(root: UiElement): Located[] {
	const out: Located[] = []
	const walk = (element: UiElement, ancestors: readonly UiElement[]): void => {
		out.push({
			element,
			ancestors,
			inSidebar: ancestors.some((a) => a.name === 'sidebar'),
		})
		for (const child of element.children ?? []) walk(child, [...ancestors, element])
	}
	walk(root, [])
	return out
}

const isRole = (element: UiElement, ...roles: string[]): boolean =>
	roles.includes(stripAx(element.role))

/** A panel shows as a Cancel button beside an Open, Choose, Select or Save one. */
function findPanel(elements: readonly UiElement[]): boolean {
	const buttons = elements.filter((e) => isRole(e, 'button'))
	return (
		buttons.some((b) => /^cancel$/i.test(b.name)) &&
		buttons.some((b) => DEFAULT_BUTTON.test(b.name))
	)
}

function findDefaultButton(elements: readonly Located[]): UiElement | undefined {
	return elements.find(
		(e) => e.element.ref && isRole(e.element, 'button') && DEFAULT_BUTTON.test(e.element.name),
	)?.element
}

/** The sheet "Go to the folder:" holds a text field and a Go button. */
function findGoSheet(
	elements: readonly Located[],
): { readonly field: UiElement; readonly go: UiElement } | undefined {
	for (const sheet of elements.filter((e) => isRole(e.element, 'sheet'))) {
		const inside = flatten(sheet.element).map((e) => e.element)
		const field = inside.find((e) => e.ref && isRole(e, 'textfield', 'combobox'))
		const go = inside.find((e) => e.ref && isRole(e, 'button') && /^go$/i.test(e.name))
		if (field && go) return { field, go }
	}
	return undefined
}

/**
 * A save panel's name field takes a full path. Never the search field (it holds a search button), and
 * never a name inside the file browser, where every file's name is a text field.
 */
function findPathField(elements: readonly Located[]): UiElement | undefined {
	const fields = elements.filter(
		(e) =>
			e.element.ref &&
			isRole(e.element, 'textfield', 'combobox') &&
			!e.ancestors.some((a) => isRole(a, 'browser', 'outline', 'table', 'list', 'row')) &&
			!/search/i.test(e.element.name) &&
			!(e.element.children ?? []).some((c) => /search/i.test(c.name)),
	)
	return (
		fields.find((f) => /save as|name|path|go to|folder|where/i.test(f.element.name)) ??
		(fields.length === 1 ? fields[0] : undefined)
	)?.element
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
