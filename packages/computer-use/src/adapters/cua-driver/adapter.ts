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
	UiActResult,
	UiElement,
	UiElementAction,
	UiSnapshot,
	WindowInfo,
	WindowInputAction,
	WindowInputResult,
	WindowScreenshotResult,
} from '@namzu/sdk'
import { foregroundNote, interferenceNote } from '../../foreground/guard.js'
import type { ForegroundLadder } from '../../foreground/ladder.js'
import { BurstInterrupted } from '../../foreground/types.js'
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
import { type ParsedUiTree, type UiRefFacts, toUiTree } from './ui-tree.js'

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
	/** For tests. */
	readonly spawnProcess?: McpStdioClientOptions['spawnProcess']
	readonly requestTimeoutMs?: number
	readonly startTimeoutMs?: number
}

const CAPTURE_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 20_000
/** A browser window's tree takes 2–3 s; a huge one is cut by `UI_MAX_ELEMENTS` first. */
const UI_TREE_TIMEOUT_MS = 30_000
/** The most controls one snapshot walks. The SDK shows the model at most ~14 000 characters of it. */
const UI_MAX_ELEMENTS = 1_500
/** cua-driver refuses more than 50 ticks in one scroll call. */
const MAX_SCROLL_TICKS = 50
/** A drag glides through intermediate moves; many targets ignore one that teleports. */
const DRAG = { durationMs: 250, steps: 12 } as const

async function disableAgentCursor(call: McpToolCaller): Promise<void> {
	// Best effort: a build without the tool still works, only slower.
	await call('set_agent_cursor_enabled', { enabled: false }).catch(() => undefined)
}

interface UiRefEntry extends UiRefFacts {
	readonly token: string
	readonly pid: number
	readonly hwnd: number
	/** Position among the window's refs that share role and name, in tree order. */
	readonly ordinal: number
	readonly generation: number
	readonly processStarts: number
}

interface WindowCaptureFrame {
	readonly id: string
	readonly window: WindowInfo
	readonly width: number
	readonly height: number
	readonly processStarts: number
	readonly generation: number
}

