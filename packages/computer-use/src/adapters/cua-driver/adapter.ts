import { randomUUID } from 'node:crypto'
import type {
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
	WindowScreenshotResult,
} from '@namzu/sdk'
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
import { type UiRefFacts, toUiTree } from './ui-tree.js'

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
				await this.pointer('click', {
					scope: 'desktop',
					x: action.at.x,
					y: action.at.y,
					button: action.button,
				})
				return { type: 'ok' }
			case 'mouse_drag':
				await this.pointer('drag', {
					scope: 'desktop',
					from_x: action.from.x,
					from_y: action.from.y,
					to_x: action.to.x,
					to_y: action.to.y,
					button: action.button,
					duration_ms: DRAG.durationMs,
					steps: DRAG.steps,
				})
				return { type: 'ok' }
			case 'scroll': {
				let remaining = Math.max(1, Math.trunc(action.amount))
				while (remaining > 0) {
					const ticks = Math.min(remaining, MAX_SCROLL_TICKS)
					await this.pointer('scroll', {
						scope: 'desktop',
						x: action.at.x,
						y: action.at.y,
						direction: action.direction,
						amount: ticks,
					})
					remaining -= ticks
				}
				return { type: 'ok' }
			}
			case 'type_text':
				if (action.text.length > 0) {
					await this.callTool('type_text', {
						scope: 'desktop',
						text: action.text,
					})
				}
				return { type: 'ok' }
			case 'key': {
				const plan = translateKeyForCuaDriver(action.keys)
				if (plan.tool === 'type_text') {
					await this.callTool('type_text', {
						scope: 'desktop',
						text: plan.text,
					})
				} else if (plan.tool === 'press_key') {
					await this.callTool('press_key', { scope: 'desktop', key: plan.key })
				} else {
					await this.callTool('hotkey', {
						scope: 'desktop',
						keys: [...plan.keys],
					})
				}
				return { type: 'ok' }
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
		for (const window of windows) this.windowPids.set(window.id, window.pid)
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

	async executeWindow(captureId: string, action: WindowInputAction): Promise<void> {
		return this.serializeWindowOperation(() => this.executeWindowInternal(captureId, action))
	}

	private async executeWindowInternal(captureId: string, action: WindowInputAction): Promise<void> {
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
		const call = async (name: string, args: Record<string, unknown>) => {
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
			await this.callTool(name, { ...target, ...args }, undefined, undefined, undefined, frame)
		}
		switch (action.type) {
			case 'mouse_click':
				try {
					await call('click', { x: action.at.x, y: action.at.y, button: action.button })
				} catch (error) {
					if (!isDeliveredPointerAction(error)) throw windowPointerRefusal(error)
				}
				return
			case 'mouse_drag':
				try {
					await call('drag', {
						from_x: action.from.x,
						from_y: action.from.y,
						to_x: action.to.x,
						to_y: action.to.y,
						button: action.button,
						duration_ms: DRAG.durationMs,
						steps: DRAG.steps,
					})
				} catch (error) {
					throw windowPointerRefusal(error)
				}
				return
			case 'scroll':
				throw new Error(
					'computer-use: window pixel scrolling is unavailable on this Windows driver; use foreground PAGE_DOWN or ARROW_DOWN in this window, or take a deliberate display screenshot before display scrolling.',
				)
			case 'type_text':
				if (action.text.length > 0)
					await call('type_text', {
						text: action.text,
						...(action.delivery_mode ? { delivery_mode: action.delivery_mode } : {}),
					})
				return
			case 'key': {
				const plan = translateKeyForCuaDriver(action.keys)
				const delivery = action.delivery_mode ? { delivery_mode: action.delivery_mode } : {}
				if (plan.tool === 'type_text') await call('type_text', { text: plan.text, ...delivery })
				else if (plan.tool === 'press_key') await call('press_key', { key: plan.key, ...delivery })
				else await call('hotkey', { keys: [...plan.keys], ...delivery })
				return
			}
		}
	}

	/**
	 * One window's controls. Without an id, the window in front — which,
	 * for an agent run from a terminal, is usually that terminal.
	 */
	async uiSnapshot(windowId?: string): Promise<UiSnapshot> {
		const target = await this.resolveWindow(windowId)
		let processStarts = 0
		let snapshotGeneration = this.sessionGeneration
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
					snapshotGeneration = this.sessionGeneration
				},
			),
			'get_window_state',
		)
		if (snapshotGeneration !== this.sessionGeneration || processStarts === 0)
			throw new McpToolError('get_window_state', 'stale UI snapshot; take a new one')
		const tree = toUiTree(state)
		const snapshot = ++this.nextSnapshot
		const refs = new Map<string, UiRefEntry>()
		let ordinal = 0
		const root = withOpaqueRefs(tree.root, (token) => {
			const ref = `cua-ui:${this.uiRefNamespace}:${snapshot}:${++ordinal}`
			refs.set(ref, {
				...tree.refs.get(token),
				token,
				pid: target.pid,
				generation: snapshotGeneration,
				processStarts,
			})
			return ref
		})
		this.uiRefs = refs
		const title = typeof state.window_title === 'string' ? state.window_title : undefined
		const app =
			typeof state.app_name === 'string' ? state.app_name.replace(/\.exe$/i, '') : undefined
		return {
			windowId: windowIdOf(target.hwnd),
			...(title !== undefined ? { title } : {}),
			...(app !== undefined ? { app } : {}),
			root,
			...(state.truncated === true ? { truncated: true } : {}),
		}
	}

	async uiAct(ref: string, action: UiElementAction, value?: string): Promise<UiActResult> {
		const facts = this.uiRefs.get(ref)
		if (!facts)
			return {
				ok: false,
				detail: `${ref} is not a control of the latest UI snapshot; take a new one.`,
			}
		const { pid, token } = facts
		const uiRef = { ref, facts }
		try {
			switch (action) {
				case 'invoke':
				case 'toggle':
				case 'select':
				case 'expand':
				case 'collapse':
					// cua-driver's click on an element token performs the control's
					// own pattern in the background (Invoke, or a posted click at its
					// centre), with no pointer move and no change of foreground.
					return actResult(
						await this.callTool('click', { pid, element_token: token }, undefined, uiRef),
					)
				case 'set_value': {
					const text = value ?? ''
					try {
						return actResult(
							await this.callTool(
								'set_value',
								{ pid, element_token: token, value: text },
								undefined,
								uiRef,
							),
						)
					} catch (error) {
						if (
							!(error instanceof McpToolError) ||
							!/does not implement ValuePattern/i.test(error.message)
						)
							throw error
						// A classic Win32 edit reports no ValuePattern. Typing into it
						// equals setting it only while it is empty.
						if (facts.value !== undefined && facts.value.length > 0)
							return {
								ok: false,
								detail:
									'this field cannot be set directly and already holds text; click it, select its text (CTRL+A) and type the new text instead',
							}
						const typed = actResult(
							await this.callTool(
								'type_text',
								{ pid, element_token: token, text },
								undefined,
								uiRef,
							),
						)
						return typed.ok
							? {
									ok: true,
									detail: 'typed into the empty field, which has no settable value',
								}
							: typed
					}
				}
				case 'focus':
				case 'scroll_into_view':
					return {
						ok: false,
						detail: `this host cannot ${action === 'focus' ? 'focus' : 'scroll to'} a control by itself; invoke it or click it instead`,
					}
			}
		} catch (error) {
			if (error instanceof McpToolError) return { ok: false, detail: toolRefusal(error) }
			throw error
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

	private async pointer(tool: string, args: Record<string, unknown>): Promise<void> {
		try {
			await this.callTool(tool, args)
		} catch (error) {
			if (isDeliveredPointerAction(error)) return
			throw error
		}
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

/** The pinned driver suggests foreground pointer input even when it cannot bind the OS hit test to our HWND. */
function windowPointerRefusal(error: unknown): unknown {
	const code = error instanceof McpToolError ? error.structuredContent?.code : undefined
	if (
		code === 'background_unavailable' ||
		code === 'background_occluded' ||
		code === 'background_uipi_blocked'
	)
		return new Error(
			'computer-use: this window pointer action could not be delivered safely in background. No window-scoped foreground pointer retry is available; inspect a fresh window screenshot, use a control ref if available, or deliberately capture the display before display input.',
		)
	return error
}

/**
 * cua-driver's action result → the host's. `confirmed`, `partial` and
 * `unverifiable` count as done: a background UIA Invoke is `unverifiable` by
 * design (the control does not report back), and the screenshot the tool
 * takes afterwards is where the model sees the effect.
 */
export function actResult(result: McpToolResult): UiActResult {
	const facts = result.structuredContent ?? {}
	switch (facts.effect) {
		case 'suspected_noop':
			return {
				ok: false,
				detail: 'the control did not change; the action may not have reached it',
			}
		case 'refused': {
			const refusal = facts.refusal as { message?: unknown } | undefined
			return {
				ok: false,
				detail:
					typeof refusal?.message === 'string' ? refusal.message : 'cua-driver refused the action',
			}
		}
		default:
			return { ok: true }
	}
}

/** Why a tool call failed, in words that tell the model what to do next. */
function toolRefusal(error: McpToolError): string {
	if (/stale/i.test(error.message))
		return 'that control is from an older UI snapshot; take a new one'
	return error.message.length > 300 ? `${error.message.slice(0, 299)}…` : error.message
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
