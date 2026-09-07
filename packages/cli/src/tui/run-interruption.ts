import type { StopReason } from '@namzu/sdk'

import type { AgentEvent } from './agent.js'
import { terminalDisplayText } from './terminal-display.js'

export type Interruption = Extract<AgentEvent, { kind: 'error' | 'paused' }>

/**
 * A completed event can carry a resource or policy stop without an error event.
 * Budget admission includes reservations: refusal is not proof of money or
 * tokens spent. Usage remains the reported measurement available through /cost.
 */
export function describeRunStop(reason: StopReason | undefined): string | undefined {
	switch (reason) {
		case undefined:
		case 'end_turn':
		case 'cancelled':
			return undefined
		case 'token_budget':
			return 'Run stopped: the token allowance could not cover further work. /cost shows reported usage.'
		case 'cost_limit':
			return 'Run stopped: the cost allowance could not cover further work. /cost shows reported usage.'
		case 'cost_unmeasurable':
			return 'Run stopped: missing pricing prevented checking the cost limit. /cost shows reported usage.'
		case 'timeout':
			return 'Run stopped: the time limit was reached.'
		case 'max_iterations':
			return 'Run stopped: the step limit was reached.'
		case 'plan_rejected':
			return 'Run stopped: the plan was rejected.'
		case 'stop_condition':
			return 'Run stopped: the configured stop condition was met.'
		case 'step_refused':
			return 'Run stopped: the next model call was refused.'
		case 'structured_output_failed':
			return 'Run stopped: no valid structured result was produced.'
		case 'answer_rejected':
			return 'Run stopped: the final answer was not accepted.'
		case 'input_guardrail':
			return 'Run stopped: an input check refused this run.'
		case 'output_guardrail':
			return 'Run stopped: an output check refused the result.'
		case 'paused':
			return 'Run paused.'
		case 'error':
			return 'Run stopped after an error.'
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
export function describeRunInterruption(event: Interruption): string {
	const explained = event.explanation
	const rawReason = event.kind === 'paused' ? event.reason : event.message
	const lead = line(explained?.message || rawReason)
	const id = explained?.id ? ` [${line(explained.id, 120)}]` : ''
	const rows = [`${event.kind === 'paused' ? 'Run paused' : 'Error'}${id}: ${lead}`]

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
