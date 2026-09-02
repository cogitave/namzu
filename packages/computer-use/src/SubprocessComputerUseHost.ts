import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
} from '@namzu/sdk'
import { type Adapter, AdapterUnavailableError } from './adapters/types.js'
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
}

/**
 * Subprocess-backed ComputerUseHost. Delegates platform-specific work to
 * adapters that spawn system CLIs (`screencapture`, `osascript`, `xdotool`,
 * `maim`, `grim`, PowerShell). The child-process model side-steps the macOS
 * CFRunLoop pump problem that blocks in-process native addons under
 * Node/libuv — each subprocess owns its own main thread.
 *
 * Lifecycle: `initialize()` probes the environment and selects the adapter.
 * Until then, `capabilities.displayServer` reflects detection but every
 * feature flag is `false`, and `execute` throws.
 */
export class SubprocessComputerUseHost implements ComputerUseHost {
	readonly id = 'subprocess-computer-use-host'
	private _capabilities: ComputerUseCapabilities
	private adapter: Adapter | null = null

	constructor(options: SubprocessComputerUseHostOptions = {}) {
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

	async initialize(): Promise<void> {
		if (this.adapter) return
		const displayServer = this._capabilities.displayServer
		const adapter = await loadAdapter(displayServer)
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
			const reason = error instanceof Error ? error.message : String(error)
			throw new AdapterUnavailableError(
				`SubprocessComputerUseHost: the ${displayServer} adapter loaded but the desktop did not answer: ${reason}`,
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

	async dispose(): Promise<void> {
		this.adapter = null
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

async function loadAdapter(
	displayServer: ComputerUseCapabilities['displayServer'],
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
			return Win32Adapter.create()
		}
		case 'unknown':
			throw new Error(
				`SubprocessComputerUseHost: no adapter available for displayServer="${displayServer}" yet`,
			)
	}
}
