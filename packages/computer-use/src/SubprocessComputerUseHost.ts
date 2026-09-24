import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
	FocusWindowResult,
	Rect,
	ScreenshotResult,
	UiActResult,
	UiElementAction,
	UiSnapshot,
	WindowInfo,
} from '@namzu/sdk'
import { type Adapter, AdapterUnavailableError } from './adapters/types.js'
import type { Win32AdapterOptions } from './adapters/win32.js'
import { detectDisplayServer } from './detect/index.js'
import { ComputerUseOutcomeUnknownError } from './errors.js'
import { SpawnError } from './util/spawn.js'

const UNINITIALISED_CAPABILITIES: ComputerUseCapabilities = {
	displayServer: 'unknown',
	screenshot: false,
	mouse: false,
	keyboard: false,
	cursorPosition: false,
	clipboard: false,
}

const UNSAFE_TO_REPLAY_AFTER_START = new Set<ComputerUseAction['type']>([
	'mouse_click',
	'mouse_drag',
	'scroll',
	'type_text',
	'key',
])

export interface SubprocessComputerUseHostOptions {
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	/**
	 * Inject a pre-constructed adapter, bypassing platform detection. Primarily
	 * for tests; production usage should rely on `initialize()` to select the
	 * correct adapter automatically.
	 */
	readonly adapter?: Adapter
	/**
	 * The Windows backend (WSL included): cua-driver, pinned and downloaded on
	 * first use, with the PowerShell path as its fallback. See the README.
	 */
	readonly windows?: SubprocessComputerUseHostWindowsOptions
}

export type SubprocessComputerUseHostWindowsOptions = Pick<
	Win32AdapterOptions,
	'backend' | 'cuaDriverPath' | 'cacheDir' | 'download'
>

/**
 * Subprocess-backed ComputerUseHost. Delegates platform-specific work to
 * adapters that spawn system CLIs (`screencapture`, `osascript`, `xdotool`,
 * `maim`, `grim`, PowerShell) or, on Windows, keep one cua-driver process.
 * The child-process model side-steps the macOS CFRunLoop pump problem that
 * blocks in-process native addons under Node/libuv — each subprocess owns
 * its own main thread.
 *
 * Lifecycle: `initialize()` probes the environment and selects the adapter.
 * Until then, `capabilities.displayServer` reflects detection but every
 * feature flag is `false`, and `execute` throws. `dispose()` stops what the
 * adapter keeps running.
 */
export class SubprocessComputerUseHost implements ComputerUseHost {
	readonly id = 'subprocess-computer-use-host'
	private _capabilities: ComputerUseCapabilities
	private adapter: Adapter | null = null

	constructor(private readonly options: SubprocessComputerUseHostOptions = {}) {
		const displayServer = detectDisplayServer(options.env, options.platform)
		this._capabilities = Object.freeze({
			...UNINITIALISED_CAPABILITIES,
			displayServer,
		})
		if (options.adapter) {
			this.adapter = options.adapter
			this._capabilities = options.adapter.capabilities
		}
	}

	get capabilities(): ComputerUseCapabilities {
		return this._capabilities
	}

	/**
	 * What drives the desktop once initialised — `cua-driver 0.28.2`,
	 * `powershell`, … — for logs and diagnosis. Undefined before
	 * `initialize()` and for adapters that do not say.
	 */
	get backend(): string | undefined {
		return this.adapter?.backend
	}

	/** Why the preferred backend is not the one in use, when the adapter fell back. */
	get fallbackReason(): string | undefined {
		return this.adapter?.fallbackReason
	}

	async initialize(): Promise<void> {
		if (this.adapter) return
		const displayServer = this._capabilities.displayServer
		const adapter = await loadAdapter(displayServer, this.options)
		// Loading an adapter proves its tools exist on PATH, not that a desktop
		// answers. A WSL process finds PowerShell and still may have no
		// interactive Windows session to capture; an ssh session finds xdotool
		// and no display. The host used to become "ready" on the first and let
		// every later action fail the same way — and a model that reads the
		// same error asks again. One cheap read here turns that into "computer
		// use is unavailable on this device" before any tool is mounted.
		try {
			await adapter.getDisplayGeometry()
		} catch (error) {
			await adapter.dispose?.().catch(() => undefined)
			const reason = error instanceof Error ? error.message : String(error)
			const fallback = adapter.fallbackReason
				? ` (cua-driver was not used: ${adapter.fallbackReason})`
				: ''
			throw new AdapterUnavailableError(
				`SubprocessComputerUseHost: the ${displayServer} adapter loaded but the desktop did not answer: ${reason}${fallback}`,
			)
		}
		this.adapter = adapter
		this._capabilities = adapter.capabilities
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const adapter = this.requireAdapter()
		return adapter.getDisplayGeometry()
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		const adapter = this.requireAdapter()
		try {
			return await adapter.execute(action)
		} catch (error) {
			// SpawnError is produced only after the subprocess started and then
			// timed out or closed non-zero. An unsafe action may have taken effect
			// before that terminal status (a multi-command drag is the clearest
			// example), so replaying it could duplicate or compound the change.
			// A raw spawn error means the process never established that boundary;
			// safe reads and idempotent mouse_move keep their ordinary diagnosis.
			if (error instanceof SpawnError && UNSAFE_TO_REPLAY_AFTER_START.has(action.type)) {
				throw new ComputerUseOutcomeUnknownError(action.type, error)
			}
			throw error
		}
	}

