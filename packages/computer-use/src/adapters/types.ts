import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	FocusWindowResult,
	Rect,
	ScreenshotResult,
	WindowInfo,
} from '@namzu/sdk'

/**
 * Platform-specific execution surface behind `SubprocessComputerUseHost`.
 * Each adapter owns its CLI invocations, capability probe, and error mapping.
 *
 * `capabilities` is frozen at probe time and reflects what actually works on
 * the host, not what the action union permits. An adapter that keeps a
 * process between calls (the Windows cua-driver backend does) releases it in
 * `dispose`.
 *
 * Units follow the SDK's host contract: physical pixels, action points
 * relative to the display of the last capture.
 */
export interface Adapter {
	readonly capabilities: ComputerUseCapabilities
	/** What drives the desktop, for diagnosis: `cua-driver 0.28.2`, `powershell`. */
	readonly backend?: string
	/** Why the preferred backend is not the one in use, when the adapter fell back. */
	readonly fallbackReason?: string
	getDisplayGeometry(): Promise<DisplayGeometry>
	execute(action: ComputerUseAction): Promise<ComputerUseResult>
	/** With `capabilities.windows`. */
	listWindows?(): Promise<readonly WindowInfo[]>
	/** With `capabilities.windows`. */
	focusWindow?(id: string): Promise<FocusWindowResult>
	/** With `capabilities.regionCapture`. */
	captureRegion?(rect: Rect): Promise<ScreenshotResult>
	dispose?(): Promise<void>
}

/**
 * Factory: probes the environment (env, PATH binaries, compositor type),
 * returns a ready adapter. The probe is intentionally synchronous-ish
 * (may await a few `which` calls) and throws `AdapterUnavailableError` if
 * the platform is fundamentally incompatible.
 */
export type AdapterFactory = () => Promise<Adapter>

export class AdapterUnavailableError extends Error {
	constructor(
		message: string,
		readonly missing: readonly string[] = [],
	) {
		super(message)
		this.name = 'AdapterUnavailableError'
	}
}

export class ActionCapabilityError extends Error {
	constructor(action: ComputerUseAction['type'], capability: string, detail?: string) {
		super(
			`computer-use: action "${action}" requires capability "${capability}"${detail ? ` (${detail})` : ''}`,
		)
		this.name = 'ActionCapabilityError'
	}
}
