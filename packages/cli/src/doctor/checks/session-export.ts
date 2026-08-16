import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import type { NamzuCliConfig } from '../../config/schema.js'
import {
	type TelemetryLoader,
	describeSessionExportOff,
} from '../../integrations/telemetry/session-export.js'

/**
 * Is this machine sending conversation content anywhere?
 *
 * A doctor row rather than only a boot line, because the two answer for
 * different people at different moments: the boot narrative tells whoever
 * started the run, and `namzu doctor` is what somebody runs when they are
 * asked "does this tool send our transcripts off the box" and need an answer
 * they can paste.
 *
 * The row is a `pass` in both directions on purpose. Export being ON is not
 * a fault — it is a configuration somebody chose — so reporting it as a
 * warning would train a reader to ignore the one row that describes their
 * data leaving. What the row owes them is the destination and the redactor
 * count, which is exactly what `describeSessionExport` already builds.
 */
export async function describeSessionExportStatus(
	config: NamzuCliConfig,
	loader?: TelemetryLoader,
): Promise<DoctorCheckResult> {
	const configured = config.telemetry?.sessionExport
	if (!configured) {
		const off = await describeSessionExportOff(loader)
		return {
			status: 'pass',
			message: off ?? 'Session export is off: telemetry.sessionExport is not configured.',
		}
	}

	// The disclosure is built from the config, not from a live listener: a
	// doctor run must be able to answer this without starting a session, and
	// starting one to find out what it would export would be the check
	// causing the thing it reports on.
	const off = await describeSessionExportOff(loader)
	if (off === null) {
		// Configured, but the package that would do it is not installed. The
		// run itself refuses in this state (`attachSessionExport`), and saying
		// so here is what stops an operator discovering it at run time.
		return {
			status: 'fail',
			message: `telemetry.sessionExport is configured (destination: ${configured.destination}) but "@namzu/telemetry" is not installed, so nothing would be recorded.`,
			remediation:
				'Install @namzu/telemetry, or remove telemetry.sessionExport from your config. namzu refuses to start a session in this state rather than run one whose export silently does not exist.',
		}
	}

	const redactorCount = configured.redactors?.length ?? 1
	const typePhrase = configured.eventTypes
		? `${configured.eventTypes.length} event type(s)`
		: 'every run event'
	return {
		status: 'pass',
		message: `Session export is ON: ${typePhrase} is written to ${configured.destination}, with ${redactorCount} redactor(s) installed.`,
		...(redactorCount === 0
			? {
					remediation:
						'`redactors: []` turns redaction off entirely — credential-shaped values in tool results will be written verbatim. Remove the key to install the shipped `secrets` redactor.',
				}
			: {}),
	}
}

export function sessionExportCheck(config: NamzuCliConfig, loader?: TelemetryLoader): DoctorCheck {
	return {
		id: 'telemetry.session-export',
		category: 'telemetry',
		run: (): Promise<DoctorCheckResult> => describeSessionExportStatus(config, loader),
	}
}
