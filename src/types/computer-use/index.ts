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
}

// ---------------------------------------------------------------------------
// Geometry + screenshot payload
// ---------------------------------------------------------------------------

export interface DisplayGeometry {
	readonly width: number
	readonly height: number
	readonly scaleFactor: number
}

export interface ScreenshotResult {
	readonly data: Buffer
	readonly mimeType: 'image/png'
	readonly width: number
	readonly height: number
}

export interface Point {
	readonly x: number
	readonly y: number
}

export type MouseButton = 'left' | 'right' | 'middle'

export type ScrollDirection = 'up' | 'down' | 'left' | 'right'

// ---------------------------------------------------------------------------
// Action — discriminated union; mirrors Anthropic's computer_20250124 shape
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

// ---------------------------------------------------------------------------
// Host interface — the core abstraction. Mirrors Sandbox/SandboxProvider shape.
// Implementations live outside @namzu/sdk (e.g. @namzu/computer-use).
// ---------------------------------------------------------------------------

export interface ComputerUseHost {
	readonly id: string
	readonly capabilities: ComputerUseCapabilities

	getDisplayGeometry(): Promise<DisplayGeometry>
	execute(action: ComputerUseAction): Promise<ComputerUseResult>

	initialize?(): Promise<void>
	dispose?(): Promise<void>
}
