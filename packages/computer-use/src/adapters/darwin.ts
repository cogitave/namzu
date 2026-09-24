import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	DisplayInfo,
	Point,
	ScreenshotResult,
} from '@namzu/sdk'
import { hasExecutable, runCommand, runCommandOrThrow } from '../util/spawn.js'
import { ActionCapabilityError, type Adapter, AdapterUnavailableError } from './types.js'

// ---------------------------------------------------------------------------
// Key code table — AppleScript System Events `key code` for non-printable keys.
// Covers the non-printable keys a pointer-and-keyboard tool needs.
// Printable keys go through `keystroke`, not `key code`.
// ---------------------------------------------------------------------------

const KEY_CODES: Readonly<Record<string, number>> = {
	return: 36,
	enter: 76,
	tab: 48,
	space: 49,
	escape: 53,
	esc: 53,
	backspace: 51,
	delete: 51,
	forward_delete: 117,
	left: 123,
	right: 124,
	down: 125,
	up: 126,
	page_up: 116,
	page_down: 121,
	home: 115,
	end: 119,
	f1: 122,
	f2: 120,
	f3: 99,
	f4: 118,
	f5: 96,
	f6: 97,
	f7: 98,
	f8: 100,
	f9: 101,
	f10: 109,
	f11: 103,
	f12: 111,
}

const MODIFIER_ALIASES: Readonly<Record<string, 'command' | 'control' | 'option' | 'shift'>> = {
	cmd: 'command',
	command: 'command',
	meta: 'command',
	super: 'command',
	win: 'command',
	ctrl: 'control',
	control: 'control',
	opt: 'option',
	option: 'option',
	alt: 'option',
	shift: 'shift',
}

interface ParsedKeyCombo {
	readonly modifiers: readonly ('command' | 'control' | 'option' | 'shift')[]
	readonly mainKey: string
}

export function parseKeyCombo(input: string): ParsedKeyCombo {
	const parts = input
		.split('+')
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
	if (parts.length === 0) {
		throw new Error('parseKeyCombo: empty key combo')
	}
	const mainKey = parts[parts.length - 1]
	if (!mainKey) throw new Error(`parseKeyCombo: missing main key in "${input}"`)
	const mods = parts.slice(0, -1).map((m) => {
		const normalized = MODIFIER_ALIASES[m.toLowerCase()]
		if (!normalized) throw new Error(`parseKeyCombo: unknown modifier "${m}"`)
		return normalized
	})
	return { modifiers: mods, mainKey }
}

function modifiersClause(mods: readonly ('command' | 'control' | 'option' | 'shift')[]): string {
	if (mods.length === 0) return ''
	const items = mods.map((m) => `${m} down`)
	const list = items.length === 1 ? items[0] : `{${items.join(', ')}}`
	return ` using ${list}`
}

