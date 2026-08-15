import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { probeOptionalPackage } from '../../context/capabilities.js'

const TELEMETRY = '@namzu/telemetry'

/**
 * Telemetry presence probe.
 *
 * Per ses_004 D1=B, `@namzu/telemetry` is a separate optional package.
 * This check reports whether it is installed; absence is informational
 * (not a failure). Endpoint reachability + dry-run span export are
 * deferred to a follow-up check that the consumer can register
 * themselves once their telemetry config is known.
 *
 * The three-state resolve-then-import probe this used to do inline now
 * lives at `context/capabilities.ts` as `probeOptionalPackage` (NZ-BOOT-02),
 * extracted so the boot path can report the SAME answer about
 * `@namzu/sandbox`, `@namzu/files` and `@namzu/computer-use` that this file
 * has always given about telemetry, instead of inventing its own. What
 * stays here is the one thing the doctor still owns: turning that answer
 * into the prose and remediation a `DoctorCheckResult` carries.
 */
/**
 * `specifier`'s `CapabilityProbe`, read as a `DoctorCheckResult`.
 *
 * Exported separately from the `DoctorCheck` so all three outcomes can be
 * asserted directly — there is no way to uninstall or break a real optional
 * package from inside a test run, so `capabilities.test.ts` drives
 * `probeOptionalPackage` with fixtures and this function's own tests only
 * need to check the mapping. The check itself is still exercised through
 * `telemetryInstalledCheck.run`, because a helper proven in isolation says
 * nothing about whether the check reaches it. Same arrangement, and the
 * same reason, as `describeProviderChain`.
 */
export async function describeInstalledPackage(specifier: string): Promise<DoctorCheckResult> {
	const probe = await probeOptionalPackage(specifier)
	switch (probe.state) {
		case 'absent':
			return {
				status: 'skipped',
				message: `${specifier} not installed (optional package)`,
			}
		case 'present':
			return { status: 'pass', message: `${specifier} is installed` }
		case 'broken':
			return {
				status: 'fail',
				// The reason is the whole value of separating these: "installed but
				// will not load" sends the reader somewhere, and "not installed" would
				// have sent them to install what is already there.
				message: `${specifier} is installed but failed to load: ${probe.error.message}`,
				remediation: `Reinstall ${specifier}, or remove it if you are not using it — it is optional and namzu runs without it.`,
			}
	}
}

export const telemetryInstalledCheck: DoctorCheck = {
	id: 'telemetry.installed',
	category: 'telemetry',
	run: (): Promise<DoctorCheckResult> => describeInstalledPackage(TELEMETRY),
}
