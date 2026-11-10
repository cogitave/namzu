import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseResult,
	ComputerUseSettleRequest,
	ComputerUseSettleResult,
	DisplayGeometry,
	FocusWindowResult,
	Rect,
	ScreenshotResult,
	UiActResult,
	UiElementAction,
	UiSnapshot,
	UiSnapshotOptions,
	WindowInfo,
	WindowInputAction,
	WindowInputResult,
	WindowScreenshotResult,
} from '@namzu/sdk'
import { type AccessibilityBackend, createWindowsA11yHost } from './a11y/index.js'
import { type Adapter, AdapterUnavailableError } from './adapters/types.js'
import type { Win32AdapterOptions } from './adapters/win32.js'
import { detectDisplayServer } from './detect/index.js'
import {
	ComputerUseLockedError,
	ComputerUseOutcomeUnknownError,
	ComputerUseStoppedError,
	LOCKED_TEXT,
} from './errors.js'
import {
	type ForegroundApprover,
	type ForegroundLadder,
	type LadderTiming,
	createWindowsForegroundLadder,
} from './foreground/index.js'
import { type Presence, createWindowsPresence } from './presence/index.js'
import { CallAbortedError, inCallScope } from './util/call-scope.js'
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
	/**
	 * The foreground ladder: how an action that can only be delivered in the
	 * foreground uses the user's screen. On Windows it is on by default.
	 */
	readonly foreground?: SubprocessComputerUseHostForegroundOptions
	/**
	 * The agent cursor and the border around the window being operated. On by
	 * default on Windows; `false` turns them off, as does the environment
	 * variable `NAMZU_COMPUTER_USE_PRESENCE=off`. A ready overlay replaces the
	 * one built for this machine (for tests).
	 */
	readonly presence?: boolean | Presence
	/**
	 * The resident accessibility host (Windows, with the driver backend): the
	 * window list and the wait for a window to settle after an input come from
	 * it, and the driver answers whenever it cannot. On by default; `false`
	 * turns it off, as does the environment variable
	 * `NAMZU_COMPUTER_USE_A11Y=off`. A ready backend replaces the one built
	 * for this machine (for tests).
	 */
	readonly a11y?: boolean | AccessibilityBackend
}

export interface SubprocessComputerUseHostForegroundOptions {
	/**
	 * Asks the person, once, whether an application may use the screen for a
	 * moment while they are busy. Absent (or answering `unavailable`), a run
	 * with nobody to ask waits and retries within a bound instead.
	 */
	readonly approve?: ForegroundApprover
	/** Names this session in the screen lease. */
	readonly session?: string
	/** Overrides for the thresholds and bounds; see `DEFAULT_TIMING`. */
	readonly timing?: Partial<LadderTiming>
	/** A ready ladder, instead of the one built for this machine. For tests. */
	readonly ladder?: ForegroundLadder
}

