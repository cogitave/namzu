import type {
	DoctorCheck,
	DoctorCheckResult,
	Logger,
	SandboxEnvironment,
	SandboxIsolationControl,
} from '@namzu/sdk'
import { LocalSandboxProvider, SANDBOX_ISOLATION_CONTROLS, isolationOf } from '@namzu/sdk'

/**
 * Report the confinement this host will ACTUALLY give, by asking the
 * thing that decides.
 *
 * The check used to switch on `process.platform` and answer from a table
 * written beside it. That table drifted from the runtime in both
 * directions: it called the Linux probe unimplemented when the provider
 * has probed real `unshare` flags for some time, and it told a Windows
 * operator that sandboxing "is not supported" full stop — true of the
 * in-process tier, and silent about the container tier that does run
 * there. An operator reading a health check is deciding whether to trust
 * the boundary, and a second opinion derived from the OS name is the
 * wrong thing to hand them.
 *
 * Constructing the provider is the probe: it runs the real spawn
 * arguments and reports which controls survived. No isolation is
 * REQUIRED here, so the construction cannot refuse — this asks what is
 * available, it does not ask for anything.
 */

/** A logger that says nothing: the check reports, the probe should not. */
const quietLogger = (() => {
	const noop = () => {}
	const self = { info: noop, warn: noop, error: noop, debug: noop }
	return { ...self, child: () => self } as unknown as Logger
})()

const listControls = (report: Record<SandboxIsolationControl, boolean>, want: boolean) =>
	SANDBOX_ISOLATION_CONTROLS.filter((control) => report[control] === want).join(', ')

/**
 * Turn a detected environment into the verdict an operator reads.
 *
 * Separate from the probe because the probe answers for THIS host, and
 * every branch below is about a host the machine running the tests is
 * not. Asserting on the check as a whole can only ever exercise the one
 * outcome the developer's own machine produces, which is how a report
 * for the other tiers rots unnoticed.
 */
export function describeIsolationHealth(environment: SandboxEnvironment): DoctorCheckResult {
	const report = isolationOf(environment)
	const enforced = listControls(report, true)
	const missing = listControls(report, false)

	if (missing.length === 0) {
		return { status: 'pass', message: `${environment} enforces ${enforced}` }
	}

	if (enforced.length === 0) {
		// Not `fail`: nothing is broken. The host simply has no in-process
		// confinement, which is a fact an operator has to decide about
		// rather than an error to fix.
		return {
			status: 'warn',
			message: `${environment} enforces nothing — commands run unconfined`,
			remediation:
				'Run the agent inside a container per task (@namzu/sandbox, container tier), or pass requireIsolation so a run refuses rather than proceeding unconfined.',
		}
	}

	return {
		status: 'warn',
		message: `${environment} enforces ${enforced} but not ${missing}`,
		remediation:
			'Pass requireIsolation with the controls you depend on, so a host that cannot enforce one refuses instead of downgrading quietly.',
	}
}

export const sandboxPlatformCheck: DoctorCheck = {
	id: 'sandbox.platform',
	category: 'sandbox',
	run: async (): Promise<DoctorCheckResult> => {
		try {
			return describeIsolationHealth(new LocalSandboxProvider(quietLogger).environment)
		} catch (error) {
			return {
				status: 'fail',
				message: `sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`,
				remediation:
					'The local sandbox provider could not determine what this host enforces. Treat commands as unconfined until this is resolved.',
			}
		}
	},
}
