import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	MouseButton,
	ScrollDirection,
} from '@namzu/sdk'
import { hasExecutable, runCommand, runCommandOrThrow } from '../util/spawn.js'
import { ActionCapabilityError, type Adapter, AdapterUnavailableError } from './types.js'

// Wayland mouse buttons via ydotool's input-event-codes.h numeric range
// (BTN_LEFT = 0x110 = 272). ydotool accepts a friendlier `0xC0:1`/`0xC0:0`
// down/up scheme on modern builds but we use the code:press/release form.
const MOUSE_BUTTON_CODE: Readonly<Record<MouseButton, number>> = {
	left: 0x110,
	right: 0x111,
	middle: 0x112,
}

const SCROLL_BUTTON_ARG: Readonly<Record<ScrollDirection, readonly string[]>> = {
	up: ['--wheel', '1'],
	down: ['--wheel', '-1'],
	left: ['--hwheel', '-1'],
	right: ['--hwheel', '1'],
}

interface ProbeResult {
	readonly hasGrim: boolean
	readonly hasWtype: boolean
	readonly hasYdotool: boolean
	readonly hasWlCopy: boolean
}

async function probe(): Promise<ProbeResult> {
	const [hasGrim, hasWtype, hasYdotool, hasWlCopy] = await Promise.all([
		hasExecutable('grim'),
		hasExecutable('wtype'),
		hasExecutable('ydotool'),
		hasExecutable('wl-copy'),
	])
	return { hasGrim, hasWtype, hasYdotool, hasWlCopy }
}

/**
 * Wayland is the honest-degradation adapter: every capability is probed and
 * reported truthfully, because Wayland's security model makes "mostly working"
 * easy to hide. `ydotool` additionally requires an active `ydotoold` daemon
 * with uinput socket access — we probe only for binary presence here; action
 * time surfaces the daemon/permission error.
 *
 * Cursor position is structurally unavailable on Wayland (no global pointer
 * query API); capability stays false.
 */
