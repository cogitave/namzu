/**
 * The health report in a person's words, for `/doctor`.
 *
 * The rows say what is fine and what needs attention, without check ids,
 * timings or exit codes. Whatever a row only summarised (the later lines of a
 * message or of its advice) goes behind the row's details. The complete
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

function firstLine(text: string | undefined): string {
	return (text ?? '').split('\n')[0]?.trim() ?? ''
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
	// The rest of what an attention row only summarised: the full message and
	// the full advice, never ids or timings.
	const detail = asked
		.filter((c) => c.status !== 'pass')
		.flatMap((c) => {
			const rest = [
				...(c.message ?? '').split('\n').slice(1),
				...(c.remediation ?? '').split('\n').slice(1),
			].filter((line) => line.trim().length > 0)
			return rest.length === 0
				? []
				: [`${plainCheckTitle(c.id)}:`, ...rest.map((l) => `  ${l.trim()}`)]
		})
	return { level, content: lines.join('\n'), detail }
}

function rowFor(record: DoctorCheckRecord): string[] {
	const title = plainCheckTitle(record.id)
	if (record.status === 'pass') return [`  ${MARKS.pass} ${title}`]
	const why =
		record.status === 'inconclusive'
			? 'could not be checked'
			: firstLine(record.message) || (record.status === 'fail' ? 'failed' : 'worth a look')
	const out = [`  ${MARKS[record.status]} ${title}: ${why}`]
	const fix = firstLine(record.remediation)
	if (fix) out.push(`      Try: ${fix}`)
	return out
}
