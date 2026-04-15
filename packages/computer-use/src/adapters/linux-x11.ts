import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	MouseButton,
	Point,
	ScrollDirection,
} from '@namzu/sdk'
import { hasExecutable, runCommand, runCommandOrThrow } from '../util/spawn.js'
import { type Adapter, AdapterUnavailableError } from './types.js'

const MOUSE_BUTTON_CODE: Readonly<Record<MouseButton, string>> = {
	left: '1',
	middle: '2',
	right: '3',
}

// xdotool scroll = button 4 (up) / 5 (down) / 6 (left) / 7 (right)
const SCROLL_BUTTON_CODE: Readonly<Record<ScrollDirection, string>> = {
	up: '4',
	down: '5',
	left: '6',
	right: '7',
}

interface ProbeResult {
	readonly hasXdotool: boolean
	readonly hasMaim: boolean
	readonly hasXrandr: boolean
	readonly hasXclip: boolean
}

async function probe(): Promise<ProbeResult> {
	const [hasXdotool, hasMaim, hasXrandr, hasXclip] = await Promise.all([
		hasExecutable('xdotool'),
		hasExecutable('maim'),
		hasExecutable('xrandr'),
		hasExecutable('xclip'),
	])
	return { hasXdotool, hasMaim, hasXrandr, hasXclip }
}

export class LinuxX11Adapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities

	private constructor(probeResult: ProbeResult) {
		this.capabilities = Object.freeze({
			displayServer: 'x11',
			screenshot: probeResult.hasMaim,
			mouse: probeResult.hasXdotool,
			keyboard: probeResult.hasXdotool,
			cursorPosition: probeResult.hasXdotool,
			clipboard: probeResult.hasXclip,
		})
	}

	static async create(): Promise<LinuxX11Adapter> {
		const probeResult = await probe()
		const missing: string[] = []
		if (!probeResult.hasXdotool) missing.push('xdotool')
		if (!probeResult.hasMaim) missing.push('maim')
		if (missing.length > 0) {
			throw new AdapterUnavailableError(
				`LinuxX11Adapter requires ${missing.join(' and ')} — install via your package manager (apt/dnf/pacman)`,
				missing,
			)
		}
		return new LinuxX11Adapter(probeResult)
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const geom = await runCommandOrThrow('xdotool', ['getdisplaygeometry'])
		const [wStr, hStr] = geom.stdout.toString('utf8').trim().split(/\s+/)
		const width = Number(wStr)
		const height = Number(hStr)
		if (!Number.isFinite(width) || !Number.isFinite(height)) {
			throw new Error(
				`LinuxX11Adapter: unexpected xdotool getdisplaygeometry output: ${geom.stdout.toString('utf8')}`,
			)
		}
		const scaleFactor = await this.detectScaleFactor()
		return { width, height, scaleFactor }
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot':
				return { type: 'screenshot', result: await this.screenshot() }
			case 'cursor_position':
				return { type: 'cursor_position', point: await this.cursorPosition() }
			case 'mouse_move':
				await runCommandOrThrow('xdotool', ['mousemove', String(action.to.x), String(action.to.y)])
				return { type: 'ok' }
			case 'mouse_click':
				await runCommandOrThrow('xdotool', [
					'mousemove',
					String(action.at.x),
					String(action.at.y),
					'click',
					MOUSE_BUTTON_CODE[action.button],
				])
				return { type: 'ok' }
			case 'mouse_drag':
				await this.mouseDrag(action.from, action.to, action.button)
				return { type: 'ok' }
			case 'scroll':
				await this.scroll(action.at, action.direction, action.amount)
				return { type: 'ok' }
			case 'type_text':
				await runCommandOrThrow('xdotool', ['type', '--delay', '12', '--', action.text])
				return { type: 'ok' }
			case 'key':
				await runCommandOrThrow('xdotool', ['key', '--', translateKeyCombo(action.keys)])
				return { type: 'ok' }
		}
	}

	private async screenshot() {
		const result = await runCommandOrThrow('maim', ['-f', 'png'])
		const dims = decodePngDims(result.stdout)
		return {
			data: result.stdout,
			mimeType: 'image/png' as const,
			width: dims.width,
			height: dims.height,
		}
	}

	private async cursorPosition(): Promise<Point> {
		const result = await runCommandOrThrow('xdotool', ['getmouselocation', '--shell'])
		const text = result.stdout.toString('utf8')
		const x = Number(text.match(/^X=(-?\d+)$/m)?.[1])
		const y = Number(text.match(/^Y=(-?\d+)$/m)?.[1])
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error(`LinuxX11Adapter: unexpected getmouselocation output: ${text}`)
		}
		return { x, y }
	}

	private async mouseDrag(from: Point, to: Point, button: MouseButton) {
		const btn = MOUSE_BUTTON_CODE[button]
		await runCommandOrThrow('xdotool', [
			'mousemove',
			String(from.x),
			String(from.y),
			'mousedown',
			btn,
			'mousemove',
			String(to.x),
			String(to.y),
			'mouseup',
			btn,
		])
	}

	private async scroll(at: Point, direction: ScrollDirection, amount: number) {
		const btn = SCROLL_BUTTON_CODE[direction]
		const args = ['mousemove', String(at.x), String(at.y), 'click', '--repeat', String(amount), btn]
		await runCommandOrThrow('xdotool', args)
	}

	private async detectScaleFactor(): Promise<number> {
		// X11 has no single scale factor for all displays; return 1 as the
		// documented default. xrandr can report dpi per-output but scaling is
		// a desktop-environment concept (GNOME/KDE/Sway) that varies and
		// Rust-equivalent tools don't solve either.
		return 1
	}
}

function translateKeyCombo(combo: string): string {
	// xdotool uses '+' separators directly and mostly understands the same names.
	// Normalise the few aliases where our input diverges.
	const parts = combo
		.split('+')
		.map((p) => p.trim())
		.filter(Boolean)
	const normalised = parts.map((p) => {
		const lower = p.toLowerCase()
		switch (lower) {
			case 'cmd':
			case 'command':
			case 'meta':
			case 'super':
			case 'win':
				return 'super'
			case 'ctrl':
			case 'control':
				return 'ctrl'
			case 'opt':
			case 'option':
			case 'alt':
				return 'alt'
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
			case 'up':
				return 'Up'
			case 'down':
				return 'Down'
			case 'left':
				return 'Left'
			case 'right':
				return 'Right'
			case 'backspace':
				return 'BackSpace'
			case 'delete':
				return 'Delete'
			case 'forward_delete':
				return 'Delete'
			case 'home':
				return 'Home'
			case 'end':
				return 'End'
			case 'page_up':
				return 'Page_Up'
			case 'page_down':
				return 'Page_Down'
			default:
				return p
		}
	})
	return normalised.join('+')
}

function decodePngDims(buffer: Buffer): { width: number; height: number } {
	if (buffer.length < 24) {
		throw new Error('LinuxX11Adapter: screenshot buffer too small to contain PNG header')
	}
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	}
}

export { translateKeyCombo as _translateKeyCombo, runCommand as _runCommand }
