import { type SessionTokenBudgetSummary, type StopReason, hostTimeZone } from '@namzu/sdk'

import { currentTimeLine } from '../schedule/fire/unattended-note.js'

import type { AgentEvent } from './agent.js'
import { terminalDisplayText } from './terminal-display.js'
import {
	ZEN_FREE_REFUSED_NEXT,
	ZEN_FREE_REFUSED_WHAT,
	isZenFreeTierRefusal,
} from './zen-free-refusal.js'

export type Interruption = Extract<AgentEvent, { kind: 'error' | 'paused' }>

/**
 * A completed event can carry a resource or policy stop without an error event.
 * Budget admission includes reservations: refusal is not proof of money or
 * tokens spent. Usage remains the reported measurement available through /cost.
 */
export function describeTurnStop(
	reason: StopReason | undefined,
	budget?: SessionTokenBudgetSummary,
): string | undefined {
	switch (reason) {
		case undefined:
		case 'end_turn':
		case 'cancelled':
			return undefined
		case 'token_budget':
			if ((budget?.unresolvedRequests ?? 0) > 0)
				return 'Namzu could not confirm how much the last model request used, so it stopped. /cost shows what was reported; the total is uncertain.'
			if (budget?.poisoned)
				return 'Namzu stopped because usage could not be checked. /cost shows what was measured.'
			return 'The reply stopped at its token limit. /cost shows reported usage.'
		case 'cost_limit':
			return 'The reply stopped at the cost limit. /cost shows reported usage.'
		case 'cost_unmeasurable':
			return 'The reply stopped because the cost limit could not be checked (no price on file). /cost shows reported usage.'
		case 'timeout':
			return 'The reply stopped at its time limit.'
		case 'max_iterations':
			return 'The reply stopped at its step limit.'
		case 'plan_rejected':
			return 'The plan was declined, so the reply stopped.'
		case 'stop_condition':
			return 'The reply stopped because a stop condition you set was met.'
		case 'step_refused':
			return 'The model refused to continue.'
		case 'structured_output_failed':
			return 'The reply stopped because it did not match the required format.'
		case 'output_limit':
			return 'The reply kept hitting the output limit and stopped. Ask for a smaller piece of the work.'
		case 'answer_rejected':
			return 'The final answer was not accepted, so the reply stopped.'
		case 'input_guardrail':
			return 'An input check refused this message.'
		case 'output_guardrail':
			return 'An output check refused the result.'
		case 'paused':
			return 'Paused.'
		case 'error':
			return 'Stopped after an error.'
	}
}

