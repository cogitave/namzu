import type { DoctorCheck, DoctorCheckResult } from '../../types/doctor/index.js'

/**
 * Telemetry presence probe.
 *
 * Per ses_004 D1=B, `@namzu/telemetry` is a separate optional package.
 * This check reports whether it is installed; absence is informational
 * (not a failure). Endpoint reachability + dry-run span export are
 * deferred to a follow-up check that the consumer can register
 * themselves once their telemetry config is known.
 */
export const telemetryInstalledCheck: DoctorCheck = {
	id: 'telemetry.installed',
	category: 'telemetry',
	run: async (): Promise<DoctorCheckResult> => {
		const specifier = '@namzu/telemetry'
		try {
			await import(specifier)
			return { status: 'pass', message: '@namzu/telemetry is installed' }
		} catch {
			return {
				status: 'inconclusive',
				message: '@namzu/telemetry not installed (optional package)',
			}
		}
	},
}