export type SubprocessComputerUseHostWindowsOptions = Pick<
	Win32AdapterOptions,
	'backend' | 'cuaDriverPath' | 'cacheDir' | 'download' | 'onNotice'
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
	private ladder: ForegroundLadder | undefined
	private presence: Presence | undefined
	private a11y: AccessibilityBackend | undefined

	constructor(private readonly options: SubprocessComputerUseHostOptions = {}) {
		const displayServer = detectDisplayServer(options.env, options.platform)
		this._capabilities = Object.freeze({
			...UNINITIALISED_CAPABILITIES,
			displayServer,
		})
		this.ladder = options.foreground?.ladder
		if (options.adapter) {
			this.adapter = options.adapter
			this._capabilities = options.adapter.capabilities
		}
	}

	get capabilities(): ComputerUseCapabilities {
		return this._capabilities
	}

	/**
	 * What drives the desktop once initialised — `cua-driver 0.38.0`,
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
		if (!this.ladder && displayServer === 'win32') {
			this.ladder = createWindowsForegroundLadder({
				...(this.options.env !== undefined ? { env: this.options.env } : {}),
				...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
				...(this.options.foreground?.approve ? { approve: this.options.foreground.approve } : {}),
				...(this.options.foreground?.session ? { session: this.options.foreground.session } : {}),
				...(this.options.foreground?.timing ? { timing: this.options.foreground.timing } : {}),
			})
		}
		if (!this.presence && displayServer === 'win32') {
			const option = this.options.presence
			this.presence =
				typeof option === 'object'
					? option
					: createWindowsPresence({
							...(this.options.env !== undefined ? { env: this.options.env } : {}),
							...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
							...(option === false ? { enabled: false } : {}),
						})
		}
		if (!this.a11y && displayServer === 'win32') {
			const option = this.options.a11y
			this.a11y =
				typeof option === 'object'
					? option
					: createWindowsA11yHost({
							...(this.options.env !== undefined ? { env: this.options.env } : {}),
							...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
							...(option === false ? { enabled: false } : {}),
						})
		}
		const adapter = await loadAdapter(
			displayServer,
			this.options,
			this.ladder,
			this.presence,
			this.a11y,
		)
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

	async execute(action: ComputerUseAction, signal?: AbortSignal): Promise<ComputerUseResult> {
		const adapter = this.requireAdapter()
		const read = action.type === 'screenshot' || action.type === 'cursor_position'
		return this.scoped(
			signal,
			async () => {
				if (await this.locked()) {
					if (read) throw new ComputerUseLockedError()
					return {
						type: 'ok',
						delivery: 'not_delivered',
						retrySafety: 'safe',
						detail: LOCKED_TEXT,
					}
				}
				try {
					const result = await adapter.execute(action)
					if (action.type === 'screenshot') await this.notCapturedLocked()
					return result
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
			},
			read
				? undefined
				: (sent): ComputerUseResult => ({
						type: 'ok',
						...abortedDelivery(sent),
					}),
		)
	}

	/** Offered to the model only when `capabilities.windows` is true. */
	async listWindows(signal?: AbortSignal): Promise<readonly WindowInfo[]> {
		const adapter = this.requireAdapter()
		if (!adapter.listWindows) throw unsupported('listWindows', this._capabilities.displayServer)
		return this.scoped(signal, async () => {
			await this.refuseWhenLocked()
			return (adapter.listWindows as NonNullable<Adapter['listWindows']>)()
		})
	}

	/** Offered to the model only when `capabilities.windows` is true. */
	async focusWindow(id: string, signal?: AbortSignal): Promise<FocusWindowResult> {
		const adapter = this.requireAdapter()
		if (!adapter.focusWindow) throw unsupported('focusWindow', this._capabilities.displayServer)
		return this.scoped(
			signal,
			async () => {
				if (await this.locked())
					return {
						ok: false,
						focusedId: null,
						delivery: 'not_delivered',
						retrySafety: 'safe',
						detail: LOCKED_TEXT,
					}
				return (adapter.focusWindow as NonNullable<Adapter['focusWindow']>)(id)
			},
			(sent): FocusWindowResult => ({
				ok: false,
				focusedId: null,
				...abortedDelivery(sent),
			}),
		)
	}

	/** Window-local PNG and input, only when the selected adapter supports both. */
	async captureWindow(id: string, signal?: AbortSignal): Promise<WindowScreenshotResult> {
		const adapter = this.requireAdapter()
		if (!adapter.captureWindow) throw unsupported('captureWindow', this._capabilities.displayServer)
		return this.scoped(signal, async () => {
			await this.refuseWhenLocked()
			const shot = await (adapter.captureWindow as NonNullable<Adapter['captureWindow']>)(id)
			await this.notCapturedLocked()
			return shot
		})
	}

	async executeWindow(
		captureId: string,
		action: WindowInputAction,
		signal?: AbortSignal,
	): Promise<WindowInputResult | undefined> {
		const adapter = this.requireAdapter()
		if (!adapter.executeWindow) throw unsupported('executeWindow', this._capabilities.displayServer)
		return this.scoped(
			signal,
			async () => {
				if (await this.locked())
					return {
						delivery: 'not_delivered',
						retrySafety: 'safe',
						detail: LOCKED_TEXT,
					}
				try {
					return await (adapter.executeWindow as NonNullable<Adapter['executeWindow']>)(
						captureId,
						action,
					)
				} catch (error) {
					if (error instanceof SpawnError && UNSAFE_TO_REPLAY_AFTER_START.has(action.type))
						throw new ComputerUseOutcomeUnknownError(action.type, error)
					throw error
				}
			},
			(sent): WindowInputResult => abortedDelivery(sent),
		)
	}

	/**
	 * Waits for the window the last input went to to stop changing, in place
	 * of the tool's fixed pause. Undefined whenever the adapter cannot say
	 * (the driver backend without its accessibility host, any other platform).
	 */
	async settle(
		request: ComputerUseSettleRequest,
		signal?: AbortSignal,
	): Promise<ComputerUseSettleResult | undefined> {
		const adapter = this.adapter
		if (!adapter?.settleAfterInput) return undefined
		return adapter.settleAfterInput(request, signal)
	}

	/** Offered to the model only when `capabilities.regionCapture` is true. */
	async captureRegion(rect: Rect, signal?: AbortSignal): Promise<ScreenshotResult> {
		const adapter = this.requireAdapter()
		if (!adapter.captureRegion) throw unsupported('captureRegion', this._capabilities.displayServer)
		return this.scoped(signal, async () => {
			await this.refuseWhenLocked()
			const shot = await (adapter.captureRegion as NonNullable<Adapter['captureRegion']>)(rect)
			await this.notCapturedLocked()
			return shot
		})
	}

	/**
	 * A window's controls. Offered to the model only when
	 * `capabilities.uiTree` is true.
	 *
	 * @experimental Follows the SDK's UI-tree surface.
	 */
	async uiSnapshot(
		windowId?: string,
		options?: UiSnapshotOptions,
		signal?: AbortSignal,
	): Promise<UiSnapshot> {
		const adapter = this.requireAdapter()
		if (!adapter.uiSnapshot) throw unsupported('uiSnapshot', this._capabilities.displayServer)
		return this.scoped(signal, async () => {
			await this.refuseWhenLocked()
			return (adapter.uiSnapshot as NonNullable<Adapter['uiSnapshot']>)(windowId, options)
		})
	}

	/**
	 * Act on a control of the latest {@link uiSnapshot}. A request lost after
	 * it was sent (the driver died or stopped answering) may have acted, so
	 * it is reported as not done with an unknown outcome, never retried.
	 *
	 * @experimental Follows the SDK's UI-tree surface.
	 */
	async uiAct(
		ref: string,
		action: UiElementAction,
		value?: string,
		signal?: AbortSignal,
	): Promise<UiActResult> {
		const adapter = this.requireAdapter()
		if (!adapter.uiAct) throw unsupported('uiAct', this._capabilities.displayServer)
		return this.scoped(
			signal,
			async () => {
				if (await this.locked())
					return {
						ok: false,
						delivery: 'not_delivered',
						retrySafety: 'safe',
						detail: LOCKED_TEXT,
					}
				try {
					return await (adapter.uiAct as NonNullable<Adapter['uiAct']>)(ref, action, value)
				} catch (error) {
					if (error instanceof SpawnError)
						return {
							ok: false,
							delivery: 'delivered_unverified',
							retrySafety: 'unsafe',
							detail: `the desktop driver stopped before it answered, so ${action} may or may not have happened; look at the screen (ui_snapshot or screenshot) before trying again. ${error.message}`,
						}
					throw error
				}
			},
			(sent): UiActResult => ({ ok: false, ...abortedDelivery(sent) }),
		)
	}

	/** Stops whatever the adapter keeps running (the Windows cua-driver process). */
	async dispose(): Promise<void> {
		const adapter = this.adapter
		this.adapter = null
		await adapter?.dispose?.()
		await this.ladder?.dispose()
		await this.presence?.dispose()
		await this.a11y?.close()
	}

	/**
	 * The model's turn is making a tool call. A new turn lifts an Escape stop.
	 */
	beginTurn(turnId: string): void {
		this.ladder?.beginTurn(turnId)
	}

	/** The turn ended or was interrupted: the input monitor and any lease are released. */
	async endTurn(): Promise<void> {
		await this.ladder?.endTurn()
		this.presence?.hide()
	}

	/**
	 * One tool call: its cancellation reaches every driver call and foreground
	 * burst made for it. When cancelled, a call that changes the desktop answers
	 * at once with what is known (`onAbort`, told whether anything may have been
	 * sent); a read has no answer to give and throws.
	 */
	private async scoped<T>(
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
		onAbort?: (sent: boolean) => T,
	): Promise<T> {
		return inCallScope(signal, async (scope) => {
			try {
				return await run()
			} catch (error) {
				if (!(error instanceof CallAbortedError)) throw error
				if (!onAbort) throw error
				return onAbort(scope.sent || error.sent)
			}
		})
	}

	/** True when the computer is known to be locked; false when it is not or cannot be told. */
	private async locked(): Promise<boolean> {
		if (!this.ladder) return false
		const state = await this.ladder.lockState().catch((error: unknown) => {
			if (error instanceof CallAbortedError) throw error
			return null
		})
		return state === 'locked'
	}

	private async refuseWhenLocked(): Promise<void> {
		if (await this.locked()) throw new ComputerUseLockedError()
	}

	/** A capture taken while the screen was locked shows no current state: it is dropped. */
	private async notCapturedLocked(): Promise<void> {
		if (await this.locked()) throw new ComputerUseLockedError()
	}

	private requireAdapter(): Adapter {
		if (this.ladder?.stopped) throw new ComputerUseStoppedError()
		if (!this.adapter) {
			throw new Error(
				'SubprocessComputerUseHost: adapter not initialised — call `await host.initialize()` first',
			)
		}
		return this.adapter
	}
}

/** What a cancelled call that changes the desktop tells the model. */
function abortedDelivery(sent: boolean): WindowInputResult {
	return sent
		? {
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail:
					'The turn was cancelled while this was being sent, so it may have gone through. Look at the window before repeating it.',
			}
		: {
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: 'The turn was cancelled before this was sent, so nothing happened.',
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
	ladder: ForegroundLadder | undefined,
	presence: Presence | undefined,
	a11y: AccessibilityBackend | undefined,
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
				...(ladder ? { foreground: ladder } : {}),
				...(presence ? { presence } : {}),
				...(a11y ? { a11y } : {}),
			})
		}
		case 'unknown':
			throw new Error(
				`SubprocessComputerUseHost: no adapter available for displayServer="${displayServer}" yet`,
			)
	}
}
