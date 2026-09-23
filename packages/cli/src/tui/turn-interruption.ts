import { type SessionTokenBudgetSummary, type StopReason, hostTimeZone } from '@namzu/sdk'

import { localTimeText } from '../schedule/fire/unattended-note.js'

import type { AgentEvent } from './agent.js'
import { terminalDisplayText } from './terminal-display.js'

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
				return 'Turn stopped: usage for a model request could not be confirmed. /cost shows reported usage; the total remains uncertain.'
			if (budget?.poisoned)
				return 'Turn stopped: usage accounting could not be verified. /cost shows the available measurements.'
			return 'Turn stopped: the token allowance could not cover further work. /cost shows reported usage.'
		case 'cost_limit':
			return 'Turn stopped: the cost allowance could not cover further work. /cost shows reported usage.'
		case 'cost_unmeasurable':
			return 'Turn stopped: missing pricing prevented checking the cost limit. /cost shows reported usage.'
		case 'timeout':
			return 'Turn stopped: the time limit was reached.'
		case 'max_iterations':
			return 'Turn stopped: the step limit was reached.'
		case 'plan_rejected':
			return 'Turn stopped: the plan was rejected.'
		case 'stop_condition':
			return 'Turn stopped: the configured stop condition was met.'
		case 'step_refused':
			return 'Turn stopped: the next model call was refused.'
		case 'structured_output_failed':
			return 'Turn stopped: no valid structured result was produced.'
		case 'answer_rejected':
			return 'Turn stopped: the final answer was not accepted.'
		case 'input_guardrail':
			return 'Turn stopped: an input check refused this turn.'
		case 'output_guardrail':
			return 'Turn stopped: an output check refused the result.'
		case 'paused':
			return 'Turn paused.'
		case 'error':
			return 'Turn stopped after an error.'
	}
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

function duration(ms: number): string {
	if (ms < 1_000) return `${Math.ceil(ms)} ms`
	const seconds = Math.ceil(ms / 1_000)
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
	const lead = line(explained?.message || rawReason)
	const id = explained?.id ? ` [${line(explained.id, 120)}]` : ''
	const rows = [`${event.kind === 'paused' ? 'Turn paused' : 'Error'}${id}: ${lead}`]

	const providerDetail = event.providerError?.detail
	if (providerDetail && materiallyDifferent(providerDetail, [lead, rawReason])) {
		rows.push(`Provider detail: ${line(providerDetail)}`)
	}
	if (explained && materiallyDifferent(rawReason, [lead, providerDetail ?? ''])) {
		rows.push(`Reason: ${line(rawReason)}`)
	}

	const retryAfter = retryAfterMs(event)
	if (retryAfter !== undefined) {
		rows.push(`Provider retry delay: at least ${duration(retryAfter)} from this failure.`)
	}
	if (explained?.hint) rows.push(`Next: ${line(explained.hint, 720)}`)
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
	const rows = [`Turn paused — needs you: ${line(handoff?.reason ?? event.reason)}`]
	for (const [key, value] of Object.entries(handoff?.detail ?? {})) {
		rows.push(`${line(key, 60)}: ${line(value, 240)}`)
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
	abandoned: 'Stopped the paused turn. Your next message starts a new one in this conversation.',
	resuming: 'Continuing where it paused…',
	abandonedScheduled: 'Stopped this run. The job stays scheduled.',
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
		`This turn stopped because a tool needed a person: ${flat}. The person has dealt with it and chose to continue.`,
		'Try the step that stopped again (for a web page, open or reload it and read it again) before deciding it cannot be done. If it still needs a person, say so and stop; never type a password or a code.',
		`It is now ${localTimeText(now, tz)}.`,
	].join('\n')
}
