import type { DoctorCheck, DoctorCheckResult, LogSinkCounters } from '@namzu/sdk'
import { getLogCounters } from '@namzu/sdk'

/**
 * What the log pipeline actually did to this process's records.
 *
 * `LogSinkCounters` has counted five things on every record since the sink
 * seam landed — dropped, redacted, attributes shed, values truncated,
 * records shrunk — and until this check nothing read any of them. That is
 * `declared-but-undriven` with an unusually direct tell: the comment above
 * `createLogger` promised "a caller that wants to observe the pipeline — a
 * test, `namzu doctor` later — reads `.counters` off the same reference",
 * and `namzu doctor` did not. This file is that comment coming true.
 *
 * The counters only became readable as part of this change. They lived on
 * whatever logger `createLogger` happened to build, and `getRootLogger`
 * builds a new one on every call, so each count died with the expression
 * that produced it. `installProcessSink` now owns one set for the process
 * and every logger routed through it adds to those totals.
 */

/** Field-by-field, so a new counter cannot be silently left unreported. */
const FIELDS: readonly (keyof LogSinkCounters)[] = [
	'dropped',
	'redacted',
	'attributesDropped',
	'valuesTruncated',
	'recordsTruncated',
]

function summarise(counters: LogSinkCounters): string {
	return FIELDS.map((f) => `${f}=${counters[f]}`).join(' ')
}

/**
 * Exported separately from the check so all three outcomes can be driven
 * directly, the same arrangement `describeInstalledPackage` uses: a check
 * whose only entry point is `run` can be tested for the state the machine
 * happens to be in and nothing else.
 */
export function describeLogPipeline(counters: LogSinkCounters | undefined): DoctorCheckResult {
	if (counters === undefined) {
		// NOT `pass`, and not five zeros dressed up as one. Nothing measured
		// these records, so "nothing was dropped" is a claim this check has no
		// standing to make — and it is the claim a reader would take from a
		// green row. The CLI installs a sink during boot, so reaching here at
		// all means that boot step did not run.
		return {
			status: 'inconclusive',
			message:
				'no log sink installed — records reach stderr through the legacy path, where nothing is counted, redacted or size-capped',
			remediation:
				'A host owns its log destination: call installProcessSink(sink, level) during boot. The CLI does this itself, so seeing this from `namzu doctor` means that step did not run.',
		}
	}

	if (counters.dropped > 0) {
		return {
			status: 'fail',
			message: `${counters.dropped} log record(s) never reached the sink — ${summarise(counters)}`,
			remediation:
				'A record is counted dropped when the installed sink threw, or when the sink is NOOP_SINK. Check the sink passed to installProcessSink: a sink that throws is caught so one bad record cannot fail a run, which is exactly why the count is the only place this shows up.',
		}
	}

	return {
		status: 'pass',
		message: `log pipeline live, nothing dropped — ${summarise(counters)}`,
	}
}

export const loggingPipelineCheck: DoctorCheck = {
	id: 'logging.pipeline',
	// `DoctorCategory` has no `logging` member, and widening that union is an
	// SDK type change this check does not need — the same call the optional
	// package probes made for `files` and `computer-use`.
	category: 'custom',
	run: (): Promise<DoctorCheckResult> => Promise.resolve(describeLogPipeline(getLogCounters())),
}
