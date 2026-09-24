/**
 * What a scheduled run's desktop notification says.
 *
 * Content-free by default: the job's name, what happened, and when. Nothing
 * the model wrote reaches a lock screen unless the job asked for its summary
 * (`notify.includeSummary`), and then only as one sanitised line.
 */

import { callsWords } from '../fire/calls.js'
import type { ScheduleCallTally, ScheduleJob } from '../types.js'

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

/** The longest body a notification carries whole (`sendDesktopNotification` cuts the rest). */
export const NOTICE_BODY_MAX = 200

export function noticeText(
	kind: NoticeKind,
	job: Pick<ScheduleJob, 'name' | 'notify'>,
	extra: {
		readonly at: Date
		readonly summary?: string
		readonly scheduledFor?: Date
		readonly missed?: number
		readonly failures?: number
		/** For a park: the command that opens it (`cd <folder> && namzu resume <id>`). */
		readonly resumeCommand?: string
		/**
		 * For a park a tool asked for: what the person has to do. Written by
		 * the tool, not the model, and already one sanitised line.
		 */
		readonly handoff?: string
		/**
		 * For a finished run: the calls its permissions refused. The reason
		 * may quote the command the model wrote, so it is said only where the
		 * job asked for its summary; otherwise the tool is named and `show`
		 * says why.
		 */
		readonly refused?: ScheduleCallTally
	},
): { title: string; body: string } {
	const title = `namzu: ${job.name}`
	const when = clock(extra.at)
	const summary = job.notify.includeSummary && extra.summary ? ` — ${extra.summary}` : ''
	switch (kind) {
		case 'finished': {
			const refused = extra.refused
			if (!refused) return { title, body: `finished at ${when}${summary}` }
			const done = `done at ${when}, but ${callsWords(refused, 'refused')}`
			if (!job.notify.includeSummary)
				return {
					title,
					body: fit(
						`${done} (${refused.first.tool}); namzu schedule show ${job.name} says why`,
						`${done} (${refused.first.tool})`,
					),
				}
			// The reason is cut, never the words before it or the summary's absence.
			const head = `${done}: `
			const room = NOTICE_BODY_MAX - [...head].length - [...summary].length
			const reason = [...refused.first.reason]
			const said =
				reason.length <= room
					? refused.first.reason
					: `${reason.slice(0, Math.max(room - 1, 0)).join('')}…`
			return { title, body: fit(`${head}${said}${summary}`, `${head}${said}`) }
		}
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
		case 'awaiting-approval': {
			if (extra.handoff) {
				const needs = `needs you (since ${when}): ${extra.handoff}`
				// Longest first; each is used only when it fits whole, and the
				// reason alone is cut rather than dropped.
				const candidates = [
					...(extra.resumeCommand ? [`${needs}; continue it: ${extra.resumeCommand}`] : []),
					`${needs}; namzu schedule show ${job.name} says how to continue it`,
					needs,
				]
				const body = candidates.find((text) => [...text].length <= NOTICE_BODY_MAX)
				return {
					title,
					body: body ?? `${[...needs].slice(0, NOTICE_BODY_MAX - 1).join('')}…`,
				}
			}
			const waiting = `is waiting for your approval (since ${when})`
			// The command only when it fits whole: a notification is cut at
			// NOTICE_BODY_MAX, and half a `cd` is worse than none.
			const answer = extra.resumeCommand
				? `${waiting}; answer it: ${extra.resumeCommand}`
				: undefined
			return {
				title,
				body:
					answer && [...answer].length <= NOTICE_BODY_MAX
						? answer
						: `${waiting}; namzu schedule show ${job.name} says how to answer it`,
			}
		}
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

/** The first text that fits a notification whole, else the last cut to fit. */
function fit(...candidates: readonly string[]): string {
	const whole = candidates.find((text) => [...text].length <= NOTICE_BODY_MAX)
	if (whole !== undefined) return whole
	const last = [...(candidates.at(-1) ?? '')]
	return `${last.slice(0, NOTICE_BODY_MAX - 1).join('')}…`
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
