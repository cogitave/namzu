import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
} from '@namzu/sdk'

/**
 * Platform-specific execution surface behind `SubprocessComputerUseHost`.
 * Each adapter owns its CLI invocations, capability probe, and error mapping.
 *
 * Implementations must be stateless between calls (the subprocess model has
 * no persistent resources to manage). `capabilities` is frozen at probe time
 * and reflects what actually works on the host, not what the action union
 * permits.
 */
export interface Adapter {
	readonly capabilities: ComputerUseCapabilities
	getDisplayGeometry(): Promise<DisplayGeometry>
	execute(action: ComputerUseAction): Promise<ComputerUseResult>
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
