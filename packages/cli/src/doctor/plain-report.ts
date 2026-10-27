/**
 * The health report in a person's words, for `/doctor`.
 *
 * The rows say what is fine and what needs attention, without check ids,
 * timings or exit codes. Whatever a row only summarised (the checks' own technical
 * message and advice) goes behind the row's details. The complete
 * technical report is what `namzu doctor` prints.
 */

import type { DoctorCheckRecord, DoctorReport, DoctorStatus } from '@namzu/sdk'

/** What a person calls each check. Anything unlisted is named from its id. */
const TITLES: Readonly<Record<string, string>> = {
	'providers.chain': 'Model fallback order',
	'providers.credentials': 'Sign-ins and keys',
	'providers.registered': 'Model providers',
	'browser.engine': 'Browser',
	'telemetry.session-export': 'Session export',
	'telemetry.installed': 'Telemetry package',
	'codeAnalysis.index': 'Code index',
	'scheduler.service': 'Scheduled tasks',
	'logging.pipeline': 'Logging',
	'runtime.invariants': 'Internal consistency',
	'runtime.cwd-writable': 'This folder is writable',
	'runtime.tmpdir-writable': 'Temporary folder is writable',
	'vault.registered': 'Secret storage',
	'sandbox.platform': 'Sandbox',
	'updates.install': 'Updates',
}

const MARKS: Readonly<Record<DoctorStatus, string>> = {
	pass: '✓',
	warn: '!',
	fail: '✗',
	inconclusive: '?',
	skipped: '⊘',
}

export function plainCheckTitle(id: string): string {
	const known = TITLES[id]
	if (known) return known
	const [area = id, name = ''] = id.split('.')
	const text = name === 'installed' ? `${words(area)} package` : words(name || area)
	return text.charAt(0).toUpperCase() + text.slice(1)
}

function words(text: string): string {
	return text
		.replace(/[-_]/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^@namzu\//, '')
		.toLowerCase()
}

/**
 * What each check says in a person's words when it needs attention. The checks
 * themselves write technical text (paths, error text, counts with "(s)"), so
 * the row never repeats it; the original lines go behind the row's details.
 */
interface PlainReason {
	readonly fail?: string
	readonly warn?: string
	readonly advice?: string
}

const REASONS: Readonly<Record<string, PlainReason>> = {
	'providers.chain': {
		fail: 'the saved model order could not be used',
		warn: 'some models in the saved order cannot be used',
		advice: 'Open the model picker and choose again.',
	},
	'providers.credentials': {
		fail: 'no sign-in or key was found',
		warn: 'a sign-in could not be read',
		advice: 'Sign in to a model provider, or add a key.',
	},
	'providers.registered': {
		fail: 'no model provider is available',
		warn: 'a model provider is missing',
	},
	'browser.engine': {
		fail: 'the browser is not available here',
		warn: 'the browser may need a one-time install',
		advice: 'Run "namzu browser install".',
	},
	'telemetry.session-export': {
		fail: 'session export is set up but cannot run',
		warn: 'session export is set up but cannot run',
	},
	'telemetry.installed': {
		fail: 'the optional telemetry package could not start',
		warn: 'the optional telemetry package is not installed',
	},
	'codeAnalysis.index': {
		fail: 'the code index is not working',
		warn: 'the code index is not available',
	},
	'scheduler.service': {
		fail: 'scheduled tasks cannot run right now',
		warn: 'scheduled tasks will not run until the scheduler is set up',
		advice: 'Run "namzu schedule install".',
	},
	'logging.pipeline': {
		fail: 'some activity was not recorded',
		warn: 'some activity was not recorded',
	},
	'runtime.invariants': {
		fail: 'an internal self-check did not hold',
		warn: 'an internal self-check could not be confirmed',
	},
	'runtime.cwd-writable': {
		fail: 'Namzu cannot write in this folder',
		advice: 'Start Namzu from a folder you can write to.',
	},
	'runtime.tmpdir-writable': {
		fail: 'Namzu cannot write to the temporary folder',
		advice: 'Point your temporary folder at a place you can write to.',
	},
	'vault.registered': {
		fail: 'secret storage is not set up',
		warn: 'secret storage is not set up',
	},
	'sandbox.platform': {
		fail: 'the sandbox could not be checked',
		warn: 'the sandbox does not fully contain commands here',
		advice: 'Commands will ask before they run outside it.',
	},
	'updates.install': {
		fail: 'Namzu could not check for updates',
		warn: 'a newer version could not be installed here',
	},
}

function reasonFor(record: DoctorCheckRecord): PlainReason {
	return REASONS[record.id] ?? {}
}

export interface PlainDoctor {
	readonly level: 'notice' | 'warning' | 'error'
	/** The visible rows, one string with line breaks. */
	readonly content: string
	/** What the rows summarised, for the row's details; empty when nothing was cut. */
	readonly detail: readonly string[]
}

export function describePlainDoctor(report: DoctorReport): PlainDoctor {
	const { fail, warn, inconclusive, pass, total } = report.summary
	const asked = report.checks.filter((c) => c.status !== 'skipped')
	const needAttention = fail + warn + inconclusive
	const level = fail > 0 ? 'error' : needAttention > 0 ? 'warning' : 'notice'
	const headline =
		total === 0
			? 'No health checks are available here.'
			: needAttention === 0
				? pass === 1
					? 'The one check passed.'
					: `All ${pass} checks passed.`
				: needAttention === 1
					? '1 check needs attention.'
					: `${needAttention} checks need attention.`
	const lines = [headline]
	for (const record of asked) lines.push(...rowFor(record))
	// What an attention row only summarised: the check's own message and
	// advice, never ids or timings.
	const detail = asked
		.filter((c) => c.status !== 'pass')
		.flatMap((c) => {
			const rest = [...(c.message ?? '').split('\n'), ...(c.remediation ?? '').split('\n')].filter(
				(line) => line.trim().length > 0,
			)
			return rest.length === 0
				? []
				: [`${plainCheckTitle(c.id)}:`, ...rest.map((l) => `  ${l.trim()}`)]
		})
	return { level, content: lines.join('\n'), detail }
}

function rowFor(record: DoctorCheckRecord): string[] {
	const title = plainCheckTitle(record.id)
	if (record.status === 'pass') return [`  ${MARKS.pass} ${title}`]
	const reason = reasonFor(record)
	const why =
		record.status === 'inconclusive'
			? 'could not be checked'
			: record.status === 'fail'
				? (reason.fail ?? 'failed')
				: (reason.warn ?? reason.fail ?? 'worth a look')
	const out = [`  ${MARKS[record.status]} ${title}: ${why}`]
	if (record.status !== 'inconclusive' && reason.advice) out.push(`      Try: ${reason.advice}`)
	return out
}