export class LinuxWaylandAdapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities
	private readonly hasYdotool: boolean
	private readonly hasWtype: boolean

	private constructor(probeResult: ProbeResult) {
		this.hasYdotool = probeResult.hasYdotool
		this.hasWtype = probeResult.hasWtype
		this.capabilities = Object.freeze({
			displayServer: 'wayland',
			screenshot: probeResult.hasGrim,
			mouse: probeResult.hasYdotool,
			keyboard: probeResult.hasWtype || probeResult.hasYdotool,
			cursorPosition: false,
			clipboard: probeResult.hasWlCopy,
		})
	}

	static async create(): Promise<LinuxWaylandAdapter> {
		const probeResult = await probe()
		// At minimum we need grim for screenshots; input is best-effort and
		// may come online via either wtype or ydotool.
		if (!probeResult.hasGrim && !probeResult.hasWtype && !probeResult.hasYdotool) {
			throw new AdapterUnavailableError(
				'LinuxWaylandAdapter: none of grim, wtype, or ydotool are installed — install via your distro (apt/dnf/pacman)',
				['grim', 'wtype', 'ydotool'],
			)
		}
		return new LinuxWaylandAdapter(probeResult)
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		// No universal Wayland "primary output" CLI. Try `wlr-randr` first for
		// wlroots compositors; fall back to environment defaults.
		const wlrRandr = await runCommand('wlr-randr', [], { timeoutMs: 3_000 }).catch(() => null)
		if (wlrRandr && wlrRandr.exitCode === 0) {
			const parsed = parseWlrRandr(wlrRandr.stdout.toString('utf8'))
			if (parsed) return parsed
		}
		throw new Error(
			'LinuxWaylandAdapter: could not determine display geometry (install wlr-randr or use a wlroots compositor)',
		)
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot':
				return { type: 'screenshot', result: await this.screenshot() }
			case 'cursor_position':
				throw new ActionCapabilityError(
					'cursor_position',
					'cursorPosition',
					'Wayland does not expose a global pointer position API',
				)
			case 'mouse_move':
				this.requireYdotool(action.type)
				await runCommandOrThrow('ydotool', [
					'mousemove',
					'--absolute',
					'-x',
					String(action.to.x),
					'-y',
					String(action.to.y),
				])
				return { type: 'ok' }
			case 'mouse_click':
				this.requireYdotool(action.type)
				await runCommandOrThrow('ydotool', [
					'mousemove',
					'--absolute',
					'-x',
					String(action.at.x),
					'-y',
					String(action.at.y),
				])
				await runCommandOrThrow('ydotool', [
					'click',
					`0x${(0xc0 + buttonIndex(action.button)).toString(16).toUpperCase()}`,
				])
				return { type: 'ok' }
			case 'mouse_drag':
				this.requireYdotool(action.type)
				await this.drag(action.from, action.to, action.button)
				return { type: 'ok' }
			case 'scroll':
				this.requireYdotool(action.type)
				await runCommandOrThrow('ydotool', [
					'mousemove',
					'--absolute',
					'-x',
					String(action.at.x),
					'-y',
					String(action.at.y),
				])
				for (let i = 0; i < action.amount; i++) {
					await runCommandOrThrow('ydotool', ['mousemove', ...SCROLL_BUTTON_ARG[action.direction]])
				}
				return { type: 'ok' }
			case 'type_text':
				if (this.hasWtype) {
					await runCommandOrThrow('wtype', ['--', action.text])
				} else if (this.hasYdotool) {
					await runCommandOrThrow('ydotool', ['type', '--', action.text])
				} else {
					throw new ActionCapabilityError(
						action.type,
						'keyboard',
						'install wtype or ydotool for text input on Wayland',
					)
				}
				return { type: 'ok' }
			case 'key':
				if (this.hasWtype) {
					await runCommandOrThrow('wtype', waylandWtypeKeyArgs(action.keys))
				} else if (this.hasYdotool) {
					await runCommandOrThrow('ydotool', ['key', translateKeyToYdotool(action.keys)])
				} else {
					throw new ActionCapabilityError(
						action.type,
						'keyboard',
						'install wtype or ydotool for key input on Wayland',
					)
				}
				return { type: 'ok' }
		}
	}

	private requireYdotool(action: ComputerUseAction['type']) {
		if (!this.hasYdotool) {
			throw new ActionCapabilityError(
				action,
				'mouse',
				'install ydotool (and start the ydotoold daemon with uinput permissions) for mouse input on Wayland',
			)
		}
	}

	private async screenshot() {
		const result = await runCommandOrThrow('grim', ['-t', 'png', '-'])
		const dims = decodePngDims(result.stdout)
		return {
			data: result.stdout,
			mimeType: 'image/png' as const,
			width: dims.width,
			height: dims.height,
		}
	}

	private async drag(
		from: { x: number; y: number },
		to: { x: number; y: number },
		button: MouseButton,
	) {
		const code = MOUSE_BUTTON_CODE[button]
		await runCommandOrThrow('ydotool', [
			'mousemove',
			'--absolute',
			'-x',
			String(from.x),
			'-y',
			String(from.y),
		])
		await runCommandOrThrow('ydotool', ['mousedown', String(code)])
		await runCommandOrThrow('ydotool', [
			'mousemove',
			'--absolute',
			'-x',
			String(to.x),
			'-y',
			String(to.y),
		])
		await runCommandOrThrow('ydotool', ['mouseup', String(code)])
	}
}

function buttonIndex(button: MouseButton): number {
	// ydotool `click` uses 0xC0 (left), 0xC1 (right), 0xC2 (middle) as
	// convenience aliases for "click" (down+up atomic). Index aligns with
	// the aliases: left=0, right=1, middle=2.
	switch (button) {
		case 'left':
			return 0
		case 'right':
			return 1
		case 'middle':
			return 2
	}
}

