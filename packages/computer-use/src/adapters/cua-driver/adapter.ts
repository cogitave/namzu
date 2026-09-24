import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	DisplayInfo,
	FocusWindowResult,
	ScreenshotResult,
	UiActResult,
	UiElementAction,
	UiSnapshot,
	WindowInfo,
} from '@namzu/sdk'
import type { Adapter } from '../types.js'
import {
	McpStdioClient,
	type McpStdioClientOptions,
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
 * Every input goes to cua-driver's `desktop` scope: real `SendInput` at
 * screen coordinates, which is this package's contract. Its default
 * `window` scope posts messages to a process in the background instead, a
 * different model this adapter does not expose.
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
 *   whose refs are cua-driver's element tokens, and `uiAct` drives a control
 *   by token: UIA Invoke for a button, ValuePattern for a field, falling back
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

export class CuaDriverAdapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities
	readonly backend: string
	private readonly client: McpStdioClient
	/** Window id → owning pid, from the latest list; `bring_to_front` needs both. */
	private readonly windowPids = new Map<string, number>()
	/** The refs of the latest UI snapshot: element token → its window's pid and what it held. */
	private uiRefs = new Map<string, UiRefFacts & { readonly pid: number }>()

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
			afterStart: async (call) => {
				// Best effort: a build without the tool still works, only slower.
				await call('set_agent_cursor_enabled', { enabled: false }).catch(() => undefined)
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
		const size = structured(await this.client.callTool('get_screen_size'), 'get_screen_size')
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
				const point = structured(
					await this.client.callTool('get_cursor_position'),
					'get_cursor_position',
				)
				return {
					type: 'cursor_position',
					point: {
						x: requireNumber(point, 'x', 'get_cursor_position'),
						y: requireNumber(point, 'y', 'get_cursor_position'),
					},
				}
			}
			case 'mouse_move':
				await this.client.callTool('move_cursor', {
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
					await this.client.callTool('type_text', { scope: 'desktop', text: action.text })
				}
				return { type: 'ok' }
			case 'key': {
				const plan = translateKeyForCuaDriver(action.keys)
				if (plan.tool === 'type_text') {
					await this.client.callTool('type_text', { scope: 'desktop', text: plan.text })
				} else if (plan.tool === 'press_key') {
					await this.client.callTool('press_key', { scope: 'desktop', key: plan.key })
				} else {
					await this.client.callTool('hotkey', { scope: 'desktop', keys: [...plan.keys] })
				}
				return { type: 'ok' }
			}
		}
	}

	async listWindows(): Promise<readonly WindowInfo[]> {
		const listed = structured(
			await this.client.callTool('list_windows', {}, LIST_TIMEOUT_MS),
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
			await this.client.callTool('bring_to_front', { pid, window_id: hwnd }),
			'bring_to_front',
		)
		const now = parseWindowId(result.now_fg_hwnd)
		const focusedId = now === undefined ? null : windowIdOf(now)
		return { ok: focusedId === windowIdOf(hwnd), focusedId }
	}

	/**
	 * One window's controls. Without an id, the window in front — which,
	 * for an agent run from a terminal, is usually that terminal.
	 */
	async uiSnapshot(windowId?: string): Promise<UiSnapshot> {
		const target = await this.resolveWindow(windowId)
		const state = structured(
			await this.client.callTool(
				'get_window_state',
				{
					pid: target.pid,
					window_id: target.hwnd,
					include_screenshot: false,
					max_elements: UI_MAX_ELEMENTS,
				},
				UI_TREE_TIMEOUT_MS,
			),
			'get_window_state',
		)
		const tree = toUiTree(state)
		// A token names its snapshot, and cua-driver refuses a stale one, so
		// only the latest snapshot's refs are kept.
		this.uiRefs = new Map(
			[...tree.refs].map(([ref, facts]) => [ref, { ...facts, pid: target.pid }]),
		)
		const title = typeof state.window_title === 'string' ? state.window_title : undefined
		const app =
			typeof state.app_name === 'string' ? state.app_name.replace(/\.exe$/i, '') : undefined
		return {
			windowId: windowIdOf(target.hwnd),
			...(title !== undefined ? { title } : {}),
			...(app !== undefined ? { app } : {}),
			root: tree.root,
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
		const { pid } = facts
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
					return actResult(await this.client.callTool('click', { pid, element_token: ref }))
				case 'set_value': {
					const text = value ?? ''
					try {
						return actResult(
							await this.client.callTool('set_value', { pid, element_token: ref, value: text }),
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
							await this.client.callTool('type_text', { pid, element_token: ref, text }),
						)
						return typed.ok
							? { ok: true, detail: 'typed into the empty field, which has no settable value' }
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
			await this.client.callTool(tool, args)
		} catch (error) {
			if (isDeliveredPointerAction(error)) return
			throw error
		}
	}

	private async capture(): Promise<ScreenshotResult> {
		const result = await this.client.callTool('get_desktop_state', {}, CAPTURE_TIMEOUT_MS)
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
			return { ok: false, detail: 'the control did not change; the action may not have reached it' }
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
	readonly bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
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

function decodePngDims(buffer: Buffer): { width: number; height: number } {
	if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
		throw new Error('cua-driver: the screenshot is not a PNG.')
	}
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}
