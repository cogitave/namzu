import type {
	SandboxEnvironment,
	SandboxIsolationControl,
	SandboxIsolationReport,
} from '../types/sandbox/index.js'
import { SANDBOX_ISOLATION_CONTROLS } from '../types/sandbox/index.js'

/**
 * What each tier actually enforces on the spawned process.
 *
 * This table is deliberately pessimistic: a control is `true` only where
 * the spawn arguments enforce it, never where the tier's name suggests it.
 * The gap being closed here is that a caller who turned isolation on got a
 * tier-dependent amount of it under one undifferentiated provider name,
 * with no way to tell which controls were live.
 *
 * `linux-namespace` reports `filesystem: false` on purpose. The tier
 * unshares the mount namespace but never remounts anything, so the child
 * still sees the whole host filesystem — a private mount table is not
 * confinement. Claiming otherwise here would reintroduce the exact defect
 * this table exists to end.
 *
 * `linux-bwrap` is the tier that does remount, and so is the first on this
 * platform that may claim `filesystem`. It builds a fresh mount table
 * containing the sandbox root read-write, the system paths a binary needs
 * read-only, and nothing else — the host filesystem is not merely
 * unwritable, it is not present. Verified by `spawn-confinement.proc-test.ts`
 * against a real spawn rather than asserted here, because this table is a
 * claim and that test is what makes it one worth reading.
 */
const ISOLATION_BY_ENVIRONMENT: Readonly<Record<SandboxEnvironment, SandboxIsolationReport>> = {
	'linux-bwrap': { filesystem: true, network: true, process: true },
	'macos-seatbelt': { filesystem: true, network: true, process: true },
	'linux-namespace': { filesystem: false, network: true, process: true },
	basic: { filesystem: false, network: false, process: false },
}

export function isolationOf(environment: SandboxEnvironment): SandboxIsolationReport {
	const report = ISOLATION_BY_ENVIRONMENT[environment]
	if (report === undefined) {
		throw new Error(`Unknown sandbox environment: ${environment}`)
	}
	return report
}

/** The requested controls this environment cannot supply, in a stable order. */
export function missingIsolation(
	environment: SandboxEnvironment,
	required: readonly SandboxIsolationControl[],
): SandboxIsolationControl[] {
	const report = isolationOf(environment)
	return SANDBOX_ISOLATION_CONTROLS.filter(
		(control) => required.includes(control) && !report[control],
	)
}

/**
 * Refuse when the host cannot supply a control the caller asked for.
 *
 * Refusing is the whole point. A security control that is accepted and
 * then silently not applied is worse than one that was never offered: the
 * caller stops looking, and the run proceeds believing it is confined.
 */
export function assertIsolation(
	environment: SandboxEnvironment,
	required: readonly SandboxIsolationControl[],
): void {
	const missing = missingIsolation(environment, required)
	if (missing.length === 0) return

	throw new Error(
		`Sandbox environment "${environment}" cannot enforce ${missing.join(', ')} isolation, which this run requires. Enforced here: ${describeIsolation(environment)}. Run on a host that supports it, or drop the requirement explicitly — it will not be silently downgraded.`,
	)
}

/** Human-readable summary for logs and error messages. */
export function describeIsolation(environment: SandboxEnvironment): string {
	const report = isolationOf(environment)
	const enforced = SANDBOX_ISOLATION_CONTROLS.filter((control) => report[control])
	return enforced.length === 0 ? 'nothing' : enforced.join(', ')
}