function escapeAppleScriptString(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

interface ProbeResult {
	readonly hasScreencapture: boolean
	readonly hasOsascript: boolean
	readonly hasPbcopy: boolean
	readonly hasCliclick: boolean
}

async function probe(): Promise<ProbeResult> {
	const [hasScreencapture, hasOsascript, hasPbcopy, hasCliclick] = await Promise.all([
		hasExecutable('screencapture'),
		hasExecutable('osascript'),
		hasExecutable('pbcopy'),
		hasExecutable('cliclick'),
	])
	return { hasScreencapture, hasOsascript, hasPbcopy, hasCliclick }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Units: the host contract is physical pixels. `screencapture` writes the
 * backing store (2880x1800 on a 1440x900-point Retina panel), while
 * `cliclick` and System Events work in points. The conversion happens here
 * and only here: every point going in is divided by pixels-per-point and
 * every point coming out is multiplied by it, once.
 *
 * Pixels-per-point is learned from a capture (its width over the display's
 * width in points), so it is the backing store's own ratio whatever "Looks
 * like" resolution is chosen; `system_profiler`'s panel pixels are not the
 * backing store in a scaled mode. Before the first capture the adapter uses
 * `system_profiler`'s ratio, read once.
 */
export class DarwinAdapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities
	private readonly hasCliclick: boolean
	private geometry: Promise<MainDisplay> | undefined
	/** Captured pixels per point on the main display, from the latest capture. */
	private pixelsPerPoint: number | undefined

	private constructor(probeResult: ProbeResult) {
		this.hasCliclick = probeResult.hasCliclick
		this.capabilities = Object.freeze({
			displayServer: 'darwin',
			screenshot: probeResult.hasScreencapture,
			mouse: probeResult.hasOsascript,
			keyboard: probeResult.hasOsascript,
			cursorPosition: probeResult.hasCliclick,
			clipboard: probeResult.hasPbcopy,
			supportedActions: Object.freeze([
				...(probeResult.hasScreencapture ? ['screenshot' as const] : []),
				...(probeResult.hasOsascript
					? ['mouse_click' as const, 'type_text' as const, 'key' as const]
					: []),
				...(probeResult.hasCliclick
					? ['cursor_position' as const, 'mouse_move' as const, 'mouse_drag' as const]
					: []),
			]),
			mouseClickButtons: Object.freeze(
				probeResult.hasCliclick ? ['left' as const, 'right' as const] : ['left' as const],
			),
			mouseDragButtons: Object.freeze(probeResult.hasCliclick ? ['left' as const] : []),
		})
	}

	static async create(): Promise<DarwinAdapter> {
		const probeResult = await probe()
		const missing: string[] = []
		if (!probeResult.hasScreencapture) missing.push('screencapture')
		if (!probeResult.hasOsascript) missing.push('osascript')
		if (missing.length > 0) {
			throw new AdapterUnavailableError(
				`DarwinAdapter requires ${missing.join(' and ')} (macOS built-ins); not found on PATH`,
				missing,
			)
		}
		return new DarwinAdapter(probeResult)
	}

	/** The main display in physical pixels (the capture's), with pixels per point. */
	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const { logical } = await this.readGeometry()
		const scaleFactor = await this.scale()
		return {
			width: Math.round(logical.width * scaleFactor),
			height: Math.round(logical.height * scaleFactor),
			scaleFactor,
		}
	}

	/** The main display in pixels and in points, read once; a failed read is retried next time. */
	private readGeometry(): Promise<MainDisplay> {
		if (!this.geometry) {
			this.geometry = readMainDisplay().catch((error: unknown) => {
				this.geometry = undefined
				throw error
			})
		}
		return this.geometry
	}

	private async scale(): Promise<number> {
		if (this.pixelsPerPoint !== undefined) return this.pixelsPerPoint
		return (await this.readGeometry()).scaleFactor
	}

	private async toPoints(pixels: Point): Promise<Point> {
		const scale = await this.scale()
		return { x: Math.round(pixels.x / scale), y: Math.round(pixels.y / scale) }
	}

	private async toPixels(points: Point): Promise<Point> {
		const scale = await this.scale()
		return { x: Math.round(points.x * scale), y: Math.round(points.y * scale) }
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot':
				return { type: 'screenshot', result: await this.screenshot() }
			case 'cursor_position':
				return { type: 'cursor_position', point: await this.toPixels(await this.cursorPosition()) }
			case 'mouse_move':
				await this.mouseMove(action.to)
				return { type: 'ok' }
			case 'mouse_click':
				await this.mouseClick(action.at, action.button)
				return { type: 'ok' }
			case 'mouse_drag':
				if (action.button !== 'left')
					throw new ActionCapabilityError(
						'mouse_drag',
						'mouse',
						'macOS drag supports only the left button',
					)
				await this.mouseDrag(action.from, action.to)
				return { type: 'ok' }
			case 'scroll':
				throw new ActionCapabilityError(
					action.type,
					'mouse',
					'scroll is not supported on macOS without a native CoreGraphics binding; use keyboard page navigation instead',
				)
			case 'type_text':
				await this.typeText(action.text)
				return { type: 'ok' }
			case 'key':
				await this.pressKey(action.keys)
				return { type: 'ok' }
		}
	}

	// --- screenshot ---------------------------------------------------------

	private async screenshot(): Promise<ScreenshotResult> {
		const tmpPath = join(tmpdir(), `namzu-cu-${randomUUID()}.png`)
		let data: Buffer
		try {
			// `-m`: the main display only, the one every input tool here addresses.
			await runCommandOrThrow('screencapture', ['-t', 'png', '-x', '-m', tmpPath])
			data = await readFile(tmpPath)
		} finally {
			await unlink(tmpPath).catch(() => undefined)
		}
		const dims = decodePngDims(data)
		const main = await this.readGeometry().catch(() => undefined)
		const ratio = main && main.logical.width > 0 ? dims.width / main.logical.width : 1
		const scaleFactor = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
		if (main) this.pixelsPerPoint = scaleFactor
		const display: DisplayInfo = {
			id: 'main',
			x: 0,
			y: 0,
			width: dims.width,
			height: dims.height,
			scaleFactor,
			primary: true,
		}
		return { data, mimeType: 'image/png', width: dims.width, height: dims.height, display }
	}

	// --- cursor position (requires cliclick) --------------------------------

	/** The cursor in points, as cliclick reports it; {@link execute} converts it. */
	private async cursorPosition(): Promise<Point> {
		if (!this.hasCliclick) {
			throw new ActionCapabilityError(
				'cursor_position',
				'cursorPosition',
				'install `cliclick` (brew install cliclick) to enable cursor position on macOS',
			)
		}
		const result = await runCommandOrThrow('cliclick', ['p'])
		// cliclick p emits "x,y"
		const [xStr, yStr] = result.stdout.toString('utf8').trim().split(',')
		const x = Number(xStr)
		const y = Number(yStr)
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error(
				`DarwinAdapter: unexpected cliclick output "${result.stdout.toString('utf8')}"`,
			)
		}
		return { x, y }
	}

	// --- mouse --------------------------------------------------------------

	// Each takes physical pixels and converts to points after its refusals,
	// so a refused gesture never costs a display read.

	private async mouseMove(pixels: Point) {
		if (this.hasCliclick) {
			const to = await this.toPoints(pixels)
			await runCommandOrThrow('cliclick', [`m:${to.x},${to.y}`])
			return
		}
		throw new ActionCapabilityError(
			'mouse_move',
			'mouse',
			'install `cliclick` (brew install cliclick) to enable mouse move on macOS; click remains available without it',
		)
	}

	private async mouseClick(pixels: Point, button: 'left' | 'right' | 'middle') {
		if (button === 'middle')
			throw new ActionCapabilityError(
				'mouse_click',
				'mouse',
				'middle-click is not supported by this macOS adapter',
			)
		if (!this.hasCliclick && button !== 'left') {
			throw new ActionCapabilityError(
				'mouse_click',
				'mouse',
				`${button}-click requires \`cliclick\` on macOS (osascript only supports left-click)`,
			)
		}
		const at = await this.toPoints(pixels)
		if (this.hasCliclick) {
			const prefix = button === 'right' ? 'rc' : 'c'
			await runCommandOrThrow('cliclick', [`${prefix}:${at.x},${at.y}`])
			return
		}
		const script = `tell application "System Events" to click at {${at.x}, ${at.y}}`
		await runCommandOrThrow('osascript', ['-e', script])
	}

	private async mouseDrag(fromPixels: Point, toPixels: Point) {
		if (!this.hasCliclick) {
			throw new ActionCapabilityError(
				'mouse_drag',
				'mouse',
				'install `cliclick` (brew install cliclick) to enable drag on macOS',
			)
		}
		const from = await this.toPoints(fromPixels)
		const to = await this.toPoints(toPixels)
		await runCommandOrThrow('cliclick', [`dd:${from.x},${from.y}`, `du:${to.x},${to.y}`])
	}

	// --- keyboard -----------------------------------------------------------

	private async typeText(text: string) {
		const escaped = escapeAppleScriptString(text)
		const script = `tell application "System Events" to keystroke "${escaped}"`
		await runCommandOrThrow('osascript', ['-e', script])
	}

	private async pressKey(combo: string) {
		const { modifiers, mainKey } = parseKeyCombo(combo)
		const modifierClause = modifiersClause(modifiers)
		const code = KEY_CODES[mainKey.toLowerCase()]
		if (code !== undefined) {
			const script = `tell application "System Events" to key code ${code}${modifierClause}`
			await runCommandOrThrow('osascript', ['-e', script])
			return
		}
		if (mainKey.length !== 1) {
			throw new Error(
				`DarwinAdapter: unknown key "${mainKey}" — use a named key (see KEY_CODES) or a single character`,
			)
		}
		const escaped = escapeAppleScriptString(mainKey)
		const script = `tell application "System Events" to keystroke "${escaped}"${modifierClause}`
		await runCommandOrThrow('osascript', ['-e', script])
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Size {
	readonly width: number
	readonly height: number
}

/** The main display as `system_profiler` describes it: panel pixels, points, and their ratio. */
interface MainDisplay {
	readonly physical: Size
	readonly logical: Size
	readonly scaleFactor: number
}

/** The main display from `system_profiler`: its pixels, its points, and their ratio. */
async function readMainDisplay(): Promise<MainDisplay> {
	const result = await runCommandOrThrow('system_profiler', ['-json', 'SPDisplaysDataType'])
	const parsed = JSON.parse(result.stdout.toString('utf8')) as {
		SPDisplaysDataType?: readonly {
			spdisplays_ndrvs?: readonly {
				_spdisplays_resolution?: string
				_spdisplays_pixels?: string
			}[]
		}[]
	}
	const primary = parsed.SPDisplaysDataType?.[0]?.spdisplays_ndrvs?.[0]
	if (!primary) {
		throw new Error('DarwinAdapter: could not parse display geometry from system_profiler')
	}
	const physical = parsePixelDims(primary._spdisplays_pixels ?? primary._spdisplays_resolution)
	const logical = parsePixelDims(primary._spdisplays_resolution)
	if (!physical || !logical) {
		throw new Error('DarwinAdapter: missing pixel/resolution fields in system_profiler output')
	}
	const ratio = logical.width > 0 ? physical.width / logical.width : 1
	return { physical, logical, scaleFactor: Number.isFinite(ratio) && ratio > 0 ? ratio : 1 }
}

function parsePixelDims(value: string | undefined): { width: number; height: number } | null {
	if (!value) return null
	// system_profiler emits e.g. "2560 x 1600" or "2560 x 1600 @ 60.00Hz"
	const match = value.match(/(\d+)\s*x\s*(\d+)/i)
	if (!match) return null
	const width = Number(match[1])
	const height = Number(match[2])
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null
	return { width, height }
}

/**
 * Minimal PNG IHDR decode: bytes 16..23 hold width/height big-endian u32.
 * Avoids pulling in an image library for a simple dimensions read.
 */
function decodePngDims(buffer: Buffer): { width: number; height: number } {
	if (buffer.length < 24) {
		throw new Error('DarwinAdapter: screenshot buffer too small to contain PNG header')
	}
	const width = buffer.readUInt32BE(16)
	const height = buffer.readUInt32BE(20)
	return { width, height }
}

// Re-export for diagnostics / tests
export { runCommand as _runCommand }
