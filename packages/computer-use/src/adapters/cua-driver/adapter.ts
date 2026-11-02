import { randomUUID } from 'node:crypto'
import type {
	ActionDelivery,
	ActionRetrySafety,
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	DisplayInfo,
	FocusWindowResult,
	ScreenshotResult,
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
import { droppedInputNote, foregroundNote, interferenceNote } from '../../foreground/guard.js'
import type { ForegroundLadder, LadderRequest } from '../../foreground/ladder.js'
import { BurstInterrupted, type ForegroundSubject } from '../../foreground/types.js'
import type { Presence } from '../../presence/presence.js'
import { CallAbortedError, currentCallSignal, markSent } from '../../util/call-scope.js'
import type { Adapter } from '../types.js'
import {
	type McpProcessCallOptions,
	McpStdioClient,
	type McpStdioClientOptions,
	type McpToolCaller,
	McpToolError,
	type McpToolResult,
} from './client.js'
import { translateKeyForCuaDriver } from './keys.js'
import {
	type Observation,
	type ObservedVerdict,
	judgeEdit,
	judgeEditBetween,
	judgeObserved,
	observationOf,
	sameObservation,
} from './observe.js'
import {
	type ParsedUiTree,
	type UiEvidence,
	type UiNode,
	type UiRefFacts,
	locate,
	toUiTree,
} from './ui-tree.js'

/**
 * The Windows desktop through cua-driver (github.com/trycua/cua, MIT): one
 * `cua-driver.exe mcp` process for the adapter's lifetime, spoken to as an
 * MCP server over its standard streams.
 *
 * Display input uses `desktop` scope. A capture explicitly addressed to a
 * window enables `window` scope, whose pixels are relative to that PNG and
 * whose actions carry the captured PID and HWND.
 *
 * What the adapter adds on top:
 * - the animated agent cursor is switched off for its session: with it, a
 *   click took 0.9–3.8 s (the cursor glides to the target) instead of about
 *   0.12 s, and a full-screen overlay window joined the window list;
 * - a single printable key is typed as text (see `./keys.ts`);
 * - a pointer action whose only failure is cua-driver's after-the-fact
 *   foreground check is reported as done (see {@link isDeliveredPointerAction});
 * - the window list drops cua-driver's own overlay, the shell's desktop and
 *   1-pixel windows, and orders it front to back;
 * - a window's UI Automation tree (`get_window_state`) becomes a `UiSnapshot`
 *   with adapter-owned refs; `uiAct` translates them to driver element tokens:
 *   UIA Invoke for a button, ValuePattern for a field, falling back
 *   to typing into a field that is empty and has no settable value (classic
 *   Notepad's editor is one).
 */

export interface CuaDriverAdapterOptions {
	/** `cua-driver.exe`, as this process starts it (a Linux path under WSL). */
	readonly executable: string
	/** The environment for it; see `cuaDriverEnvironment` in `../win32.ts`. */
	readonly env: NodeJS.ProcessEnv
	readonly cwd?: string
	/** For the backend label; the pinned version when it is the pinned build. */
	readonly version?: string
	/**
	 * Where a window action that cannot be delivered in the background is
	 * retried in the foreground: through the idle gate, the screen lease and a
	 * restore. Absent, such an action is reported as not delivered.
	 */
	readonly foreground?: ForegroundLadder
	/**
	 * The agent cursor and window border shown while a window is operated.
	 * Absent, nothing is drawn.
	 */
	readonly presence?: Presence
	/** For tests: the clock the freshness of a read is judged by. */
	readonly now?: () => number
	/** For tests: how the adapter waits for a window to show an input's effect. */
	readonly settle?: (ms: number) => Promise<void>
	/** For tests. */
	readonly spawnProcess?: McpStdioClientOptions['spawnProcess']
	readonly requestTimeoutMs?: number
	readonly startTimeoutMs?: number
}

const CAPTURE_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 20_000
/** A browser window's tree takes 2–3 s; a huge one is cut by `UI_MAX_ELEMENTS` first. */
const UI_TREE_TIMEOUT_MS = 30_000
/** The most nodes one read walks. The model is shown an outline of a large one, never all of it. */
const UI_MAX_ELEMENTS = 5_000
/**
 * The driver cuts a walk at its cap without saying so (the answer carries no
 * flag), so a walk this close to the cap is treated as cut.
 */
const UI_WALK_CUT_AT = Math.floor(UI_MAX_ELEMENTS * 0.95)
/** A window with more shown controls than this is returned as an outline. */
const OUTLINE_THRESHOLD = 220
/** The most controls an outline shows; the rest are counted, not listed. */
const OUTLINE_BUDGET = 150
/** The most children of one element an outline lists; a long list is opened as a region. */
const OUTLINE_PER_PARENT = 12
/** The children of a region opened by itself that one page lists. */
const OUTLINE_PAGE = 60
/** A browser tree this small is the window frame alone: the page has not been built yet. */
const SPARSE_TREE = 12
/** Controls that offer a choice among options, which the keyboard can make when the driver cannot. */
const CHOICE_ROLES = /^(ComboBox|List|ListBox)$/i
/** Waits (ms) before each read that looks for an input's effect: at once, then a little later. */
const OBSERVE_WAITS_MS = [0, 80, 200, 450] as const
const BROWSER_APP = /chrome|msedge|edge|brave|vivaldi|opera|firefox|chromium/i
/**
 * A ref read longer ago than this is checked against a new read before it
 * is acted on. Within it, the driver's own handle check (it refuses a handle
 * a newer read of the window replaced) guards the write.
 */
/** Driver tools that only read; every other tool may change the desktop. */
const READ_ONLY_TOOL = /^(get_|list_|start_session|set_agent_cursor|check_|describe)/

/** Whether a driver tool call can change the desktop (so a lost one is an unknown outcome). */
export function changesDesktop(tool: string): boolean {
	return !READ_ONLY_TOOL.test(tool)
}

const IDENTITY_FRESH_MS = 3_000
/** Refs the adapter keeps; the model is shown far fewer. */
const MAX_REFS = 4_000
/** The most refs one read creates; a quarter of the budget, so one read cannot evict the rest. */
const NEW_REFS_PER_READ = 1_000
/** cua-driver refuses more than 50 ticks in one scroll call. */
const MAX_SCROLL_TICKS = 50
/** A drag glides through intermediate moves; many targets ignore one that teleports. */
const DRAG = { durationMs: 250, steps: 12 } as const

/**
 * Switches the driver's own animated cursor off for the session (Namzu draws
 * its own, and two cursors are never shown). The driver keeps an empty,
 * fully transparent, click-through overlay window either way; with the cursor off it draws nothing into it. Returns whether
 * the driver confirmed it: a build without the tool still works, only slower,
 * and then Namzu shows no cursor of its own (see `tryPresence`).
 */
async function disableAgentCursor(call: McpToolCaller): Promise<boolean> {
	try {
		const result = await call('set_agent_cursor_enabled', { enabled: false })
		return result.structuredContent?.enabled === false
	} catch {
		return false
	}
}

interface UiRefEntry extends UiRefFacts {
	readonly token: string
	readonly pid: number
	readonly hwnd: number
	readonly generation: number
	readonly processStarts: number
	/** The adapter's number for the read of the window this handle came from. */
	readonly readSeq: number
	readonly readAt: number
	/** A container the model can open with a root snapshot; it has no driver handle. */
	readonly region: boolean
	/** Where the control was when it was read, in virtual-desktop pixels; shows where the agent cursor goes. */
	readonly bounds?: {
		readonly x: number
		readonly y: number
		readonly width: number
		readonly height: number
	}
}

interface WindowCaptureFrame {
	readonly id: string
	readonly window: WindowInfo
	readonly width: number
	readonly height: number
	readonly processStarts: number
	readonly generation: number
}

const pathKey = (path: readonly number[]): string => path.join('.')

/** Evidence as words, for a message: `Button "Save"`. App text, so cut and without quotes or line breaks. */
function describeEvidence(evidence: UiEvidence): string {
	const name = evidence.name.replace(/["\r\n]+/g, ' ').trim()
	const role = /^[A-Za-z][\w-]{0,39}$/.test(evidence.role) ? evidence.role : 'Element'
	return name ? `${role} "${name.length > 60 ? `${name.slice(0, 59)}…` : name}"` : role
}

/** How many controls fit a ref; one means it was one of several identical controls and the window has changed since. */
function fitText(count: number): string {
	return count > 1
		? `${count} controls fit`
		: 'the window changed and which of several identical controls it was cannot be told for'
}

function refFailure(code: UiActFailureCode, detail: string): UiActResult {
	return {
		ok: false,
		delivery: 'not_delivered',
		retrySafety: 'safe',
		code,
		detail,
	}
}

function factsOfNode(node: UiNode): UiRefFacts {
	return {
		role: node.role,
		name: node.name,
		...(node.automationId !== undefined ? { automationId: node.automationId } : {}),
		selected: false,
		actions: [],
		path: node.path,
	}
}

/** Whether the model would be shown this element: a nameless control nobody can act on is passed through. */
function isSilent(element: UiElement): boolean {
	return element.ref === '' && element.name.trim().length === 0 && element.value === undefined
}

function visibleCount(element: UiElement): number {
	let count = isSilent(element) ? 0 : 1
	for (const child of element.children ?? []) count += visibleCount(child)
	return count
}

/**
 * The top of a big tree: breadth first, shallow levels before deep ones, so
 * the whole window's layout is shown before any one region's detail. What is
 * left out is counted on the element that holds it, and that element is a
 * region the model can open.
 */
function outlineOf(
	root: UiElement,
	basePath: readonly number[],
	budget: number,
	page?: { readonly offset: number },
): { root: UiElement; regions: Set<string>; next: number | undefined } {
	const keep = new Set<UiElement>([root])
	const queue: UiElement[] = [root]
	let used = isSilent(root) ? 0 : 1
	let next: number | undefined
	while (queue.length > 0) {
		const element = queue.shift() as UiElement
		const isRoot = element === root
		// A region opened by itself lists a page of its own children; the page
		// after it is asked for with the offset it reports.
		const children = element.children ?? []
		const first = isRoot && page ? Math.min(page.offset, children.length) : 0
		const cap = isRoot && page ? OUTLINE_PAGE : OUTLINE_PER_PARENT
		let listed = 0
		let cut = false
		for (let index = first; index < children.length; index++) {
			const child = children[index] as UiElement
			const cost = isSilent(child) ? 0 : 1
			// One long list must not use the budget its siblings' regions need.
			// Once the list is cut, nothing after the cut is listed, nameless or
			// not: the next page begins at the cut and would repeat it.
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
	const regions = new Set<string>()
	const build = (element: UiElement, path: readonly number[]): UiElement => {
		const children = element.children ?? []
		const kept: UiElement[] = []
		children.forEach((child, index) => {
			if (!keep.has(child)) return
			const built = build(child, [...path, index])
			ORIGINAL_INDEX.set(built, index)
			kept.push(built)
		})
		const hidden = children.length - kept.length
		if (hidden > 0) regions.add(pathKey(path))
		const { children: _children, ...rest } = element
		return Object.freeze({
			...rest,
			...(kept.length > 0 ? { children: Object.freeze(kept) } : {}),
			...(hidden > 0 ? { hiddenChildren: hidden } : {}),
		}) as UiElement
	}
	return { root: build(root, basePath), regions, next }
}

/** The paths of the elements a view contains. */
function collectShown(element: UiElement, path: readonly number[], into: Set<string>): void {
	into.add(pathKey(path))
	const children = element.children ?? []
	// A pruned view lists the kept children in order, but their indexes in the
	// full tree are not 0..n; the view carries them by identity (see withRefs).
	children.forEach((child, index) => {
		collectShown(child, [...path, pathIndex(element, child, index)], into)
	})
}

const ORIGINAL_INDEX = new WeakMap<UiElement, number>()
function pathIndex(_parent: UiElement, child: UiElement, fallback: number): number {
	return ORIGINAL_INDEX.get(child) ?? fallback
}

/** The elements of a view with the adapter's refs in place of driver handles. */
function withRefs(
	element: UiElement,
	path: readonly number[],
	refAt: (path: readonly number[]) => string,
): UiElement {
	const children = (element.children ?? []).map((child, index) =>
		withRefs(child, [...path, pathIndex(element, child, index)], refAt),
	)
	const { children: _children, ...rest } = element
	return Object.freeze({
		...rest,
		ref: refAt(path),
		...(children.length > 0 ? { children: Object.freeze(children) } : {}),
	}) as UiElement
}

export class CuaDriverAdapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities
	readonly backend: string
	private readonly client: McpStdioClient
	/** Window id → owning pid, from the latest list; `bring_to_front` needs both. */
	private readonly windowPids = new Map<string, number>()
	/** Window id → application name, for naming the program a foreground burst is for. */
	private readonly windowApps = new Map<string, string>()
	private readonly foreground: ForegroundLadder | undefined
	private readonly presence: Presence | undefined
	/** False once the driver would not switch its own cursor off: Namzu's is then not shown, so there is never a second one. */
	private driverCursorOff: boolean | undefined
	/** cua-driver's screenshot resize registry is per PID, so only this capture may drive input. */
	private windowFrame: WindowCaptureFrame | undefined
	/** Capture and scoped input must not race over cua-driver's per-PID resize ratio. */
	private windowOperation: Promise<void> = Promise.resolve()
	/** Refs the model holds, by the adapter's ref. A handle is usable only in its window's latest read; otherwise the ref is found again. */
	private uiRefs = new Map<string, UiRefEntry>()
	/** Per window: the latest read of its tree, which is the only one its driver handles belong to. */
	private readonly windowReads = new Map<number, { seq: number; at: number }>()
	private readonly uiRefNamespace = randomUUID()
	private nextRead = 0
	private nextRef = 0
	private readonly now: () => number
	private readonly settle: (ms: number) => Promise<void>
	/** A successful revival invalidates refusals from the previous lifecycle episode. */
	private sessionGeneration = 0
	/** Share one revival among calls refused by the same expired implicit session. */
	private sessionRevival: Promise<void> | undefined

	constructor(options: CuaDriverAdapterOptions) {
		this.backend = `cua-driver${options.version ? ` ${options.version}` : ''}`
		this.foreground = options.foreground
		this.presence = options.presence
		this.now = options.now ?? Date.now
		this.settle = options.settle ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
		this.client = new McpStdioClient({
			command: options.executable,
			args: ['mcp'],
			env: options.env,
			cwd: options.cwd,
			clientName: 'namzu-computer-use',
			requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
			startTimeoutMs: options.startTimeoutMs ?? 30_000,
			spawnProcess: options.spawnProcess,
			afterStart: async (call) => {
				this.driverCursorOff = await disableAgentCursor(call)
			},
		})
		this.capabilities = Object.freeze({
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			// cua-driver has clipboard tools; this adapter offers no clipboard action.
			clipboard: false,
			supportedActions: Object.freeze([
				'screenshot' as const,
				'cursor_position' as const,
				'mouse_move' as const,
				'mouse_click' as const,
				'mouse_drag' as const,
				'scroll' as const,
				'type_text' as const,
				'key' as const,
			]),
			mouseClickButtons: Object.freeze(['left' as const, 'right' as const, 'middle' as const]),
			mouseDragButtons: Object.freeze(['left' as const, 'right' as const, 'middle' as const]),
			windows: true,
			windowCapture: true,
			windowScroll: false,
			// No display-relative region capture in cua-driver (its zoom is
			// per-window and pads the region); the tool crops a full capture.
			regionCapture: false,
			uiTree: true,
		})
	}

	/** How many driver processes this adapter has started (a restart after a crash counts). */
	get processStarts(): number {
		return this.client.starts
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const size = structured(await this.callTool('get_screen_size'), 'get_screen_size')
		return {
			width: requireNumber(size, 'width', 'get_screen_size'),
			height: requireNumber(size, 'height', 'get_screen_size'),
			scaleFactor: optionalNumber(size, 'scale_factor') ?? 1,
		}
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot':
				return { type: 'screenshot', result: await this.capture() }
			case 'cursor_position': {
				const point = structured(await this.callTool('get_cursor_position'), 'get_cursor_position')
				return {
					type: 'cursor_position',
					point: {
						x: requireNumber(point, 'x', 'get_cursor_position'),
						y: requireNumber(point, 'y', 'get_cursor_position'),
					},
				}
			}
			case 'mouse_move':
				await this.callTool('move_cursor', {
					scope: 'desktop',
					x: action.to.x,
					y: action.to.y,
				})
				return { type: 'ok' }
			case 'mouse_click':
				return this.pointer('click', {
					scope: 'desktop',
					x: action.at.x,
					y: action.at.y,
					button: action.button,
				})
			case 'mouse_drag':
				return this.pointer('drag', {
					scope: 'desktop',
					from_x: action.from.x,
					from_y: action.from.y,
					to_x: action.to.x,
					to_y: action.to.y,
					button: action.button,
					duration_ms: DRAG.durationMs,
					steps: DRAG.steps,
				})
			case 'scroll': {
				let remaining = Math.max(1, Math.trunc(action.amount))
				let last: ComputerUseResult = { type: 'ok' }
				while (remaining > 0) {
					const ticks = Math.min(remaining, MAX_SCROLL_TICKS)
					last = await this.pointer('scroll', {
						scope: 'desktop',
						x: action.at.x,
						y: action.at.y,
						direction: action.direction,
						amount: ticks,
					})
					remaining -= ticks
				}
				return last
			}
			case 'type_text':
				if (action.text.length === 0) return { type: 'ok' }
				return this.keyboard('type_text', {
					scope: 'desktop',
					text: action.text,
				})
			case 'key': {
				const plan = translateKeyForCuaDriver(action.keys)
				if (plan.tool === 'type_text')
					return this.keyboard('type_text', {
						scope: 'desktop',
						text: plan.text,
					})
				if (plan.tool === 'press_key')
					return this.keyboard('press_key', {
						scope: 'desktop',
						key: plan.key,
					})
				return this.keyboard('hotkey', {
					scope: 'desktop',
					keys: [...plan.keys],
				})
			}
		}
	}

	async listWindows(): Promise<readonly WindowInfo[]> {
		// The model is about to work in a window: have the overlay ready for its first action.
		this.tryPresence((presence) => presence.warm())
		const listed = structured(
			await this.callTool('list_windows', {}, LIST_TIMEOUT_MS),
			'list_windows',
		)
		const windows = toWindowInfos(listed.windows)
		this.windowPids.clear()
		this.windowApps.clear()
		for (const window of windows) {
			this.windowPids.set(window.id, window.pid)
			this.windowApps.set(window.id, window.app)
		}
		return windows
	}

	async focusWindow(id: string): Promise<FocusWindowResult> {
		const hwnd = parseWindowId(id)
		if (hwnd === undefined)
			throw new Error(`computer-use: "${id}" is not a window id from list_windows.`)
		let pid = this.windowPids.get(windowIdOf(hwnd))
		if (pid === undefined) {
			await this.listWindows()
			pid = this.windowPids.get(windowIdOf(hwnd))
		}
		if (pid === undefined) {
			throw new Error(`computer-use: no window ${id} is open now. List the windows again.`)
		}
		// cua-driver restores a minimized window, uses the AttachThreadInput
		// route past Windows' foreground lock, and reads the foreground back.
		const result = structured(
			await this.callTool('bring_to_front', { pid, window_id: hwnd }),
			'bring_to_front',
		)
		const now = parseWindowId(result.now_fg_hwnd)
		const focusedId = now === undefined ? null : windowIdOf(now)
		return { ok: focusedId === windowIdOf(hwnd), focusedId }
	}

	async captureWindow(id: string): Promise<WindowScreenshotResult> {
		return this.serializeWindowOperation(() => this.captureWindowInternal(id))
	}

	private async captureWindowInternal(id: string): Promise<WindowScreenshotResult> {
		const target = await this.resolveWindow(id)
		// A failed or overlapping capture invalidates the old resize ratio even
		// if the driver returned no image. Never let it address a later action.
		this.windowFrame = undefined
		let captureStarts = 0
		let captureGeneration = this.sessionGeneration
		const result = await this.callTool(
			'get_window_state',
			{
				pid: target.pid,
				window_id: target.hwnd,
				include_accessibility_tree: false,
				include_screenshot: true,
			},
			CAPTURE_TIMEOUT_MS,
			undefined,
			(starts) => {
				captureStarts = starts
				captureGeneration = this.sessionGeneration
			},
		)
		const facts = structured(result, 'get_window_state')
		if (facts.pid !== target.pid || parseWindowId(facts.window_id) !== target.hwnd)
			throw new Error(
				'cua-driver: the window capture identity did not match the requested PID and HWND.',
			)
		const image = result.content.find(
			(part): part is { type: 'image'; data: string; mimeType: string } =>
				part.type === 'image' && typeof (part as { data?: unknown }).data === 'string',
		)
		if (!image || image.mimeType !== 'image/png')
			throw new Error(
				`cua-driver: window ${id} returned no PNG${typeof facts.screenshot_error === 'string' ? `: ${facts.screenshot_error}` : ''}.`,
			)
		const data = Buffer.from(image.data, 'base64')
		const { width, height } = decodePngDims(data)
		if (
			width < 1 ||
			height < 1 ||
			facts.screenshot_width !== width ||
			facts.screenshot_height !== height
		)
			throw new Error('cua-driver: window PNG dimensions did not match its capture metadata.')
		const bounds = windowBounds(facts.window_bounds)
		if (!bounds) throw new Error('cua-driver: window capture returned no valid window bounds.')
		const windows = await this.listWindows()
		if (
			captureStarts === 0 ||
			this.client.starts !== captureStarts ||
			this.sessionGeneration !== captureGeneration
		)
			throw new Error(
				'cua-driver: the driver session changed after the window capture; take a new screenshot.',
			)
		const listed = windows.find((window) => window.id === windowIdOf(target.hwnd))
		if (
			!listed ||
			listed.pid !== target.pid ||
			listed.minimized ||
			!sameBounds(listed.bounds, bounds)
		)
			throw new Error(
				`cua-driver: window ${id} moved, closed or was minimized during capture; take a new screenshot.`,
			)
		const frame: WindowCaptureFrame = {
			id: randomUUID(),
			window: listed,
			width,
			height,
			processStarts: captureStarts,
			generation: captureGeneration,
		}
		this.windowFrame = frame
		const coverage = facts.capture_coverage
		const browserChrome =
			typeof coverage === 'object' && coverage !== null && 'browser_chrome' in coverage
				? coverage.browser_chrome
				: undefined
		const captureCoverage =
			typeof browserChrome === 'object' &&
			browserChrome !== null &&
			'status' in browserChrome &&
			typeof browserChrome.status === 'string'
				? browserChrome.status
				: undefined
		return {
			data,
			mimeType: 'image/png',
			width,
			height,
			window: listed,
			captureId: frame.id,
			...(captureCoverage ? { captureCoverage } : {}),
		}
	}

	async executeWindow(
		captureId: string,
		action: WindowInputAction,
	): Promise<WindowInputResult | undefined> {
		return this.serializeWindowOperation(() => this.executeWindowInternal(captureId, action))
	}

	/**
	 * One window input, then a check of what the window shows. The driver
	 * cannot confirm a background input, so one it left unconfirmed is judged
	 * by reading the window before and after (see `observe.ts`).
	 */
	private async executeWindowInternal(
		captureId: string,
		action: WindowInputAction,
	): Promise<WindowInputResult | undefined> {
		const frame = this.windowFrame
		const watched =
			action.type === 'type_text' || action.type === 'key' || action.type === 'mouse_click'
		const hwnd = frame && frame.id === captureId ? parseWindowId(frame.window.id) : undefined
		const target = hwnd !== undefined && frame ? { hwnd, pid: frame.window.pid } : undefined
		const typed =
			action.type === 'type_text'
				? action.text
				: action.type === 'key' && translateKeyForCuaDriver(action.keys).tool === 'type_text'
					? (translateKeyForCuaDriver(action.keys) as { text: string }).text
					: undefined
		// Text for a classic edit control goes by window message: it needs neither focus nor the screen.
		if (
			action.type === 'type_text' &&
			action.text.length > 0 &&
			frame &&
			target &&
			action.delivery_mode !== 'foreground'
		) {
			const byMessage = await this.typeByMessages(frame, action.text)
			if (byMessage) return byMessage
		}
		// A keyboard delivery that asked for the screen is judged by the edit control's own text, where there is one.
		const editBefore =
			typed !== undefined && frame && target && this.foreground
				? await this.foreground.editText({
						hwnd: frame.window.id,
						op: 'get',
						pick: 'focus',
					})
				: undefined
		let before: Observation | undefined
		let earlier: Observation | undefined
		let windows: ReadonlySet<string> | undefined
		if (watched && target) {
			// A press or a key has no text to look for, so it is attributed only if the window was still before it.
			if (typed === undefined) earlier = await this.observe(target)
			before = await this.observe(target)
			if (typed === undefined) windows = await this.windowIdsOf(target.pid)
		}
		const sent = await this.deliverWindowInput(captureId, action)
		if (
			sent?.delivery === 'delivered_unverified' &&
			editBefore?.found &&
			typed !== undefined &&
			frame
		) {
			const editAfter = await this.foreground?.editText({
				hwnd: frame.window.id,
				op: 'get',
				pick: 'focus',
			})
			const edit = editAfter?.found ? judgeEditBetween(typed, editBefore, editAfter) : undefined
			if (edit)
				return {
					delivery: edit.delivery,
					retrySafety: edit.retrySafety,
					detail: edit.detail,
					...(edit.observed !== undefined ? { readBack: { observed: edit.observed } } : {}),
				}
		}
		if (!sent || sent.delivery !== 'delivered_unverified' || !target || !before) return sent
		const seen = await this.verifyByReading(target, {
			typed,
			before,
			earlier,
			windows,
		})
		if (!seen) return sent
		return {
			delivery: seen.delivery,
			retrySafety: seen.retrySafety,
			detail: seen.detail,
			...(seen.observed !== undefined ? { readBack: { observed: seen.observed } } : {}),
		}
	}

	/**
	 * Read the window again until it shows an effect of the input, a few
	 * times with a short wait between (the effect of an input arrives after it
	 * returns), then once more to see that it held still.
	 */
	private async verifyByReading(
		target: { hwnd: number; pid: number },
		reads: {
			typed: string | undefined
			before: Observation
			earlier: Observation | undefined
			/** The program's windows before the input: a new one afterwards (a dialog) is its effect. */
			windows: ReadonlySet<string> | undefined
		},
	): Promise<ObservedVerdict | undefined> {
		for (const wait of OBSERVE_WAITS_MS) {
			if (wait > 0) await this.settle(wait)
			const opened = reads.windows ? await this.newWindowOf(target.pid, reads.windows) : undefined
			if (opened)
				return {
					delivery: 'delivered_verified',
					retrySafety: 'unsafe',
					...(opened.title.trim() !== '' ? { observed: opened.title.trim() } : {}),
					detail: 'A new window of the same program opened after the input.',
				}
			const after = await this.observe(target)
			if (!after) return undefined
			if (sameObservation(reads.before, after)) continue
			const later = reads.typed === undefined ? await this.observe(target) : undefined
			const verdict = judgeObserved(reads.typed !== undefined ? { typed: reads.typed } : {}, {
				before: reads.before,
				after,
				...(later ? { later } : {}),
				...(reads.earlier ? { earlier: reads.earlier } : {}),
			})
			if (verdict) return verdict
		}
		return undefined
	}

	private async windowIdsOf(pid: number): Promise<ReadonlySet<string> | undefined> {
		try {
			return new Set((await this.listWindows()).filter((w) => w.pid === pid).map((w) => w.id))
		} catch {
			return undefined
		}
	}

	private async newWindowOf(
		pid: number,
		known: ReadonlySet<string>,
	): Promise<WindowInfo | undefined> {
		try {
			return (await this.listWindows()).find((w) => w.pid === pid && !known.has(w.id))
		} catch {
			return undefined
		}
	}

	/** A fresh read of a window, as the texts it shows; undefined when the read failed. Refs the model holds are kept pointing at their controls. */
	private async observe(target: { hwnd: number; pid: number }): Promise<Observation | undefined> {
		try {
			const read = await this.readWindowTree(target, {})
			this.bindRead(target, read, { shown: new Set(), regions: new Set() })
			return observationOf(read.tree)
		} catch {
			return undefined
		}
	}

	private async deliverWindowInput(
		captureId: string,
		action: WindowInputAction,
	): Promise<WindowInputResult | undefined> {
		const frame = this.windowFrame
		if (!frame || frame.id !== captureId)
			throw new Error(
				'computer-use: this window screenshot is stale; capture the window again before acting.',
			)
		const point = (value: { x: number; y: number }): void => {
			if (
				!Number.isInteger(value.x) ||
				!Number.isInteger(value.y) ||
				value.x < 0 ||
				value.y < 0 ||
				value.x >= frame.width ||
				value.y >= frame.height
			)
				throw new Error('computer-use: window action coordinates are outside the captured PNG.')
		}
		if (action.type === 'mouse_click' || action.type === 'scroll') point(action.at)
		if (action.type === 'mouse_drag') {
			point(action.from)
			point(action.to)
		}
		const target = {
			scope: 'window',
			pid: frame.window.pid,
			window_id: parseWindowId(frame.window.id),
		} as const
		const call = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
			const windows = await this.listWindows()
			const current = windows.find((window) => window.id === frame.window.id)
			if (
				!current ||
				current.pid !== frame.window.pid ||
				current.minimized ||
				!sameBounds(current.bounds, frame.window.bounds) ||
				this.windowFrame !== frame ||
				this.sessionGeneration !== frame.generation ||
				this.client.starts !== frame.processStarts
			)
				throw new Error(
					'computer-use: the captured window changed or its driver restarted; take a new window screenshot.',
				)
			this.showPresence(frame, current.bounds, name, args)
			return this.callTool(name, { ...target, ...args }, undefined, undefined, undefined, frame)
		}
		// One window input: in the background first. A refusal that foreground
		// delivery can cure (the window cannot take background input, or it is
		// covered) is retried through the ladder; an explicit foreground request
		// goes through it too. The result says which happened.
		const send = async (
			name: string,
			args: Record<string, unknown>,
		): Promise<WindowInputResult> => {
			const subject = {
				app: this.windowApps.get(frame.window.id) ?? frame.window.app,
				pid: frame.window.pid,
				hwnd: frame.window.id,
			}
			const inForeground = async (why: string): Promise<WindowInputResult> => {
				const ladder = this.foreground as ForegroundLadder
				const outcome = await ladder
					.run(this.burstRequest(subject, true), async (burst) => {
						await burst.checkpoint()
						try {
							return inputDelivery(await call(name, { ...args, delivery_mode: 'foreground' }))
						} catch (error) {
							if (isDeliveredPointerAction(error)) return foregroundLostDelivery()
							if (error instanceof McpToolError) return failureDelivery(error)
							throw error
						}
					})
					.catch((error: unknown) => {
						if (error instanceof BurstInterrupted) return error
						throw error
					})
				if (outcome instanceof BurstInterrupted)
					return verdict(
						'not_delivered',
						'safe',
						outcome.reason === 'person'
							? 'a person used the keyboard or mouse just before the input was sent, so nothing was sent. Try again in a moment.'
							: 'an administrator window came to the front just before the input was sent, so nothing was sent. Namzu cannot type into it; try again once it is gone.',
					)
				if (outcome.kind === 'blocked')
					return verdict('not_delivered', 'safe', outcome.block.detail)
				const dropped = droppedInputNote(outcome)
				if (dropped) return verdict('not_delivered', 'safe', dropped)
				const note = interferenceNote(outcome)
				const base = outcome.value
				if (note)
					return verdict(
						base.delivery === 'not_delivered' ? 'not_delivered' : 'delivered_unverified',
						base.delivery === 'not_delivered' ? base.retrySafety : 'unsafe',
						[base.detail, note].filter(Boolean).join(' '),
					)
				return {
					...base,
					detail: [base.detail, why === '' ? undefined : foregroundNote(outcome)]
						.filter(Boolean)
						.join(' '),
				}
			}
			if (args.delivery_mode === 'foreground' && this.foreground) return inForeground('')
			try {
				return inputDelivery(await call(name, args))
			} catch (error) {
				if (error instanceof McpToolError && this.foreground && foregroundCures(error))
					return inForeground('refused')
				throw error
			}
		}
		try {
			switch (action.type) {
				case 'mouse_click':
					try {
						return await send('click', {
							x: action.at.x,
							y: action.at.y,
							button: action.button,
						})
					} catch (error) {
						if (isDeliveredPointerAction(error)) return foregroundLostDelivery()
						throw error
					}
				case 'mouse_drag':
					return await send('drag', {
						from_x: action.from.x,
						from_y: action.from.y,
						to_x: action.to.x,
						to_y: action.to.y,
						button: action.button,
						duration_ms: DRAG.durationMs,
						steps: DRAG.steps,
					})
				case 'scroll':
					throw new Error(
						'computer-use: window pixel scrolling is unavailable on this Windows driver; use foreground PAGE_DOWN or ARROW_DOWN in this window, or take a deliberate display screenshot before display scrolling.',
					)
				case 'type_text': {
					if (action.text.length === 0) return undefined
					return await send('type_text', {
						text: action.text,
						...(action.delivery_mode ? { delivery_mode: action.delivery_mode } : {}),
					})
				}
				case 'key': {
					const plan = translateKeyForCuaDriver(action.keys)
					const delivery = action.delivery_mode ? { delivery_mode: action.delivery_mode } : {}
					if (plan.tool === 'type_text')
						return await send('type_text', { text: plan.text, ...delivery })
					if (plan.tool === 'press_key')
						return await send('press_key', { key: plan.key, ...delivery })
					return await send('hotkey', { keys: [...plan.keys], ...delivery })
				}
			}
		} catch (error) {
			// The driver answered with a refusal or a tool error: it says what it
			// did not do, and that is a typed result, not a crash.
			if (error instanceof McpToolError) return failureDelivery(error)
			throw error
		}
	}

	/**
	 * One window's controls. Without an id, the window in front — which,
	 * for an agent run from a terminal, is usually that terminal.
	 *
	 * A window with many controls comes back as an outline: the top levels,
	 * with each unexpanded region marked by how many children it hides and
	 * given a ref. `options.root` opens one such region; refs outside it stay
	 * valid. `options.query` keeps only the controls whose text matches.
	 */
	async uiSnapshot(requested?: string, options: UiSnapshotOptions = {}): Promise<UiSnapshot> {
		let windowId = requested
		let rootEntry: UiRefEntry | undefined
		if (options.root !== undefined) {
			rootEntry = this.uiRefs.get(options.root)
			if (!rootEntry)
				throw new Error(
					`STALE_REF: ${options.root} is not a region or control this session was shown. Take a ui_snapshot of the window and use a ref from it.`,
				)
			const own = windowIdOf(rootEntry.hwnd)
			if (windowId !== undefined && parseWindowId(windowId) !== rootEntry.hwnd)
				throw new Error(
					`${options.root} belongs to window ${own}, not ${windowId}. Pass the window it came from, or leave window_id out.`,
				)
			windowId = own
		}
		const target = await this.resolveWindow(windowId)
		if (rootEntry && rootEntry.pid !== target.pid)
			throw new Error(
				`STALE_REF: window ${windowIdOf(target.hwnd)} now belongs to a different program than ${options.root} was read from. Take a new ui_snapshot.`,
			)
		const query = options.query?.trim() ? options.query.trim() : undefined
		let read = await this.readWindowTree(target, { query })
		const state0 = read.state
		const app0 = typeof state0.app_name === 'string' ? state0.app_name : ''
		// A browser builds its page tree when it is first asked: the first walk can
		// show only the window frame. One more walk shows the page.
		if (!query && !rootEntry && BROWSER_APP.test(app0) && read.tree.count < SPARSE_TREE)
			read = await this.readWindowTree(target, { query })
		const { state, tree } = read

		let located: UiNode | undefined
		if (rootEntry) {
			const found = locate(rootEntry, tree, { actionable: !rootEntry.region })
			if (found.kind === 'ambiguous')
				throw new Error(
					`AMBIGUOUS_TARGET: ${fitText(found.count)} ${options.root} (${describeEvidence(rootEntry)}). Take a ui_snapshot of the whole window and pick the region from it.`,
				)
			if (found.kind === 'gone')
				throw new Error(
					`STALE_REF: ${options.root} (${describeEvidence(rootEntry)}) is no longer in the window. Take a ui_snapshot of the whole window.`,
				)
			located = found.node
		}
		const viewRoot = located?.element ?? tree.root
		const basePath = located?.path ?? []
		const view =
			!query && visibleCount(viewRoot) > OUTLINE_THRESHOLD
				? outlineOf(
						viewRoot,
						basePath,
						OUTLINE_BUDGET,
						located ? { offset: options.offset ?? 0 } : undefined,
					)
				: { root: viewRoot, regions: new Set<string>(), next: undefined }
		const shownKeys = new Set<string>()
		collectShown(view.root, basePath, shownKeys)
		const refs = this.bindRead(target, read, {
			shown: shownKeys,
			regions: view.regions,
			partial: query !== undefined,
		})
		const refAt = (path: readonly number[]): string => refs.get(pathKey(path)) ?? ''
		const root = withRefs(view.root, basePath, refAt)

		const title = typeof state.window_title === 'string' ? state.window_title : undefined
		const app =
			typeof state.app_name === 'string' ? state.app_name.replace(/\.exe$/i, '') : undefined
		return {
			windowId: windowIdOf(target.hwnd),
			...(title !== undefined ? { title } : {}),
			...(app !== undefined ? { app } : {}),
			root,
			...(state.truncated === true || tree.count >= UI_WALK_CUT_AT ? { truncated: true } : {}),
			...(view.regions.size > 0 ? { outline: true } : {}),
			total: tree.count,
			...(rootEntry ? { region: true } : {}),
			...(view.next !== undefined ? { next: view.next } : {}),
		}
	}

	/** One `get_window_state` walk, with the process and session it was read from. */
	private async readWindowTree(
		target: { hwnd: number; pid: number },
		options: { query?: string | undefined } = {},
	): Promise<{
		state: Record<string, unknown>
		tree: ParsedUiTree
		processStarts: number
		generation: number
	}> {
		let processStarts = 0
		let generation = this.sessionGeneration
		const state = structured(
			await this.callTool(
				'get_window_state',
				{
					pid: target.pid,
					window_id: target.hwnd,
					include_screenshot: false,
					max_elements: UI_MAX_ELEMENTS,
					...(options.query ? { query: options.query } : {}),
				},
				UI_TREE_TIMEOUT_MS,
				undefined,
				(starts) => {
					processStarts = starts
					generation = this.sessionGeneration
				},
			),
			'get_window_state',
		)
		if (generation !== this.sessionGeneration || processStarts === 0)
			throw new McpToolError('get_window_state', 'stale UI snapshot; take a new one')
		if (typeof state.pid === 'number' && state.pid !== target.pid)
			throw new McpToolError('get_window_state', 'window changed owner; take a new UI snapshot')
		return { state, tree: toUiTree(state), processStarts, generation }
	}

	/**
	 * Record a read of a window: every ref the model already holds for it is
	 * pointed at the control it named in this read (found by its evidence),
	 * and the controls the model is being shown, and the regions it can open,
	 * get refs. A ref whose control is not found keeps its old, now dead,
	 * read, so using it re-resolves and reports why. Returns ref by path.
	 */
	private bindRead(
		target: { hwnd: number; pid: number },
		read: { tree: ParsedUiTree; processStarts: number; generation: number },
		scope: {
			shown: ReadonlySet<string>
			regions: ReadonlySet<string>
			/** A filtered (query) read: its places are not the window's, so it records no places. */
			partial?: boolean
		},
	): Map<string, string> {
		const seq = ++this.nextRead
		const at = this.now()
		this.windowReads.set(target.hwnd, { seq, at })
		const byPath = new Map<string, string>()
		const claimed = new Set<string>()
		const named = new Map<string, number>()
		for (const node of read.tree.nodes) {
			const key = `${node.role}\u0000${node.name.trim()}`
			named.set(key, (named.get(key) ?? 0) + 1)
		}
		const bound = (node: UiNode, entry: UiRefEntry, ref: string): void => {
			const key = pathKey(node.path)
			claimed.add(key)
			byPath.set(key, ref)
			const twin =
				node.automationId === undefined &&
				node.name.trim() !== '' &&
				(named.get(`${node.role}\u0000${node.name.trim()}`) ?? 0) > 1
			this.uiRefs.set(ref, {
				...(node.facts ?? factsOfNode(node)),
				twin,
				...(scope.partial
					? {}
					: {
							childCount: node.element.children?.length ?? 0,
							treeSig: read.tree.signature,
						}),
				token: node.token,
				pid: target.pid,
				hwnd: target.hwnd,
				region: entry.region,
				...(node.element.bounds ? { bounds: node.element.bounds } : {}),
				generation: read.generation,
				processStarts: read.processStarts,
				readSeq: seq,
				readAt: at,
			})
		}
		// A filtered read has other places than the window; it only adds refs.
		// A handle another program reuses is not the window the ref came from.
		if (!scope.partial) {
			for (const [ref, entry] of [...this.uiRefs]) {
				if (entry.hwnd !== target.hwnd || entry.pid !== target.pid) continue
				const found = locate(entry, read.tree, { actionable: !entry.region })
				if (found.kind !== 'found' || claimed.has(pathKey(found.node.path))) continue
				bound(found.node, entry, ref)
			}
		}
		let created = 0
		for (const node of read.tree.nodes) {
			const key = pathKey(node.path)
			if (claimed.has(key)) continue
			const region = scope.regions.has(key)
			const actionable = node.token !== '' && scope.shown.has(key)
			if (!region && !actionable) continue
			// A match set larger than the ref budget would evict its own refs.
			if (created >= NEW_REFS_PER_READ) break
			created++
			const ref = `cua-ui:${this.uiRefNamespace}:${++this.nextRef}`
			const entry = { region: !actionable } as UiRefEntry
			bound(node, entry, ref)
		}
		this.trimRefs(seq)
		return byPath
	}

	/** The model holds only so many refs; the oldest reads go first. */
	private trimRefs(keepSeq: number): void {
		if (this.uiRefs.size <= MAX_REFS) return
		// The read that just answered keeps every ref it handed out.
		const oldest = [...this.uiRefs]
			.filter(([, entry]) => entry.readSeq !== keepSeq)
			.sort((a, b) => a[1].readSeq - b[1].readSeq)
		for (const [ref] of oldest.slice(0, this.uiRefs.size - MAX_REFS)) this.uiRefs.delete(ref)
	}

	/**
	 * The ref's control as it is now: the entry itself when it was read
	 * recently in the window's latest read, else found again in a fresh read
	 * by its evidence (id, then place, then role and name). Never a guess:
	 * several fits is AMBIGUOUS_TARGET, none is STALE_REF, and nothing has been
	 * sent in either case.
	 */
	private async resolveRef(
		ref: string,
		entry: UiRefEntry,
	): Promise<{ entry: UiRefEntry } | { fail: UiActResult }> {
		const latest = this.windowReads.get(entry.hwnd)
		if (
			latest &&
			entry.readSeq === latest.seq &&
			entry.generation === this.sessionGeneration &&
			this.now() - entry.readAt <= IDENTITY_FRESH_MS
		)
			return { entry }
		const target = { hwnd: entry.hwnd, pid: entry.pid }
		let read: Awaited<ReturnType<CuaDriverAdapter['readWindowTree']>>
		try {
			read = await this.readWindowTree(target, {})
		} catch (error) {
			const gone = await this.windowIsGone(entry)
			if (gone)
				return {
					fail: refFailure(
						'STALE_REF',
						`the window of ${describeEvidence(entry)} is closed. Nothing was sent. List the windows again.`,
					),
				}
			return {
				fail: {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: `the window could not be read to confirm ${describeEvidence(entry)} is still there, so nothing was sent${error instanceof Error ? ` (${trimText(error.message, 160)})` : ''}. Try again.`,
				},
			}
		}
		const found = locate(entry, read.tree, { actionable: true })
		this.bindRead(target, read, { shown: new Set(), regions: new Set() })
		const next = this.uiRefs.get(ref)
		if (found.kind === 'found' && next && next.readSeq === this.windowReads.get(entry.hwnd)?.seq)
			return { entry: next }
		if (found.kind === 'ambiguous' || found.kind === 'found')
			return {
				fail: refFailure(
					'AMBIGUOUS_TARGET',
					`${found.kind === 'ambiguous' ? fitText(found.count) : 'several controls fit'} ${describeEvidence(entry)}, so nothing was sent. Take a ui_snapshot and use the ref of the one you mean.`,
				),
			}
		return {
			fail: refFailure(
				'STALE_REF',
				`${describeEvidence(entry)} is no longer in the window, or can no longer be acted on. Nothing was sent. Take a ui_snapshot and choose from what it shows.`,
			),
		}
	}

	/** Whether the ref's window has closed (or changed owner). Costs a window list, so only asked after a failure. */
	private async windowIsGone(entry: UiRefEntry): Promise<boolean> {
		try {
			const windows = await this.listWindows()
			const id = windowIdOf(entry.hwnd)
			const found = windows.find((window) => window.id === id)
			return !found || found.pid !== entry.pid
		} catch {
			return false
		}
	}

	async uiAct(ref: string, action: UiElementAction, value?: string): Promise<UiActResult> {
		return this.actOn(ref, action, value, true)
	}

	private async actOn(
		ref: string,
		action: UiElementAction,
		value: string | undefined,
		retry: boolean,
	): Promise<UiActResult> {
		const held = this.uiRefs.get(ref)
		if (!held)
			return refFailure(
				'STALE_REF',
				`${ref} is not a control this session was shown, so nothing was sent. Take a ui_snapshot and use a ref from it.`,
			)
		if (held.region)
			return {
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: `${ref} is a region of the window (${describeEvidence(held)}), not a control, so nothing was sent. Read it with ui_snapshot {root: ${ref}} and act on a control inside it.`,
			}
		const resolved = await this.resolveRef(ref, held)
		if ('fail' in resolved) return resolved.fail
		const facts = resolved.entry
		const { pid, token } = facts
		const uiRef = { ref, facts }
		this.tryPresence((presence) =>
			presence.mark({
				hwnd: facts.hwnd,
				kind: action === 'set_value' ? 'type' : 'click',
				...(facts.bounds
					? {
							at: {
								x: facts.bounds.x + facts.bounds.width / 2,
								y: facts.bounds.y + facts.bounds.height / 2,
							},
						}
					: {}),
			}),
		)
		try {
			switch (action) {
				case 'invoke':
				case 'expand':
				case 'collapse':
					// cua-driver's click on an element token performs the control's
					// own pattern in the background (Invoke, or a posted click at its
					// centre), with no pointer move and no change of foreground.
					return await this.clickAndWatch(facts, uiRef)
				case 'select': {
					// A row that can also be invoked is selected by its selection pattern: the driver's click on it invokes, and a file row would open.
					if (ITEM_ROLES.test(facts.role) && facts.actions.includes('invoke'))
						return await this.selectWithoutOpening(facts)
					const sent = await this.clickRef(facts, uiRef)
					if (!sent.ok) return sent
					return judgeSelect(facts, await this.readBack(facts))
				}
				case 'toggle': {
					const sent = await this.clickRef(facts, uiRef)
					if (!sent.ok) return sent
					const back = await this.readBack(facts)
					return judgeToggle(facts, back)
				}
				case 'set_value': {
					const text = value ?? ''
					let sent: UiActResult
					try {
						sent = actResult(
							await this.callTool(
								'set_value',
								{ pid, element_token: token, value: text },
								undefined,
								uiRef,
							),
						)
					} catch (error) {
						if (
							error instanceof McpToolError &&
							/does not implement ValuePattern/i.test(error.message)
						) {
							// A classic edit control takes its text by window message, never by focus or keys.
							const edited = await this.setByMessages(facts, text)
							if (edited) return edited
							// Typing instead would equal setting only while the field is
							// empty, and the driver's own report of it is not trustworthy.
							return {
								ok: false,
								delivery: 'not_delivered',
								retrySafety: 'safe',
								detail:
									'this field has no settable value, and nothing was typed. A classic edit control takes text through the keyboard: click it in a window screenshot, then type_text (add delivery_mode:"foreground" when background typing is not delivered).',
							}
						}
						throw error
					}
					if (!sent.ok) return sent
					const judged = judgeSetValue(facts, text, await this.readBack(facts))
					// A choice in a list that ignored the driver is made with the keyboard, in the foreground.
					if (judged.delivery === 'not_delivered' && CHOICE_ROLES.test(facts.role))
						return await this.chooseByKeyboard(ref, facts, text, judged)
					return judged
				}
				case 'focus':
				case 'scroll_into_view':
					return {
						ok: false,
						delivery: 'not_delivered',
						retrySafety: 'safe',
						detail: `this host cannot ${action === 'focus' ? 'focus' : 'scroll to'} a control by itself; invoke it or click it instead`,
					}
			}
		} catch (error) {
			if (error instanceof McpToolError && isStaleHandle(error)) {
				// The driver refused before acting: a newer read of the window replaced
				// the handle. Read again and find the control by what it is, once.
				this.windowReads.delete(facts.hwnd)
				if (retry) return this.actOn(ref, action, value, false)
				return refFailure(
					'STALE_REF',
					`${describeEvidence(facts)} changed while it was being acted on. Nothing was sent. Take a ui_snapshot and try again.`,
				)
			}
			if (error instanceof McpToolError) return failureResult(error)
			throw error
		}
	}

	/**
	 * Choose an option by the keyboard, for a list the driver's value call did
	 * not change (a web page's select element ignores it in the background).
	 * One foreground burst focuses the control, types the option and confirms
	 * it; the control is then read back. Where that does not work either, the
	 * model is told which route to use instead.
	 */
	private async chooseByKeyboard(
		ref: string,
		stale: UiRefEntry,
		option: string,
		unchanged: UiActResult,
	): Promise<UiActResult> {
		const ladder = this.foreground
		const instead =
			'The driver and the keyboard could not change this list. If this is a web page, use the browser tool for it; otherwise choose the option in a window screenshot with the pointer.'
		if (!ladder) return unchanged
		// The read-back that judged the value replaced the driver's handle: click through the new one.
		const facts = this.uiRefs.get(ref) ?? stale
		const uiRef = { ref, facts }
		const { pid } = facts
		const hwnd = windowIdOf(facts.hwnd)
		const subject = {
			app: this.windowApps.get(hwnd) ?? `process ${pid}`,
			pid,
			hwnd,
		}
		const scope = {
			scope: 'window',
			pid,
			window_id: facts.hwnd,
			delivery_mode: 'foreground',
		}
		const outcome = await ladder
			.run(this.burstRequest(subject, true), async (burst) => {
				await burst.checkpoint()
				try {
					await this.callTool(
						'click',
						{ pid, element_token: facts.token, delivery_mode: 'foreground' },
						undefined,
						uiRef,
					)
					await burst.checkpoint()
					await this.callTool('type_text', { ...scope, text: option })
					await burst.checkpoint()
					await this.callTool('press_key', { ...scope, key: 'return' })
					return undefined
				} catch (error) {
					if (error instanceof McpToolError) return failureResult(error)
					throw error
				}
			})
			.catch((error: unknown) => {
				if (error instanceof BurstInterrupted) return error
				throw error
			})
		if (outcome instanceof BurstInterrupted)
			return {
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail:
					outcome.reason === 'person'
						? 'a person used the keyboard or mouse just before the choice was made, so it may not have been. Try again in a moment.'
						: 'an administrator window came to the front just before the choice was made; Namzu cannot type into it. Try again once it is gone.',
			}
		if (outcome.kind === 'blocked')
			return {
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: `${outcome.block.detail} ${instead}`,
			}
		const dropped = droppedInputNote(outcome)
		if (dropped)
			return {
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: `${dropped} ${instead}`,
			}
		const note = interferenceNote(outcome)
		if (outcome.value && !outcome.value.ok) return outcome.value
		const judged = judgeSetValue(facts, option, await this.readBack(facts))
		if (note)
			return {
				...judged,
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail: note,
			}
		if (judged.delivery === 'delivered_verified')
			return { ...judged, detail: foregroundNote(outcome) }
		return { ...judged, detail: `${judged.detail ?? ''} ${instead}`.trim() }
	}

	/**
	 * Select a list or tree row that can also be invoked, through its selection
	 * pattern, so that a file row is chosen and not opened. Where that cannot be
	 * reached nothing is sent: the click that is left would open the item.
	 */
	private async selectWithoutOpening(facts: UiRefEntry): Promise<UiActResult> {
		const result = await this.foreground?.selectItem({
			hwnd: windowIdOf(facts.hwnd),
			role: facts.role,
			name: facts.name,
			...(facts.automationId ? { automationId: facts.automationId } : {}),
			...(facts.bounds ? { bounds: facts.bounds } : {}),
		})
		if (!result?.found) {
			const why = result
				? (SELECT_REFUSALS[result.reason] ?? 'the row could not be selected')
				: 'this host cannot select a row without opening it'
			return {
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: `${why}, and nothing was sent. Clicking the row would open it; use invoke to open it, or take a new ui_snapshot and try again.`,
			}
		}
		const back = await this.readBack(facts)
		if (back?.selected === true || (back === undefined && result.selected))
			return {
				ok: true,
				delivery: 'delivered_verified',
				retrySafety: 'unsafe',
				readBack: { expected: 'selected', observed: 'selected' },
				detail: 'The row is selected; it was not opened.',
			}
		return {
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			readBack: { expected: 'selected', observed: 'not selected' },
			detail: 'the row was selected by its selection pattern, but it does not read as selected.',
		}
	}

	/** Replace a classic edit control's text by window message; undefined where the control is not one this reaches. */
	private async setByMessages(facts: UiRefEntry, text: string): Promise<UiActResult | undefined> {
		const ladder = this.foreground
		if (!ladder) return undefined
		const result = await ladder.editText({
			hwnd: windowIdOf(facts.hwnd),
			op: 'set',
			text,
			pick: 'bounds',
			...(facts.bounds
				? {
						at: {
							x: facts.bounds.x + facts.bounds.width / 2,
							y: facts.bounds.y + facts.bounds.height / 2,
						},
					}
				: {}),
		})
		if (!result) return undefined
		if (!result.found) {
			if (result.reason === 'uipi' || result.reason === 'gone')
				return { ...judgeEdit('set', text, result), ok: false }
			return undefined
		}
		return judgeEdit('set', text, result)
	}

	/** Type into the window's focused classic edit control by window message; undefined where there is none. */
	private async typeByMessages(
		frame: WindowCaptureFrame,
		text: string,
	): Promise<WindowInputResult | undefined> {
		const ladder = this.foreground
		if (!ladder) return undefined
		const result = await ladder.editText({
			hwnd: frame.window.id,
			op: 'type',
			text,
			pick: 'focus',
		})
		if (!result) return undefined
		if (!result.found) {
			if (result.reason !== 'uipi') return undefined
			return judgeEdit('type', text, result)
		}
		this.showPresence(frame, frame.window.bounds, 'type_text', {})
		const { ok: _ok, ...verdict } = judgeEdit('type', text, result)
		return verdict
	}

	/**
	 * A click on a control that the control's own state does not answer for
	 * (a button): when the driver cannot confirm it, the window is read before
	 * and after, and the click is verified by what it changed.
	 */
	private async clickAndWatch(
		facts: UiRefEntry,
		uiRef: { readonly ref: string; readonly facts: UiRefEntry },
	): Promise<UiActResult> {
		const target = { hwnd: facts.hwnd, pid: facts.pid }
		const earlier = await this.observe(target)
		const before = await this.observe(target)
		const windows = await this.windowIdsOf(target.pid)
		// Each read of the window replaces the driver's handles: click through the refreshed one.
		const current = this.uiRefs.get(uiRef.ref) ?? facts
		const sent = await this.clickRef(current, {
			ref: uiRef.ref,
			facts: current,
		})
		if (!sent.ok || sent.delivery !== 'delivered_unverified' || !before) return sent
		const seen = await this.verifyByReading(target, {
			typed: undefined,
			before,
			earlier,
			windows,
		})
		if (!seen) return sent
		return {
			ok: true,
			delivery: seen.delivery,
			retrySafety: seen.retrySafety,
			detail: seen.detail,
			...(seen.observed !== undefined ? { readBack: { observed: seen.observed } } : {}),
		}
	}

	/**
	 * A click on a control by its driver token, in the background. Where the
	 * driver says the window cannot take background input (or is covered) the
	 * same click is retried in the foreground through the ladder.
	 */
	private async clickRef(
		facts: UiRefEntry,
		uiRef: { readonly ref: string; readonly facts: UiRefEntry },
	): Promise<UiActResult> {
		const { pid, token } = facts
		try {
			return actResult(
				await this.callTool('click', { pid, element_token: token }, undefined, uiRef),
			)
		} catch (error) {
			const ladder = this.foreground
			if (!(error instanceof McpToolError) || !ladder || !foregroundCures(error)) throw error
			const subject = {
				app: this.windowApps.get(windowIdOf(facts.hwnd)) ?? `process ${pid}`,
				pid,
				hwnd: windowIdOf(facts.hwnd),
			}
			const outcome = await ladder
				.run(this.burstRequest(subject, true), async (burst) => {
					await burst.checkpoint()
					try {
						return actResult(
							await this.callTool(
								'click',
								{ pid, element_token: token, delivery_mode: 'foreground' },
								undefined,
								uiRef,
							),
						)
					} catch (inner) {
						if (inner instanceof McpToolError) return failureResult(inner)
						throw inner
					}
				})
				.catch((inner: unknown) => {
					if (inner instanceof BurstInterrupted) return inner
					throw inner
				})
			if (outcome instanceof BurstInterrupted)
				return {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail:
						outcome.reason === 'person'
							? 'a person used the keyboard or mouse just before the click was sent, so nothing was sent. Try again in a moment.'
							: 'an administrator window came to the front just before the click was sent, so nothing was sent. Namzu cannot type into it; try again once it is gone.',
				}
			if (outcome.kind === 'blocked')
				return {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: outcome.block.detail,
				}
			const dropped = droppedInputNote(outcome)
			if (dropped)
				return {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: dropped,
				}
			const note = interferenceNote(outcome)
			const base = outcome.value
			const detail = [base.detail, note ?? foregroundNote(outcome)].filter(Boolean).join(' ')
			if (note && base.delivery !== 'not_delivered')
				return {
					...base,
					delivery: 'delivered_unverified',
					retrySafety: 'unsafe',
					detail,
				}
			return { ...base, detail }
		}
	}

	/**
	 * The control as a fresh read of its window shows it, or undefined when
	 * that read failed or the control is gone. A failed read says nothing
	 * about the action, so callers treat undefined as "unverified".
	 */
	private async readBack(facts: UiRefEntry): Promise<UiRefFacts | undefined> {
		try {
			const target = { hwnd: facts.hwnd, pid: facts.pid }
			const read = await this.readWindowTree(target, {})
			const found = locate(facts, read.tree, { actionable: true })
			this.bindRead(target, read, { shown: new Set(), regions: new Set() })
			return found.kind === 'found' ? found.node.facts : undefined
		} catch {
			return undefined
		}
	}

	async dispose(): Promise<void> {
		await this.client.dispose()
	}

	/** Tells the overlay where the agent is about to act in a window; never waits and never fails the action. */
	private showPresence(
		frame: WindowCaptureFrame,
		bounds: WindowInfo['bounds'],
		tool: string,
		args: Record<string, unknown>,
	): void {
		const presence = this.presence
		if (!presence) return
		const hwnd = parseWindowId(frame.window.id)
		if (hwnd === undefined) return
		const scale = frame.width > 0 ? bounds.width / frame.width : 1
		const screen = (x: unknown, y: unknown): { x: number; y: number } | undefined =>
			typeof x === 'number' && typeof y === 'number'
				? { x: bounds.x + x * scale, y: bounds.y + y * scale }
				: undefined
		const at = screen(args.x ?? args.to_x, args.y ?? args.to_y)
		const typing = tool === 'type_text' || tool === 'press_key' || tool === 'hotkey'
		this.tryPresence((overlay) =>
			overlay.mark({
				hwnd,
				kind: typing ? 'type' : 'click',
				...(at && !typing ? { at } : {}),
			}),
		)
	}

	/** The overlay is decoration: whatever it does, the action goes on. */
	private tryPresence(use: (presence: Presence) => void): void {
		if (!this.presence || this.driverCursorOff === false) return
		try {
			use(this.presence)
		} catch {
			// Nothing is shown; nothing else changes.
		}
	}

	private async serializeWindowOperation<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.windowOperation
		let release: () => void = () => undefined
		this.windowOperation = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}

	/**
	 * cua-driver refuses an expired implicit session before dispatch, with a
	 * structured `session_ended` code. Only that exact refusal is safe to replay.
	 * A lost response or transport failure still has an unknown action outcome.
	 */
	private async callTool(
		name: string,
		args: Record<string, unknown> = {},
		timeoutMs?: number,
		uiRef?: { readonly ref: string; readonly facts: UiRefEntry },
		onProcess?: McpProcessCallOptions['onProcess'],
		windowFrame?: WindowCaptureFrame,
	): Promise<McpToolResult> {
		await this.sessionRevival
		if (
			windowFrame &&
			(this.windowFrame !== windowFrame ||
				windowFrame.generation !== this.sessionGeneration ||
				windowFrame.processStarts !== this.client.starts)
		)
			throw new McpToolError(name, 'stale window screenshot; capture the window again')
		if (
			uiRef &&
			(this.uiRefs.get(uiRef.ref) !== uiRef.facts ||
				uiRef.facts.generation !== this.sessionGeneration ||
				this.windowReads.get(uiRef.facts.hwnd)?.seq !== uiRef.facts.readSeq)
		)
			throw new McpToolError(name, 'stale UI snapshot; take a new one')
		const generation = this.sessionGeneration
		const signal = currentCallSignal()
		const changes = changesDesktop(name)
		try {
			const result = await this.client.callTool(name, args, timeoutMs, {
				...(signal ? { signal } : {}),
				...(uiRef || windowFrame
					? {
							expectedStarts: uiRef?.facts.processStarts ?? windowFrame?.processStarts,
						}
					: {}),
				...(onProcess ? { onProcess } : {}),
			})
			if (changes) markSent()
			return result
		} catch (error) {
			if (error instanceof CallAbortedError && error.sent && changes) markSent()
			if (!isEndedSessionRefusal(error)) throw error
			// The refusal proves the old session's element tokens are invalid,
			// even if start_session fails and there is no successful revival.
			if (this.sessionGeneration === generation) this.windowReads.clear()
			this.windowFrame = undefined
			await this.reviveSession(generation)
			// Element tokens belong to the old snapshot. A new lifecycle session
			// needs a new tree before a control can be addressed again.
			if (uiRef) throw new McpToolError(name, 'stale UI snapshot; take a new one')
			if (windowFrame)
				throw new McpToolError(name, 'stale window screenshot; capture the window again')
			// One retry only. A second refusal or an unacknowledged action is
			// returned to the host without any further automatic replay.
			const retried = await this.client.callTool(name, args, timeoutMs, {
				...(signal ? { signal } : {}),
				...(onProcess ? { onProcess } : {}),
			})
			if (changes) markSent()
			return retried
		}
	}

	/**
	 * What a foreground burst asks of the ladder: the call's cancellation, and
	 * the wait for calls a cancelled burst left in flight before the window and
	 * cursor are put back.
	 */
	private burstRequest(subject: ForegroundSubject, sendsInput: boolean): LadderRequest {
		const signal = currentCallSignal()
		return {
			subject,
			sendsInput,
			...(signal ? { signal } : {}),
			settle: () => this.client.settled(),
		}
	}

	private async reviveSession(generation: number): Promise<void> {
		if (this.sessionGeneration !== generation) return
		if (!this.sessionRevival) {
			this.sessionRevival = (async () => {
				await this.client.callTool('start_session')
				this.driverCursorOff = await disableAgentCursor((name, args) =>
					this.client.callTool(name, args),
				)
				this.windowReads.clear()
				this.windowFrame = undefined
				this.sessionGeneration++
			})().finally(() => {
				this.sessionRevival = undefined
			})
		}
		await this.sessionRevival
	}

	/** A window id (or the window in front) → its handle and owning process. */
	private async resolveWindow(
		windowId: string | undefined,
	): Promise<{ hwnd: number; pid: number }> {
		if (windowId === undefined) {
			const front = (await this.listWindows()).find((window) => window.focused)
			if (!front)
				throw new Error('computer-use: no window is in front; pass a window id from list_windows.')
			return { hwnd: parseWindowId(front.id) as number, pid: front.pid }
		}
		const hwnd = parseWindowId(windowId)
		if (hwnd === undefined)
			throw new Error(`computer-use: "${windowId}" is not a window id from list_windows.`)
		let pid = this.windowPids.get(windowIdOf(hwnd))
		if (pid === undefined) {
			await this.listWindows()
			pid = this.windowPids.get(windowIdOf(hwnd))
		}
		if (pid === undefined)
			throw new Error(`computer-use: no window ${windowId} is open now. List the windows again.`)
		return { hwnd, pid }
	}

	/**
	 * A display pointer action. A click that ends with another window in front
	 * is reported as sent but unverified: it may have closed its own window,
	 * or it may have missed. Neither is "done".
	 */
	private async pointer(tool: string, args: Record<string, unknown>): Promise<ComputerUseResult> {
		try {
			return okResult(inputDelivery(await this.callTool(tool, args)))
		} catch (error) {
			if (isDeliveredPointerAction(error)) return okResult(foregroundLostDelivery())
			throw error
		}
	}

	private async keyboard(tool: string, args: Record<string, unknown>): Promise<ComputerUseResult> {
		return okResult(inputDelivery(await this.callTool(tool, args)))
	}

	private async capture(): Promise<ScreenshotResult> {
		const result = await this.callTool('get_desktop_state', {}, CAPTURE_TIMEOUT_MS)
		const image = result.content.find(
			(part): part is { type: 'image'; data: string; mimeType: string } =>
				part.type === 'image' && typeof (part as { data?: unknown }).data === 'string',
		)
		if (!image) throw new Error('cua-driver: get_desktop_state returned no image.')
		const data = Buffer.from(image.data, 'base64')
		const { width, height } = decodePngDims(data)
		const facts = result.structuredContent ?? {}
		const screenWidth = optionalNumber(facts, 'screen_width') ?? width
		const screenHeight = optionalNumber(facts, 'screen_height') ?? height
		if (width !== screenWidth || height !== screenHeight) {
			// The host contract is physical pixels; a scaled capture would put
			// every click somewhere else.
			throw new Error(
				`cua-driver: the capture is ${width}x${height} but the display is ${screenWidth}x${screenHeight}; refusing a scaled screenshot.`,
			)
		}
		const display: DisplayInfo = {
			id: typeof facts.display === 'string' ? facts.display : 'primary',
			x: 0,
			y: 0,
			width: screenWidth,
			height: screenHeight,
			scaleFactor: optionalNumber(facts, 'scale_factor') ?? 1,
			primary: true,
		}
		return { data, mimeType: 'image/png', width, height, display }
	}
}

/** This cua-driver refusal is emitted before a tool reaches desktop dispatch. */
function isEndedSessionRefusal(error: unknown): error is McpToolError {
	if (!(error instanceof McpToolError) || error.structuredContent?.status !== 'refused')
		return false
	const refusal = error.structuredContent.refusal
	return (
		typeof refusal === 'object' &&
		refusal !== null &&
		'code' in refusal &&
		refusal.code === 'session_ended'
	)
}

/**
 * cua-driver activates the window under a desktop click, clicks, and then
 * checks that the window — or another of its process — is still in front. A
 * click that closes its own window (a dialog's "Don't Save", a close button)
 * or starts another program leaves someone else in front, and the check
 * fails although the click happened: "…was not foreground after the click".
 * Reporting that as a failure would invite the model to click again, so it
 * counts as done. The refusals that come before any input say "no input was
 * sent" / "no mouse input was sent" and stay failures.
 */
export function isDeliveredPointerAction(error: unknown): boolean {
	return (
		error instanceof McpToolError &&
		/foreground_unavailable/.test(error.message) &&
		/not foreground after the/.test(error.message) &&
		!/no (mouse )?input was sent/.test(error.message)
	)
}

const trimText = (value: string, max = 80): string =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value

/** A delivery verdict with the retry advice that goes with it. */
function verdict(
	delivery: ActionDelivery,
	retrySafety: ActionRetrySafety,
	detail?: string,
): WindowInputResult {
	return { delivery, retrySafety, ...(detail !== undefined ? { detail } : {}) }
}

/** `ok` with a delivery verdict: a call that returned is never proof that the effect happened. */
function okResult(input: WindowInputResult): ComputerUseResult {
	return { type: 'ok', ...input }
}

/** The click was sent, but the window it targeted is no longer in front afterwards. */
function foregroundLostDelivery(): WindowInputResult {
	return verdict(
		'delivered_unverified',
		'unsafe',
		'the click was sent, but another window was in front afterwards. It may have closed its own window or started another program, or it may have missed. Look at the screen before clicking again.',
	)
}

/**
 * What a driver tool call that returned says about the input it sent.
 *
 * The driver reports `effect: "unverifiable"` for nearly every background
 * action, including ones that did nothing, and its `delivery_failed`
 * escalation shows up on input that arrived as well as input that did not.
 * Neither is proof, so only a `confirmed` effect is verified, and anything
 * else says "sent, not confirmed".
 */
export function inputDelivery(result: McpToolResult): WindowInputResult {
	const facts = result.structuredContent ?? {}
	switch (facts.effect) {
		case 'refused': {
			const refusal = facts.refusal as { message?: unknown } | undefined
			return verdict(
				'not_delivered',
				'safe',
				typeof refusal?.message === 'string' ? refusal.message : 'cua-driver refused the action',
			)
		}
		case 'confirmed':
			return verdict('delivered_verified', 'unsafe')
		case 'suspected_noop':
			return verdict(
				'delivered_unverified',
				'unsafe',
				'the driver suspects the input changed nothing; it may not have reached the target. Look at the window before repeating it.',
			)
		default: {
			const escalation = facts.escalation as { reason?: unknown } | undefined
			return verdict(
				'delivered_unverified',
				'unsafe',
				escalation?.reason === 'delivery_failed'
					? 'the driver could not confirm that the input arrived. It may have; check the window before repeating it, and if nothing changed send it again with delivery_mode:"foreground".'
					: undefined,
			)
		}
	}
}

/**
 * A driver tool error → what it means for delivery. A refusal the driver
 * names means it did not send the input (safe to repeat once the cause is
 * fixed). Any other error leaves the outcome unknown: it is reported as
 * unverified and unsafe to repeat.
 */
export function failureDelivery(error: McpToolError): WindowInputResult {
	const facts = error.structuredContent ?? {}
	const code = typeof facts.code === 'string' ? facts.code : undefined
	if (
		code === 'background_unavailable' ||
		code === 'background_occluded' ||
		code === 'background_uipi_blocked'
	)
		return verdict(
			'not_delivered',
			'safe',
			code === 'background_uipi_blocked'
				? 'this window belongs to a program running with higher rights, so background input is blocked. Ask the user; do not try to get around it.'
				: code === 'background_occluded'
					? 'the target is covered by another window, so background input cannot reach it. Nothing was sent.'
					: 'this window cannot take background input here (it needs real focus). Nothing was sent. Use a control by ref (ui_act) if the window offers one, or send it again with delivery_mode:"foreground".',
		)
	if (facts.status === 'refused') {
		const refusal = facts.refusal as { message?: unknown } | undefined
		return verdict(
			'not_delivered',
			'safe',
			typeof refusal?.message === 'string' ? refusal.message : error.message,
		)
	}
	if (/stale (window|screenshot)/i.test(error.message))
		return verdict('not_delivered', 'safe', trimText(error.message, 300))
	if (/stale/i.test(`${error.message} ${JSON.stringify(facts)}`))
		return verdict(
			'not_delivered',
			'safe',
			'that control is from an older UI snapshot; take a new one',
		)
	// An error the driver does not classify can arrive after input was sent (a
	// foreground burst calls this too), so it never invites a blind resend.
	return verdict(
		'delivered_unverified',
		'unsafe',
		`${trimText(error.message, 300)} The input may have been sent; look at the window before repeating it.`,
	)
}

/** The driver refused a handle a newer read of its window replaced (nothing was sent). */
function isStaleHandle(error: McpToolError): boolean {
	if (/stale (window|screenshot)/i.test(error.message)) return false
	return /stale_element_token|stale (UI|element)/i.test(
		`${error.message} ${JSON.stringify(error.structuredContent ?? {})}`,
	)
}

/** Refusals that a foreground delivery can cure. `uipi_blocked` is not one: it blocks foreground input too. */
function foregroundCures(error: McpToolError): boolean {
	const code = error.structuredContent?.code
	return code === 'background_unavailable' || code === 'background_occluded'
}

function failureResult(error: McpToolError): UiActResult {
	const { delivery, retrySafety, detail } = failureDelivery(error)
	return {
		ok: false,
		delivery,
		retrySafety,
		...(detail !== undefined ? { detail } : {}),
	}
}

/**
 * cua-driver's action result → the host's. `unverifiable` is the driver's
 * answer to almost everything it does in the background, so a result that
 * returned is "sent", and the stateful actions are judged by reading the
 * control back.
 */
export function actResult(result: McpToolResult): UiActResult {
	const sent = inputDelivery(result)
	return {
		ok: sent.delivery !== 'not_delivered' && result.structuredContent?.effect !== 'suspected_noop',
		delivery: sent.delivery,
		retrySafety: sent.retrySafety,
		...(sent.detail !== undefined ? { detail: sent.detail } : {}),
	}
}

const same = (a: string, b: string): boolean => a.trim() === b.trim()

/** set_value, judged by the field as a fresh read shows it. */
export function judgeSetValue(
	before: UiRefFacts,
	expected: string,
	after: UiRefFacts | undefined,
): UiActResult {
	if (!after)
		return {
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			detail:
				'the value was sent, but the field could not be read back (the window may have changed). Check it before setting it again.',
		}
	if (after.value === undefined)
		return {
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			detail:
				'the value was sent; this control does not report its value, so it could not be checked. Look at the window.',
		}
	if (same(after.value, expected))
		return {
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'safe',
			readBack: {
				expected: trimText(expected),
				observed: trimText(after.value),
			},
		}
	if (before.value !== undefined && same(before.value, after.value))
		return {
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
			readBack: {
				expected: trimText(expected),
				observed: trimText(after.value),
			},
			detail: `the driver reported success, but the control still holds ${JSON.stringify(trimText(after.value))}, not the value sent. Nothing changed. This control may need real focus: choose the option with the keyboard or the pointer in the foreground, or use the browser tool for a web page.`,
		}
	return {
		ok: true,
		delivery: 'delivered_unverified',
		retrySafety: 'unsafe',
		readBack: { expected: trimText(expected), observed: trimText(after.value) },
		detail: `the control changed, but it now holds ${JSON.stringify(trimText(after.value))} instead of the value sent; it may have reformatted it. Check before setting it again.`,
	}
}

/** toggle, judged by whether the control's selected state flipped. */
export function judgeToggle(before: UiRefFacts, after: UiRefFacts | undefined): UiActResult {
	if (!after)
		return {
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			detail:
				'the toggle was sent, but the control could not be read back. A second toggle would undo it; check first.',
		}
	if (after.selected !== before.selected)
		return {
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			readBack: {
				expected: String(!before.selected),
				observed: String(after.selected),
			},
		}
	return {
		ok: true,
		delivery: 'delivered_unverified',
		retrySafety: 'unsafe',
		readBack: { observed: String(after.selected) },
		detail:
			'the toggle was sent, but the control still reads the same. It may not report its state, or it may not have changed. A second toggle could undo it; check the window first.',
	}
}

const ITEM_ROLES = /^(ListItem|TreeItem|DataItem)$/

const SELECT_REFUSALS: Readonly<Record<string, string>> = {
	gone: 'the window is gone',
	not_found: 'the row is not in the window any more',
	ambiguous: 'more than one row matches',
	no_pattern: 'the row has no selection pattern',
	refused: 'the program refused the selection',
}

/** select by a click, judged by whether the control now reads as selected (a row that can also be invoked takes the selection pattern instead). */
export function judgeSelect(_before: UiRefFacts, after: UiRefFacts | undefined): UiActResult {
	if (after?.selected === true)
		return {
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			readBack: { expected: 'selected', observed: 'selected' },
		}
	return {
		ok: true,
		delivery: 'delivered_unverified',
		retrySafety: 'unsafe',
		...(after ? { readBack: { expected: 'selected', observed: 'not selected' } } : {}),
		detail: `the click was sent, but the control does not read as selected${after ? '' : ' (it could not be read back)'}.`,
	}
}

/** `0x…` hex, the form `bring_to_front` reports and `WindowInfo.id` carries. */
export function windowIdOf(hwnd: number): string {
	return `0x${hwnd.toString(16)}`
}

export function parseWindowId(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined
	if (typeof value !== 'string') return undefined
	const text = value.trim().toLowerCase()
	const parsed = /^0x[0-9a-f]+$/.test(text)
		? Number.parseInt(text.slice(2), 16)
		: /^\d+$/.test(text)
			? Number.parseInt(text, 10)
			: Number.NaN
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

interface CuaWindow {
	readonly window_id?: unknown
	readonly pid?: unknown
	readonly app_name?: unknown
	readonly title?: unknown
	readonly bounds?: {
		x?: unknown
		y?: unknown
		width?: unknown
		height?: unknown
	}
	readonly minimized?: unknown
	readonly is_on_screen?: unknown
	readonly z_index?: unknown
}

/**
 * cua-driver's `list_windows` records → the host's `WindowInfo`, front to back.
 *
 * Dropped: untitled windows, cua-driver's own (its cursor overlay covers the
 * whole screen), the shell's `Program Manager` desktop, and windows a pixel
 * wide or tall. `focused` is the front-most window that is not minimized —
 * cua-driver does not report the foreground window itself, and the
 * foreground window is the front of the non-topmost z-order.
 */
export function toWindowInfos(raw: unknown): WindowInfo[] {
	if (!Array.isArray(raw)) return []
	const kept: { info: Omit<WindowInfo, 'focused'>; z: number }[] = []
	for (const entry of raw as CuaWindow[]) {
		const hwnd = parseWindowId(entry.window_id)
		const title = typeof entry.title === 'string' ? entry.title : ''
		const app = typeof entry.app_name === 'string' ? entry.app_name : ''
		const pid = typeof entry.pid === 'number' ? entry.pid : undefined
		const bounds = entry.bounds
		if (hwnd === undefined || pid === undefined || !bounds) continue
		if (title.trim().length === 0) continue
		if (app.toLowerCase() === 'cua-driver.exe') continue
		if (app.toLowerCase() === 'explorer.exe' && title === 'Program Manager') continue
		const width = typeof bounds.width === 'number' ? bounds.width : 0
		const height = typeof bounds.height === 'number' ? bounds.height : 0
		if (width <= 1 || height <= 1) continue
		kept.push({
			info: {
				id: windowIdOf(hwnd),
				title,
				app: app.replace(/\.exe$/i, ''),
				pid,
				bounds: {
					x: typeof bounds.x === 'number' ? bounds.x : 0,
					y: typeof bounds.y === 'number' ? bounds.y : 0,
					width,
					height,
				},
				minimized: entry.minimized === true,
			},
			z: typeof entry.z_index === 'number' ? entry.z_index : Number.NEGATIVE_INFINITY,
		})
	}
	// Stable: records without a z-index keep cua-driver's order, after the rest.
	const ordered = kept
		.map((entry, index) => ({ ...entry, index }))
		.sort((a, b) => (b.z === a.z ? a.index - b.index : b.z - a.z))
	const front = ordered.find((entry) => !entry.info.minimized && Number.isFinite(entry.z))
	return ordered.map((entry) => ({ ...entry.info, focused: entry === front }))
}

function structured(result: McpToolResult, tool: string): Record<string, unknown> {
	if (!result.structuredContent)
		throw new Error(`cua-driver: ${tool} returned no structured result.`)
	return result.structuredContent
}

function requireNumber(source: Record<string, unknown>, key: string, tool: string): number {
	const value = source[key]
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`cua-driver: ${tool} did not report ${key}.`)
	}
	return value
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function windowBounds(value: unknown): WindowInfo['bounds'] | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const facts = value as Record<string, unknown>
	const { x, y, width, height } = facts
	if (
		typeof x !== 'number' ||
		typeof y !== 'number' ||
		typeof width !== 'number' ||
		typeof height !== 'number' ||
		![x, y, width, height].every(Number.isFinite) ||
		width <= 0 ||
		height <= 0
	)
		return undefined
	return { x, y, width, height }
}

function sameBounds(a: WindowInfo['bounds'], b: WindowInfo['bounds']): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function decodePngDims(buffer: Buffer): { width: number; height: number } {
	if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
		throw new Error('cua-driver: the screenshot is not a PNG.')
	}
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}