	/** Offered to the model only when `capabilities.windows` is true. */
	async listWindows(): Promise<readonly WindowInfo[]> {
		const adapter = this.requireAdapter()
		if (!adapter.listWindows) throw unsupported('listWindows', this._capabilities.displayServer)
		return adapter.listWindows()
	}

	/** Offered to the model only when `capabilities.windows` is true. */
	async focusWindow(id: string): Promise<FocusWindowResult> {
		const adapter = this.requireAdapter()
		if (!adapter.focusWindow) throw unsupported('focusWindow', this._capabilities.displayServer)
		return adapter.focusWindow(id)
	}

	/** Offered to the model only when `capabilities.regionCapture` is true. */
	async captureRegion(rect: Rect): Promise<ScreenshotResult> {
		const adapter = this.requireAdapter()
		if (!adapter.captureRegion) throw unsupported('captureRegion', this._capabilities.displayServer)
		return adapter.captureRegion(rect)
	}

	/**
	 * A window's controls. Offered to the model only when
	 * `capabilities.uiTree` is true.
	 *
	 * @experimental Follows the SDK's UI-tree surface.
	 */
	async uiSnapshot(windowId?: string): Promise<UiSnapshot> {
		const adapter = this.requireAdapter()
		if (!adapter.uiSnapshot) throw unsupported('uiSnapshot', this._capabilities.displayServer)
		return adapter.uiSnapshot(windowId)
	}

	/**
	 * Act on a control of the latest {@link uiSnapshot}. A request lost after
	 * it was sent (the driver died or stopped answering) may have acted, so
	 * it is reported as not done with an unknown outcome, never retried.
	 *
	 * @experimental Follows the SDK's UI-tree surface.
	 */
	async uiAct(ref: string, action: UiElementAction, value?: string): Promise<UiActResult> {
		const adapter = this.requireAdapter()
		if (!adapter.uiAct) throw unsupported('uiAct', this._capabilities.displayServer)
		try {
			return await adapter.uiAct(ref, action, value)
		} catch (error) {
			if (error instanceof SpawnError)
				return {
					ok: false,
					detail: `the desktop driver stopped before it answered, so ${action} may or may not have happened; look at the screen (ui_snapshot or screenshot) before trying again. ${error.message}`,
				}
			throw error
		}
	}

	/** Stops whatever the adapter keeps running (the Windows cua-driver process). */
	async dispose(): Promise<void> {
		const adapter = this.adapter
		this.adapter = null
		await adapter?.dispose?.()
	}

	private requireAdapter(): Adapter {
		if (!this.adapter) {
			throw new Error(
				'SubprocessComputerUseHost: adapter not initialised — call `await host.initialize()` first',
			)
		}
		return this.adapter
	}
}

function unsupported(method: string, displayServer: string): Error {
	return new Error(
		`SubprocessComputerUseHost: ${method} is not supported by the ${displayServer} adapter in use.`,
	)
}

async function loadAdapter(
	displayServer: ComputerUseCapabilities['displayServer'],
	options: SubprocessComputerUseHostOptions,
): Promise<Adapter> {
	switch (displayServer) {
		case 'darwin': {
			const { DarwinAdapter } = await import('./adapters/darwin.js')
			return DarwinAdapter.create()
		}
		case 'x11': {
			const { LinuxX11Adapter } = await import('./adapters/linux-x11.js')
			return LinuxX11Adapter.create()
		}
		case 'wayland': {
			const { LinuxWaylandAdapter } = await import('./adapters/linux-wayland.js')
			return LinuxWaylandAdapter.create()
		}
		case 'win32': {
			const { Win32Adapter } = await import('./adapters/win32.js')
			return Win32Adapter.create({
				...options.windows,
				...(options.env !== undefined ? { env: options.env } : {}),
				...(options.platform !== undefined ? { platform: options.platform } : {}),
			})
		}
		case 'unknown':
			throw new Error(
				`SubprocessComputerUseHost: no adapter available for displayServer="${displayServer}" yet`,
			)
	}
}
