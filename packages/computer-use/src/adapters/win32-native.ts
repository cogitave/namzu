import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	DisplayInfo,
	Point,
	Rect,
	ScreenshotResult,
} from '@namzu/sdk'
import { type A11yDisplay, A11yError } from '../a11y/interface.js'
import { NativeWinProcess, type NativeWinProcessOptions } from '../native/process.js'
import type { NativeCaptureTarget, NativeInputRequest } from '../native/protocol.js'
import { SpawnError } from '../util/spawn.js'
import { type Adapter, AdapterUnavailableError } from './types.js'

/**
 * The Windows display adapter when the native helper (`namzu-win`) is
 * configured: screenshot, zoom region, click, drag, scroll, type, key,
 * cursor and display geometry, each one request to a helper that is already
 * running. It keeps the host contract the PowerShell adapter keeps (physical
 * pixels, points relative to the display of the last capture) and replaces its
 * process-per-action cost and its scripts with `SendInput` and
 * Windows.Graphics.Capture calls made by a compiled program.
 *
 * There is no PowerShell here, and no fallback to it: when the helper cannot
 * start the adapter does not exist, and the caller is told why.
 */

/** What the helper must report in `hello` for this adapter to use it. */
const REQUIRED_CAPS = ['capture', 'input', 'foreground'] as const

/** How long a helper may take over one display call, ms. */
const REQUEST_MS = 8_000

/** Errors after which the input may already have reached the desktop. */
const OUTCOME_UNKNOWN = new Set(['timeout', 'helper_exited', 'bad_reply', 'input_blocked'])

export interface NativeWin32AdapterOptions extends NativeWinProcessOptions {
	/**
	 * A directory the helper writes pictures into, made when missing. Default:
	 * a new private directory under the system's temporary one, removed on dispose.
	 */
	readonly captureDir?: string
	/**
	 * The path as the helper reads it: under WSL a Linux path goes through the
	 * distro's share. Default: the path as it is.
	 */
	readonly toHelperPath?: (path: string) => string
}

function toDisplayInfo(d: A11yDisplay): DisplayInfo {
	return {
		id: d.id,
		x: d.bounds.x,
		y: d.bounds.y,
		width: d.bounds.width,
		height: d.bounds.height,
		scaleFactor: d.scale,
		primary: d.primary,
	}
}

/** The last part of a path written with either separator. */
function baseName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path
}