/** Replace process-local driver tokens before any UI tree leaves this adapter. */
function withOpaqueRefs(element: UiElement, refFor: (token: string) => string): UiElement {
	return Object.freeze({
		...element,
		ref: element.ref ? refFor(element.ref) : '',
		...(element.children
			? {
					children: Object.freeze(element.children.map((child) => withOpaqueRefs(child, refFor))),
				}
			: {}),
	})
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
	/** cua-driver's screenshot resize registry is per PID, so only this capture may drive input. */
	private windowFrame: WindowCaptureFrame | undefined
	/** Capture and scoped input must not race over cua-driver's per-PID resize ratio. */
	private windowOperation: Promise<void> = Promise.resolve()
	/** Only refs from the latest snapshot may address driver tokens. */
	private uiRefs = new Map<string, UiRefEntry>()
	private readonly uiRefNamespace = randomUUID()
	private nextSnapshot = 0
	/** A successful revival invalidates refusals from the previous lifecycle episode. */
	private sessionGeneration = 0
	/** Share one revival among calls refused by the same expired implicit session. */
	private sessionRevival: Promise<void> | undefined

	constructor(options: CuaDriverAdapterOptions) {
		this.backend = `cua-driver${options.version ? ` ${options.version}` : ''}`
		this.foreground = options.foreground
		this.client = new McpStdioClient({
			command: options.executable,
			args: ['mcp'],
			env: options.env,
			cwd: options.cwd,
			clientName: 'namzu-computer-use',
			requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
			startTimeoutMs: options.startTimeoutMs ?? 30_000,
			spawnProcess: options.spawnProcess,
			afterStart: disableAgentCursor,
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
				return this.keyboard('type_text', { scope: 'desktop', text: action.text })
			case 'key': {
				const plan = translateKeyForCuaDriver(action.keys)
				if (plan.tool === 'type_text')
					return this.keyboard('type_text', { scope: 'desktop', text: plan.text })
				if (plan.tool === 'press_key')
					return this.keyboard('press_key', { scope: 'desktop', key: plan.key })
				return this.keyboard('hotkey', { scope: 'desktop', keys: [...plan.keys] })
			}
		}
	}

	async listWindows(): Promise<readonly WindowInfo[]> {
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

	private async executeWindowInternal(
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
					.run({ subject }, async (burst) => {
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
						if (error instanceof BurstInterrupted) return undefined
						throw error
					})
				if (!outcome)
					return verdict(
						'not_delivered',
						'safe',
						'a person used the keyboard or mouse just before the input was sent, so nothing was sent. Try again in a moment.',
					)
				if (outcome.kind === 'blocked')
					return verdict('not_delivered', 'safe', outcome.block.detail)
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
	 */
	async uiSnapshot(windowId?: string): Promise<UiSnapshot> {
		const target = await this.resolveWindow(windowId)
		const read = await this.readWindowTree(target)
		const { state, tree } = read
		this.uiRefs = this.entriesFor(tree, target, read)
		const title = typeof state.window_title === 'string' ? state.window_title : undefined
		const app =
			typeof state.app_name === 'string' ? state.app_name.replace(/\.exe$/i, '') : undefined
		const byToken = new Map<string, string>()
		for (const [ref, entry] of this.uiRefs) byToken.set(entry.token, ref)
		const root = withOpaqueRefs(tree.root, (token) => byToken.get(token) ?? '')
		return {
			windowId: windowIdOf(target.hwnd),
			...(title !== undefined ? { title } : {}),
			...(app !== undefined ? { app } : {}),
			root,
			...(state.truncated === true ? { truncated: true } : {}),
		}
	}

	/** One `get_window_state` walk, with the process and session it was read from. */
	private async readWindowTree(target: { hwnd: number; pid: number }): Promise<{
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
		return { state, tree: toUiTree(state), processStarts, generation }
	}

	/** Opaque refs for a tree's controls, each carrying the evidence that finds it again. */
	private entriesFor(
		tree: ParsedUiTree,
		target: { hwnd: number; pid: number },
		read: { processStarts: number; generation: number },
	): Map<string, UiRefEntry> {
		const snapshot = ++this.nextSnapshot
		const refs = new Map<string, UiRefEntry>()
		const seen = new Map<string, number>()
		let counter = 0
		for (const [token, facts] of tree.refs) {
			const key = `${facts.role}\u0000${facts.name}`
			const ordinal = seen.get(key) ?? 0
			seen.set(key, ordinal + 1)
			const ref = `cua-ui:${this.uiRefNamespace}:${snapshot}:${++counter}`
			refs.set(ref, {
				...facts,
				token,
				pid: target.pid,
				hwnd: target.hwnd,
				ordinal,
				generation: read.generation,
				processStarts: read.processStarts,
			})
		}
		return refs
	}

	/**
	 * The control a ref named, found again in a newer read of its window: by
	 * automation id when it has one and that id is unique, else by role, name
	 * and position among controls that share both.
	 */
	private findAgain(old: UiRefEntry, tree: ParsedUiTree): [string, UiRefFacts] | undefined {
		if (old.automationId !== undefined) {
			const same = [...tree.refs].filter(([, f]) => f.automationId === old.automationId)
			if (same.length === 1 && same[0]) return same[0]
		}
		const alike = [...tree.refs].filter(([, f]) => f.role === old.role && f.name === old.name)
		return alike[old.ordinal]
	}

	/**
	 * After a read-back the window's old driver tokens are dead. Give every
	 * ref the model holds for that window the token of the control it named,
	 * and drop the refs whose control is gone.
	 */
	private rebindRefs(
		target: { hwnd: number; pid: number },
		tree: ParsedUiTree,
		read: { processStarts: number; generation: number },
	): void {
		const next = new Map<string, UiRefEntry>()
		for (const [ref, entry] of this.uiRefs) {
			if (entry.hwnd !== target.hwnd) {
				next.set(ref, entry)
				continue
			}
			const found = this.findAgain(entry, tree)
			if (!found) continue
			next.set(ref, {
				...found[1],
				token: found[0],
				pid: target.pid,
				hwnd: target.hwnd,
				ordinal: entry.ordinal,
				generation: read.generation,
				processStarts: read.processStarts,
			})
		}
		this.uiRefs = next
	}

	async uiAct(ref: string, action: UiElementAction, value?: string): Promise<UiActResult> {
		const facts = this.uiRefs.get(ref)
		if (!facts)
			return {
				ok: false,
				detail: `${ref} is not a control of the latest UI snapshot; take a new one.`,
				delivery: 'not_delivered',
				retrySafety: 'safe',
			}
		const { pid, token } = facts
		const uiRef = { ref, facts }
		try {
			switch (action) {
				case 'invoke':
				case 'expand':
				case 'collapse':
					// cua-driver's click on an element token performs the control's
					// own pattern in the background (Invoke, or a posted click at its
					// centre), with no pointer move and no change of foreground.
					return await this.clickRef(facts, uiRef)
				case 'toggle':
				case 'select': {
					const sent = await this.clickRef(facts, uiRef)
					if (!sent.ok) return sent
					const back = await this.readBack(facts)
					return action === 'toggle' ? judgeToggle(facts, back) : judgeSelect(facts, back)
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
						)
							// Typing instead would equal setting only while the field is
							// empty, and the driver's own report of it is not trustworthy.
							return {
								ok: false,
								delivery: 'not_delivered',
								retrySafety: 'safe',
								detail:
									'this field has no settable value, and nothing was typed. A classic edit control takes text through the keyboard: click it in a window screenshot, then type_text (add delivery_mode:"foreground" when background typing is not delivered).',
							}
						throw error
					}
					if (!sent.ok) return sent
					return judgeSetValue(facts, text, await this.readBack(facts))
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
			if (error instanceof McpToolError) return failureResult(error)
			throw error
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
				.run({ subject }, async (burst) => {
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
					if (inner instanceof BurstInterrupted) return undefined
					throw inner
				})
			if (!outcome)
				return {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail:
						'a person used the keyboard or mouse just before the click was sent, so nothing was sent. Try again in a moment.',
				}
			if (outcome.kind === 'blocked')
				return {
					ok: false,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: outcome.block.detail,
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
			const read = await this.readWindowTree(target)
			const found = this.findAgain(facts, read.tree)
			this.rebindRefs(target, read.tree, read)
			return found?.[1]
		} catch {
			return undefined
		}
	}

	async dispose(): Promise<void> {
		await this.client.dispose()
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
				uiRef.facts.generation !== this.sessionGeneration)
		)
			throw new McpToolError(name, 'stale UI snapshot; take a new one')
		const generation = this.sessionGeneration
		try {
			return await this.client.callTool(name, args, timeoutMs, {
				...(uiRef || windowFrame
					? { expectedStarts: uiRef?.facts.processStarts ?? windowFrame?.processStarts }
					: {}),
				...(onProcess ? { onProcess } : {}),
			})
		} catch (error) {
			if (!isEndedSessionRefusal(error)) throw error
			// The refusal proves the old session's element tokens are invalid,
			// even if start_session fails and there is no successful revival.
			if (this.sessionGeneration === generation) this.uiRefs.clear()
			this.windowFrame = undefined
			await this.reviveSession(generation)
			// Element tokens belong to the old snapshot. A new lifecycle session
			// needs a new tree before a control can be addressed again.
			if (uiRef) throw new McpToolError(name, 'stale UI snapshot; take a new one')
			if (windowFrame)
				throw new McpToolError(name, 'stale window screenshot; capture the window again')
			// One retry only. A second refusal or an unacknowledged action is
			// returned to the host without any further automatic replay.
			return this.client.callTool(name, args, timeoutMs, { onProcess })
		}
	}

	private async reviveSession(generation: number): Promise<void> {
		if (this.sessionGeneration !== generation) return
		if (!this.sessionRevival) {
			this.sessionRevival = (async () => {
				await this.client.callTool('start_session')
				await disableAgentCursor((name, args) => this.client.callTool(name, args))
				this.uiRefs.clear()
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

/** Refusals that a foreground delivery can cure. `uipi_blocked` is not one: it blocks foreground input too. */
function foregroundCures(error: McpToolError): boolean {
	const code = error.structuredContent?.code
	return code === 'background_unavailable' || code === 'background_occluded'
}

function failureResult(error: McpToolError): UiActResult {
	const { delivery, retrySafety, detail } = failureDelivery(error)
	return { ok: false, delivery, retrySafety, ...(detail !== undefined ? { detail } : {}) }
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
			readBack: { expected: trimText(expected), observed: trimText(after.value) },
		}
	if (before.value !== undefined && same(before.value, after.value))
		return {
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
			readBack: { expected: trimText(expected), observed: trimText(after.value) },
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
			readBack: { expected: String(!before.selected), observed: String(after.selected) },
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

/** select, judged by whether the control now reads as selected. */
export function judgeSelect(before: UiRefFacts, after: UiRefFacts | undefined): UiActResult {
	// A list or tree row is also invokable, and the driver's click on it
	// invokes: a file row opens its file. Say so, whatever the read-back shows.
	const warning =
		ITEM_ROLES.test(before.role) && before.actions.includes('invoke')
			? ' This row is also invokable and select clicked it, so it may have opened the item.'
			: ''
	if (after?.selected === true)
		return {
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			readBack: { expected: 'selected', observed: 'selected' },
			...(warning ? { detail: warning.trim() } : {}),
		}
	return {
		ok: true,
		delivery: 'delivered_unverified',
		retrySafety: 'unsafe',
		...(after ? { readBack: { expected: 'selected', observed: 'not selected' } } : {}),
		detail: `the click was sent, but the control does not read as selected${after ? '' : ' (it could not be read back)'}.${warning}`,
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