export function translateKeyToYdotool(combo: string): string {
	// ydotool key accepts "KEY_NAME:1 KEY_NAME:0" tokens (linux input event
	// names). We translate common aliases; callers pass e.g. "ctrl+c".
	const parts = combo.split('+').map((p) => p.trim().toLowerCase())
	const mapped = parts.map((p) => {
		switch (p) {
			case 'cmd':
			case 'meta':
			case 'super':
			case 'win':
				return 'KEY_LEFTMETA'
			case 'ctrl':
			case 'control':
				return 'KEY_LEFTCTRL'
			case 'alt':
			case 'option':
			case 'opt':
				return 'KEY_LEFTALT'
			case 'shift':
				return 'KEY_LEFTSHIFT'
			case 'enter':
			case 'return':
				return 'KEY_ENTER'
			case 'esc':
			case 'escape':
				return 'KEY_ESC'
			case 'tab':
				return 'KEY_TAB'
			case 'space':
				return 'KEY_SPACE'
			case 'backspace':
				return 'KEY_BACKSPACE'
			case 'delete':
			case 'forward_delete':
				return 'KEY_DELETE'
			case 'up':
				return 'KEY_UP'
			case 'down':
				return 'KEY_DOWN'
			case 'left':
				return 'KEY_LEFT'
			case 'right':
				return 'KEY_RIGHT'
			case 'home':
				return 'KEY_HOME'
			case 'end':
				return 'KEY_END'
			case 'page_up':
				return 'KEY_PAGEUP'
			case 'page_down':
				return 'KEY_PAGEDOWN'
			default:
				if (p.length === 1) {
					const upper = p.toUpperCase()
					if (/[A-Z0-9]/.test(upper)) return `KEY_${upper}`
				}
				return `KEY_${p.toUpperCase()}`
		}
	})
	// ydotool `key` expects press/release pairs: "KEY:1 KEY:0" applied in
	// reverse order for release to model modifier semantics.
	const down = mapped.map((k) => `${k}:1`)
	const up = [...mapped].reverse().map((k) => `${k}:0`)
	return [...down, ...up].join(' ')
}

function waylandWtypeKeyArgs(combo: string): readonly string[] {
	// wtype uses: `-M ctrl -k c -m ctrl` style for modifier combos.
	// Simpler equivalent: `-P KEY -p KEY` while holding `-M MOD` around.
	const parts = combo.split('+').map((p) => p.trim())
	const main = parts[parts.length - 1] ?? ''
	const mods = parts.slice(0, -1)
	const args: string[] = []
	for (const m of mods) args.push('-M', wtypeModName(m))
	args.push('-k', wtypeKeyName(main))
	for (const m of mods.slice().reverse()) args.push('-m', wtypeModName(m))
	return args
}

function wtypeModName(m: string): string {
	switch (m.toLowerCase()) {
		case 'cmd':
		case 'meta':
		case 'super':
		case 'win':
			return 'logo'
		case 'ctrl':
		case 'control':
			return 'ctrl'
		case 'alt':
		case 'option':
		case 'opt':
			return 'alt'
		case 'shift':
			return 'shift'
		default:
			return m
	}
}

function wtypeKeyName(k: string): string {
	switch (k.toLowerCase()) {
		case 'enter':
		case 'return':
			return 'Return'
		case 'esc':
		case 'escape':
			return 'Escape'
		case 'tab':
			return 'Tab'
		case 'space':
			return 'space'
		case 'backspace':
			return 'BackSpace'
		case 'delete':
		case 'forward_delete':
			return 'Delete'
		case 'up':
			return 'Up'
		case 'down':
			return 'Down'
		case 'left':
			return 'Left'
		case 'right':
			return 'Right'
		case 'home':
			return 'Home'
		case 'end':
			return 'End'
		case 'page_up':
			return 'Page_Up'
		case 'page_down':
			return 'Page_Down'
		default:
			return k
	}
}

function parseWlrRandr(output: string): DisplayGeometry | null {
	// wlr-randr emits e.g. "  1920x1080 px, 60.000000 Hz (current)" for the active mode.
	const match = output.match(/(\d+)x(\d+)[^\n]*current/i)
	if (!match) return null
	const width = Number(match[1])
	const height = Number(match[2])
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null
	return { width, height, scaleFactor: 1 }
}

function decodePngDims(buffer: Buffer): { width: number; height: number } {
	if (buffer.length < 24) {
		throw new Error('LinuxWaylandAdapter: screenshot buffer too small to contain PNG header')
	}
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	}
}

export { runCommand as _runCommand }