export class NativeWin32Adapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities
	readonly backend: string
	private readonly ownsDir: boolean
	/** The display points are relative to: the one of the last capture. */
	private display: DisplayInfo | undefined

	private constructor(
		private readonly process: NativeWinProcess,
		private readonly dir: string,
		private readonly helperDir: string,
		ownsDir: boolean,
		private readonly executable: string,
	) {
		this.ownsDir = ownsDir
		this.backend = `namzu-win ${process.hello?.version ?? ''}`.trim()
		this.capabilities = Object.freeze({
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
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
			mouseClickButtons: Object.freeze(['left', 'right', 'middle'] as const),
			mouseDragButtons: Object.freeze(['left', 'right', 'middle'] as const),
			maxClickCount: 3,
			regionCapture: true,
		})
	}

	/**
	 * Starts the helper and checks it can do what this adapter needs. Throws
	 * {@link AdapterUnavailableError} when it cannot.
	 */
	static async create(options: NativeWin32AdapterOptions): Promise<NativeWin32Adapter> {
		const process = new NativeWinProcess(options)
		if (!(await process.ready())) {
			throw new AdapterUnavailableError(
				`Win32Adapter: the native helper did not start (${options.executable})`,
			)
		}
		const caps = process.hello?.caps ?? []
		const missing = REQUIRED_CAPS.filter((c) => !caps.includes(c))
		if (missing.length > 0) {
			await process.close()
			throw new AdapterUnavailableError(
				`Win32Adapter: the native helper cannot ${missing.join(', ')}; it is older than this program`,
				[...missing],
			)
		}
		const ownsDir = options.captureDir === undefined
		const dir = options.captureDir ?? mkdtempSync(join(tmpdir(), 'namzu-win-'))
		if (!ownsDir) mkdirSync(dir, { recursive: true })
		const helperDir = (options.toHelperPath ?? ((p: string) => p))(dir)
		return new NativeWin32Adapter(process, dir, helperDir, ownsDir, options.executable)
	}

	/**
	 * One input. A helper that stopped answering after it was sent leaves the
	 * desktop in a state nobody knows, which the host reports as an unknown
	 * outcome (the same `SpawnError` the script path throws), never as a
	 * failure that is safe to repeat.
	 */
	private async sendInput(request: NativeInputRequest): Promise<void> {
		try {
			await this.process.request(request, REQUEST_MS)
		} catch (error) {
			if (error instanceof A11yError && OUTCOME_UNKNOWN.has(error.code)) {
				throw new SpawnError(
					`namzu-win input: ${error.message}`,
					{
						exitCode: -1,
						stdout: Buffer.alloc(0),
						stderr: error.message,
						timedOut: error.code === 'timeout',
						signal: null,
					},
					this.executable,
					['input'],
				)
			}
			if (error instanceof A11yError) throw new Error(`namzu-win input: ${error.message}`)
			throw error
		}
	}

	private async displays(): Promise<readonly DisplayInfo[]> {
		const reply = await this.process.request({ op: 'displays' }, REQUEST_MS)
		return reply.displays.map(toDisplayInfo)
	}

	private async primary(): Promise<DisplayInfo> {
		const all = await this.displays()
		const found = all.find((d) => d.primary) ?? all[0]
		if (!found) throw new Error('namzu-win: the helper lists no display')
		return found
	}

	/** The display points are relative to; the primary one before any capture. */
	private async origin(): Promise<DisplayInfo> {
		this.display ??= await this.primary()
		return this.display
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const d = await this.primary()
		this.display = d
		return { width: d.width, height: d.height, scaleFactor: d.scaleFactor }
	}

	/** Takes the picture the helper wrote and removes its file. */
	private takePicture(path: string): Buffer {
		const local = join(this.dir, baseName(path))
		try {
			return readFileSync(local)
		} finally {
			try {
				unlinkSync(local)
			} catch {
				// Already gone.
			}
		}
	}

	private async shot(target: NativeCaptureTarget, region?: Rect): Promise<ScreenshotResult> {
		const picture = await this.process.request(
			{ op: 'capture', target, into: this.helperDir },
			REQUEST_MS,
		)
		if (picture.path === undefined) throw new Error('namzu-win capture: the helper sent no picture')
		const data = this.takePicture(picture.path)
		const all = await this.displays()
		const shown = all.find((d) => d.id === picture.display) ?? all.find((d) => d.primary) ?? all[0]
		if (!shown) throw new Error('namzu-win: the helper lists no display')
		if (!region) this.display = shown
		return {
			data,
			mimeType: 'image/png',
			width: picture.width,
			height: picture.height,
			display: shown,
		}
	}

	async captureRegion(rect: Rect): Promise<ScreenshotResult> {
		// The rectangle is relative to the display of the last capture.
		const origin = await this.origin()
		return this.shot(
			{
				kind: 'region',
				x: origin.x + rect.x,
				y: origin.y + rect.y,
				width: rect.width,
				height: rect.height,
			},
			rect,
		)
	}

	private async absolute(p: Point): Promise<Point> {
		const origin = await this.origin()
		return { x: p.x + origin.x, y: p.y + origin.y }
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot': {
				const primary = await this.primary()
				const result = await this.shot({ kind: 'display', id: primary.id })
				return { type: 'screenshot', result }
			}
			case 'cursor_position': {
				const state = await this.process.request({ op: 'foreground.get' }, REQUEST_MS)
				const origin = await this.origin()
				return {
					type: 'cursor_position',
					point: { x: state.cursor.x - origin.x, y: state.cursor.y - origin.y },
				}
			}
			case 'mouse_move': {
				const to = await this.absolute(action.to)
				await this.sendInput({ op: 'input', kind: 'move', x: to.x, y: to.y })
				return { type: 'ok' }
			}
			case 'mouse_click': {
				const at = await this.absolute(action.at)
				await this.sendInput({
					op: 'input',
					kind: 'click',
					x: at.x,
					y: at.y,
					button: action.button,
					...(action.count !== undefined ? { count: action.count } : {}),
				})
				return { type: 'ok' }
			}
			case 'mouse_drag': {
				const from = await this.absolute(action.from)
				const to = await this.absolute(action.to)
				await this.sendInput({
					op: 'input',
					kind: 'drag',
					x: from.x,
					y: from.y,
					toX: to.x,
					toY: to.y,
					button: action.button,
				})
				return { type: 'ok' }
			}
			case 'scroll': {
				const at = await this.absolute(action.at)
				await this.sendInput({
					op: 'input',
					kind: 'scroll',
					x: at.x,
					y: at.y,
					direction: action.direction,
					amount: action.amount,
				})
				return { type: 'ok' }
			}
			case 'type_text':
				await this.sendInput({ op: 'input', kind: 'type', text: action.text })
				return { type: 'ok' }
			case 'key':
				await this.sendInput({ op: 'input', kind: 'key', keys: action.keys })
				return { type: 'ok' }
		}
	}

	async release(): Promise<void> {
		this.process.release()
	}

	async dispose(): Promise<void> {
		await this.process.close()
		if (this.ownsDir) {
			try {
				rmSync(this.dir, { recursive: true, force: true })
			} catch {
				// Left for the system's temporary-file cleanup.
			}
		}
	}
}
