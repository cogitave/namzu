// ---------------------------------------------------------------------------
// Display server — the host environment's graphical stack
// ---------------------------------------------------------------------------

export type DisplayServer = 'darwin' | 'win32' | 'x11' | 'wayland' | 'unknown'

export function assertDisplayServer(value: DisplayServer): void {
	switch (value) {
		case 'darwin':
		case 'win32':
		case 'x11':
		case 'wayland':
		case 'unknown':
			return
		default: {
			const _exhaustive: never = value
			throw new Error(`Unknown DisplayServer: ${_exhaustive}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Capabilities — frozen at host construction; model sees these via tool description
// ---------------------------------------------------------------------------

export interface ComputerUseCapabilities {
	readonly displayServer: DisplayServer
	readonly screenshot: boolean
	readonly mouse: boolean
	readonly keyboard: boolean
	readonly cursorPosition: boolean
	readonly clipboard: boolean
	/** Exact action subset when known. Refines the broad flags; absent retains their legacy interpretation. */
	readonly supportedActions?: readonly ComputerUseAction['type'][]
	/** Supported click buttons; absent leaves button admission to the host. */
	readonly mouseClickButtons?: readonly MouseButton[]
	/** Supported drag buttons; absent leaves button admission to the host. */
	readonly mouseDragButtons?: readonly MouseButton[]
	/**
	 * Why every flag above is false, when a host loaded but the desktop did
	 * not answer — a WSL process with PowerShell and no interactive Windows
	 * session, an ssh session with no display. Present, the tool stays
	 * mounted and says this in its description and in every refusal, so the
	 * model reads the reason once and does not try again.
	 */
	readonly unavailableReason?: string
	/**
	 * The host implements {@link ComputerUseHost.listWindows} and
	 * {@link ComputerUseHost.focusWindow}. Absent or false, the tool does not
	 * offer `list_windows` or `focus_window`, even when the methods exist.
	 */
	readonly windows?: boolean
	/**
	 * The host implements {@link ComputerUseHost.captureRegion}. Absent or
	 * false, `zoom` still works: the tool crops a full capture instead, which
	 * costs one whole-display capture per zoom.
	 */
	readonly regionCapture?: boolean
	/**
	 * The host implements {@link ComputerUseHost.uiSnapshot} and
	 * {@link ComputerUseHost.uiAct}: an accessibility tree (Windows UI
	 * Automation, macOS AX, AT-SPI, or a driver that wraps one) whose
	 * elements can be acted on by reference instead of by pixel.
	 *
	 * @experimental The UI-tree surface is reserved for the host packages that
	 * implement it; its shape may still change in a minor release.
	 */
	readonly uiTree?: boolean
}

// ---------------------------------------------------------------------------
// Geometry + screenshot payload
//
// Units, once for the whole file: every coordinate and size a host accepts or
// returns is in PHYSICAL pixels — the pixels of the captured bitmap, not
// logical points or DPI-scaled units. A 3440x1440 monitor at 150 % scaling is
// 3440x1440 here. A point a host is asked to act on is relative to the
// top-left of the display it last captured (the primary display until a host
// offers display selection); the host adds that display's origin itself.
// Window and UI-element bounds are the exception and say so: they are in
// virtual-desktop physical pixels, because a window can span displays.
// ---------------------------------------------------------------------------

export interface DisplayGeometry {
	readonly width: number
	readonly height: number
	readonly scaleFactor: number
}

/**
 * The display a capture shows.
 *
 * `x`/`y` place it in the virtual desktop (a monitor left of the primary has
 * a negative `x`); `width`/`height` are its physical size. `scaleFactor` is
 * physical pixels per logical pixel — 1 at 96 DPI on Windows, 1.5 at 150 %,
 * 2 on a Retina panel — reported for the host UI and for diagnosis; the tool
 * never multiplies by it, because every coordinate crossing this interface
 * is already physical.
 */
export interface DisplayInfo {
	/** Stable for the host's lifetime; what a host would accept to select this display. */
	readonly id: string
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	readonly scaleFactor: number
	/** True for the display the operating system calls primary. */
	readonly primary?: boolean
}

export interface ScreenshotResult {
	readonly data: Buffer
	readonly mimeType: 'image/png'
	/** Physical pixel width of `data`. */
	readonly width: number
	/** Physical pixel height of `data`. */
	readonly height: number
	/**
	 * The display this capture shows. A host should always set it; one written
	 * before it existed does not, and the tool then assumes a single display at
	 * the origin whose size is the capture's own, with a scale factor of 1.
	 */
	readonly display?: DisplayInfo
}

/** A rectangle in physical pixels. What its origin is relative to depends on where it appears. */
export interface Rect {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

/** One top-level window, as {@link ComputerUseHost.listWindows} reports it. */
export interface WindowInfo {
	/** Opaque and host-defined (an HWND in hex, a CGWindowID, an X11 window id); valid for {@link ComputerUseHost.focusWindow}. */
	readonly id: string
	readonly title: string
	/** Application or process name, e.g. `msedge`, `Teams`, `Code`. */
	readonly app: string
	readonly pid: number
	/** Virtual-desktop physical pixels — not display-relative. */
	readonly bounds: Rect
	readonly focused: boolean
	readonly minimized: boolean
}

/**
 * What {@link ComputerUseHost.focusWindow} achieved. Bringing a window to
 * the front is a request the operating system can refuse (Windows'
 * foreground lock is the common case), so a host reports the window that is
 * actually in front afterwards rather than assuming its request held.
 */
export interface FocusWindowResult {
	/** True only when `focusedId` is the requested window. */
	readonly ok: boolean
	/** The window in front after the attempt, or null when none could be read. */
	readonly focusedId: string | null
}

/**
 * An action an accessibility element can take by reference.
 *
 * @experimental See {@link ComputerUseCapabilities.uiTree}.
 */
export type UiElementAction =
	| 'invoke'
	| 'focus'
	| 'set_value'
	| 'toggle'
	| 'select'
	| 'expand'
	| 'collapse'
	| 'scroll_into_view'

/**
 * One accessibility element.
 *
 * @experimental See {@link ComputerUseCapabilities.uiTree}.
 */
export interface UiElement {
	/** Opaque reference, valid until the next snapshot of the same window. */
	readonly ref: string
	/** Platform role, e.g. `Button`, `Edit`, `ListItem` (UIA ControlType) or `AXButton`. */
	readonly role: string
	readonly name: string
	readonly value?: string
	/** A platform automation id, when the element has one. */
	readonly automationId?: string
	/** Virtual-desktop physical pixels, when the element is on screen. */
	readonly bounds?: Rect
	/** Element states such as `focused`, `disabled`, `selected`, `checked`, `expanded`. */
	readonly states?: readonly string[]
	readonly actions?: readonly UiElementAction[]
	readonly children?: readonly UiElement[]
}

/**
 * An accessibility tree for one window.
 *
 * @experimental See {@link ComputerUseCapabilities.uiTree}.
 */
export interface UiSnapshot {
	readonly windowId?: string
	readonly root: UiElement
	/** True when the host stopped walking the tree before it ended (a size or time bound). */
	readonly truncated?: boolean
}

/**
 * What {@link ComputerUseHost.uiAct} did.
 *
 * @experimental See {@link ComputerUseCapabilities.uiTree}.
 */
export interface UiActResult {
	readonly ok: boolean
	/** Why it did not, in words the model can act on (a stale ref, a disabled element). */
	readonly detail?: string
}

export interface Point {
	readonly x: number
	readonly y: number
}

export type MouseButton = 'left' | 'right' | 'middle'

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

// ---------------------------------------------------------------------------
// Action — discriminated union over what a pointer-and-keyboard host can do
// ---------------------------------------------------------------------------

export type ComputerUseAction =
	| { readonly type: 'screenshot' }
	| { readonly type: 'cursor_position' }
	| { readonly type: 'mouse_move'; readonly to: Point }
	| { readonly type: 'mouse_click'; readonly at: Point; readonly button: MouseButton }
	| {
			readonly type: 'mouse_drag'
			readonly from: Point
			readonly to: Point
			readonly button: MouseButton
	  }
	| {
			readonly type: 'scroll'
			readonly at: Point
			readonly direction: ScrollDirection
			readonly amount: number
	  }
	| { readonly type: 'type_text'; readonly text: string }
	| { readonly type: 'key'; readonly keys: string }

export function assertComputerUseActionType(type: ComputerUseAction['type']): void {
	switch (type) {
		case 'screenshot':
		case 'cursor_position':
		case 'mouse_move':
		case 'mouse_click':
		case 'mouse_drag':
		case 'scroll':
		case 'type_text':
		case 'key':
			return
		default: {
			const _exhaustive: never = type
			throw new Error(`Unknown ComputerUseAction type: ${_exhaustive}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Action result — discriminated union matching action types that return data
// ---------------------------------------------------------------------------

export type ComputerUseResult =
	| { readonly type: 'screenshot'; readonly result: ScreenshotResult }
	| { readonly type: 'cursor_position'; readonly point: Point }
	| { readonly type: 'ok' }

/**
 * A state-changing desktop action started, but its subprocess did not report
 * a clean completion. The desktop may already have changed, so treating this
 * as an ordinary failure and automatically replaying the action is unsafe.
 *
 * Host packages throw an error carrying this shape. The SDK recognises it
 * structurally so separately installed host and SDK versions do not need to
 * share an error constructor identity.
 */
export interface ComputerUseOutcomeUnknown {
	readonly code: 'computer_use_outcome_unknown'
	readonly action: ComputerUseAction['type']
	readonly outcome: 'unknown'
	readonly retrySafety: 'unsafe'
	readonly timedOut: boolean
	readonly exitCode: number
	readonly message: string
}

// ---------------------------------------------------------------------------
// Host interface — the core abstraction. Mirrors Sandbox/SandboxProvider shape.
// Implementations live outside @namzu/sdk (e.g. @namzu/computer-use).
// ---------------------------------------------------------------------------

export interface ComputerUseHost {
	readonly id: string
	readonly capabilities: ComputerUseCapabilities

	getDisplayGeometry(): Promise<DisplayGeometry>
	/**
	 * Points in `action` are physical pixels relative to the display of the
	 * most recent capture; a `screenshot` result carries that display in
	 * {@link ScreenshotResult.display}.
	 */
	execute(action: ComputerUseAction): Promise<ComputerUseResult>

	/**
	 * The visible, titled top-level windows, front to back where the platform
	 * knows the order. Offered to the model only with
	 * {@link ComputerUseCapabilities.windows}.
	 */
	listWindows?(): Promise<readonly WindowInfo[]>
	/**
	 * Bring a window to the front, restoring it when minimized. Offered only
	 * with {@link ComputerUseCapabilities.windows}.
	 */
	focusWindow?(id: string): Promise<FocusWindowResult>
	/**
	 * Capture one region of the current display at full physical resolution.
	 * `rect` is display-relative physical pixels; the result's `width` and
	 * `height` are the region's. Used by `zoom` when
	 * {@link ComputerUseCapabilities.regionCapture} is set.
	 */
	captureRegion?(rect: Rect): Promise<ScreenshotResult>
	/**
	 * The accessibility tree of one window, or of the focused window when
	 * `windowId` is omitted. Offered only with {@link ComputerUseCapabilities.uiTree}.
	 *
	 * @experimental
	 */
	uiSnapshot?(windowId?: string): Promise<UiSnapshot>
	/**
	 * Act on an element from the latest {@link uiSnapshot}. `value` is the text
	 * for `set_value`. Offered only with {@link ComputerUseCapabilities.uiTree}.
	 *
	 * @experimental
	 */
	uiAct?(ref: string, action: UiElementAction, value?: string): Promise<UiActResult>

	initialize?(): Promise<void>
	dispose?(): Promise<void>
}
