import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
} from '@namzu/sdk'
import type { Adapter } from './adapters/types.js'
import { detectDisplayServer } from './detect/index.js'

const UNINITIALISED_CAPABILITIES: ComputerUseCapabilities = {
	displayServer: 'unknown',
	screenshot: false,
	mouse: false,
	keyboard: false,
	cursorPosition: false,
	clipboard: false,
}

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
		this.adapter = adapter
		this._capabilities = adapter.capabilities
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const adapter = this.requireAdapter()
		return adapter.getDisplayGeometry()
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		const adapter = this.requireAdapter()
		return adapter.execute(action)
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