/** A tool's attached fact key as a label: `login_url` reads `Login url`. */
export function detailLabel(key: string): string {
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
		.replace(/[_-]+/gu, ' ')
		.trim()
		.toLowerCase()
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** One terminal-safe line, bounded so a provider response cannot own the screen. */
function line(value: string, max = 480): string {
	const clean = terminalDisplayText(value).replace(/\s+/g, ' ').trim()
	return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`
}

/** The delay the provider asked for, from either place the event can carry it. */
export function retryAfterMs(event: Interruption): number | undefined {
	const direct = event.providerError?.retryAfterMs
	const projected = event.failure?.details?.retryAfterMs
	const value = typeof direct === 'number' ? direct : projected
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}

function duration(ms: number): string {
	// Never milliseconds on screen: under a second reads as one second.
	const seconds = Math.max(1, Math.ceil(ms / 1_000))
	if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`
	const minutes = Math.ceil(seconds / 60)
	if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
	const hours = Math.ceil(minutes / 60)
	if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
	const days = Math.ceil(hours / 24)
	return `${days} day${days === 1 ? '' : 's'}`
}

function materiallyDifferent(candidate: string, earlier: readonly string[]): boolean {
	const normalized = line(candidate).toLocaleLowerCase('en-US')
	return (
		normalized.length > 0 &&
		!earlier.some((value) => {
			const prior = line(value).toLocaleLowerCase('en-US')
			return prior === normalized || prior.includes(normalized) || normalized.includes(prior)
		})
	)
}

/**
 * The model a spend limit could not be counted for, when that is why the turn
 * did not start: the limit is checked against priced spend, and a model with no
 * price on file would let the whole turn read as under it.
 */
function unpricedSpendLimit(event: Interruption): string | undefined {
	const failure = event.failure
	if (failure?.code !== 'invalid_config') return undefined
	const model = failure.details?.model
	const limit = failure.details?.costLimitUsd
	return typeof model === 'string' && typeof limit === 'number' ? model : undefined
}

/**
 * Human copy for a terminal interruption, derived only from event facts.
 *
 * No countdown: `retryAfterMs` is a duration reported at the failure boundary,
 * not a clock this process keeps updating. No generic remedy either: when the
 * SDK catalog did not claim a failure, the provider reason is all we know.
 */
export function describeTurnInterruption(event: Interruption): string {
	if (event.kind === 'paused' && event.handoff) return describeHandoff(event)
	const explained = event.explanation
	const rawReason = event.kind === 'paused' ? event.reason : event.message
	const freeRefused = isZenFreeTierRefusal({
		providerId: event.providerError?.providerId ?? stringOf(event.failure?.details?.providerId),
		status: event.providerError?.status,
		detail: event.providerError?.detail ?? rawReason,
	})
	const unpriced = unpricedSpendLimit(event)
	const lead = line(
		unpriced !== undefined
			? `Namzu has no price on file for ${unpriced}, so it cannot count spend against the limit.`
			: freeRefused
				? ZEN_FREE_REFUSED_WHAT
				: explained?.message || rawReason,
	)
	const id = explained?.id ? ` [${line(explained.id, 120)}]` : ''
	const rows = [`${event.kind === 'paused' ? 'Reply paused' : 'Error'}${id}: ${lead}`]
	const providerId = event.providerError?.providerId ?? event.failure?.details?.providerId
	if (typeof providerId === 'string' && providerId.trim()) {
		rows.push(`Provider: ${line(providerId, 120)}`)
	}

	const providerDetail = event.providerError?.detail
	if (providerDetail && materiallyDifferent(providerDetail, [lead, rawReason])) {
		rows.push(`Provider detail: ${line(providerDetail)}`)
	}
	if (
		unpriced === undefined &&
		explained &&
		materiallyDifferent(rawReason, [lead, providerDetail ?? ''])
	) {
		rows.push(`Reason: ${line(rawReason)}`)
	}

	// The kernel appends " · automatic compaction failed: <cause>" to the
	// overflow it gave up on when compaction itself errored. The provider's own
	// sentence usually contains the rest of the message, which hides it from the
	// rows above, so it is read out on its own.
	const compactionCause = /automatic compaction failed: (.+)$/s.exec(rawReason)?.[1]
	if (compactionCause)
		rows.push(`Compaction: automatic compaction failed: ${line(compactionCause, 320)}`)

	const retryAfter = retryAfterMs(event)
	if (retryAfter !== undefined) {
		rows.push(`Provider retry delay: at least ${duration(retryAfter)} from this failure.`)
	}
	if (unpriced !== undefined)
		rows.push(
			'Next: Remove the spend limit and bound the run with a token limit instead, or choose a model Namzu has a price for.',
		)
	else if (freeRefused) rows.push(`Next: ${ZEN_FREE_REFUSED_NEXT}`)
	else if (explained?.hint) rows.push(`Next: ${line(explained.hint, 720)}`)
	if (event.kind === 'paused') {
		rows.push(`Checkpoint preserved: ${line(event.checkpointId, 180)}`)
	}

	return rows.join('\n')
}

/**
 * A turn a tool paused for a person: what the person has to do, and the
 * facts the tool attached. Nothing failed, so there is no error copy.
 */
function describeHandoff(event: Extract<Interruption, { kind: 'paused' }>): string {
	const handoff = event.handoff
	const rows = [`Paused. ${line(handoff?.reason ?? event.reason)}`]
	for (const [key, value] of Object.entries(handoff?.detail ?? {})) {
		rows.push(`${detailLabel(line(key, 60))}: ${line(value, 240)}`)
	}
	rows.push(`Checkpoint preserved: ${line(event.checkpointId, 180)}`)
	return rows.join('\n')
}

/**
 * What the terminal says when `/abandon`, `/resume` or a parked scheduled
 * run's Abandon acts on a paused turn. In words, never the turn's id: an id
 * is a handle for the log, and "Abandoned turn 0199…" read to a person as an
 * error code.
 */
export const PAUSED_TURN_LINES = {
	abandoned: 'Stopped the paused reply. Your next message starts a new one in this conversation.',
	resuming: 'Continuing where it paused…',
	abandonedScheduled: 'Stopped this run. The job stays scheduled.',
	/** The questions about tool calls were open when the session ended; the calls did not run. */
	unansweredReview:
		'Those calls were waiting for your approval when the session ended, so they did not run. Say what to do next.',
} as const

/**
 * The system note for a turn continued after a tool paused it for a person
 * (a sign-in, a CAPTCHA). The turn's last result is the tool saying it
 * needed someone; read alone, it looked final, and a scheduled run the
 * operator had signed in again for ended with "I couldn't complete the post
 * because the page showed a sign-in page".
 */
export function handoffContinuationNote(
	reason: string,
	now: Date = new Date(),
	tz: string = hostTimeZone(),
): string {
	const flat = terminalDisplayText(reason).replace(/\s+/g, ' ').trim()
	return [
		`This turn stopped because a tool needed a person: ${flat}. The person chose to continue; that choice does not confirm the issue was resolved.`,
		'Try the step that stopped again once (for a web page, open or reload it and read it again) before deciding it cannot be done. If the tool still needs a person, explain what remains and stop; never type a password or a code.',
		currentTimeLine(now, tz),
	].join('\n')
}
