/**
 * What a scheduled run's desktop notification says.
 *
 * Content-free by default: the job's name, what happened, and when. Nothing
 * the model wrote reaches a lock screen unless the job asked for its summary
 * (`notify.includeSummary`), and then only as one sanitised line.
 */

import type { ScheduleJob } from '../types.js'

export type NoticeKind =
	| 'finished'
	| 'failed'
	| 'timed-out'
	| 'interrupted'
	| 'blocked-config'
	| 'awaiting-approval'
	| 'approval-expired'
	| 'catch-up'
	| 'held'
	| 'needs-confirmation'
	| 'auto-paused'

function clock(at: Date): string {
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
	}).format(at)
}

export function noticeText(
	kind: NoticeKind,
	job: Pick<ScheduleJob, 'name' | 'notify'>,
	extra: {
		readonly at: Date
		readonly summary?: string
		readonly scheduledFor?: Date
		readonly missed?: number
		readonly failures?: number
	},
): { title: string; body: string } {
	const title = `namzu: ${job.name}`
	const when = clock(extra.at)
	const summary = job.notify.includeSummary && extra.summary ? ` — ${extra.summary}` : ''
	switch (kind) {
		case 'finished':
			return { title, body: `finished at ${when}${summary}` }
		case 'failed':
			return { title, body: `failed at ${when}${summary}` }
		case 'timed-out':
			return { title, body: `stopped at its time limit at ${when}` }
		case 'interrupted':
			return { title, body: `was interrupted at ${when}` }
		case 'blocked-config':
			return {
				title,
				body: `could not start at ${when}: check it with namzu schedule show ${job.name}`,
			}
		case 'awaiting-approval':
			return { title, body: `is waiting for your approval (since ${when}); open /schedule` }
		case 'approval-expired':
			return { title, body: `approval expired at ${when}; the run was abandoned` }
		case 'catch-up':
			return {
				title,
				body: `catch-up run for ${extra.scheduledFor ? clock(extra.scheduledFor) : 'a missed time'}${extra.missed ? `, ${extra.missed} earlier runs missed` : ''}`,
			}
		case 'held':
			return { title, body: 'changed outside namzu and is on hold; confirm it with /schedule' }
		case 'needs-confirmation':
			return { title, body: 'needs confirmation before it runs; open /schedule' }
		case 'auto-paused':
			return { title, body: `paused after ${extra.failures ?? 'several'} failed runs in a row` }
	}
}

/** The same failure told once: status plus the reason with numbers and ids removed. */
export function failureSignature(status: string, reason: string | undefined): string {
	const normal = (reason ?? '')
		.toLowerCase()
		.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>')
		.replace(/\d+/g, '<n>')
		.replace(/\s+/g, ' ')
		.slice(0, 160)
	return `${status}:${normal}`
}
