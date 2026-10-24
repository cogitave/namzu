/**
 * The stop-all chord for background agents (`ctrl+x ctrl+k`), as plain data.
 *
 * The chord works from the composer and from the rail. Nothing running says
 * so; the first press arms a short confirm; the second press inside the
 * window (3 s) stops every background agent still going and says how many.
 */

import type { SubagentActivity } from '../integrations/subagents/activity.js'
import { railActionFor } from './AgentExplorer.js'

/** How long the first press waits for the second. */
export const STOP_ALL_CONFIRM_MS = 3000

/** The agents the chord stops: background agents that have not finished. */
export function stoppableBackgroundAgents(
	agents: readonly SubagentActivity[],
): readonly SubagentActivity[] {
	return agents.filter((agent) => agent.background === true && railActionFor(agent) === 'stop')
}

/** How long the "nothing running" footer notice stays (2 s). */
export const STOP_ALL_NONE_MS = 2000

/**
 * What one press does. `none` and `arm` are footer notices that time out on
 * their own (2 s and 3 s); only
 * `stop` leaves a transcript row.
 */
export type StopAllStep =
	| {
			readonly kind: 'none'
			readonly notice: string
			readonly footerMs: number
	  }
	| { readonly kind: 'arm'; readonly notice: string; readonly footerMs: number }
	| { readonly kind: 'stop'; readonly notice: string }

/** The transcript row after the second press (a red dot, "All background agents stopped"). */
export const STOP_ALL_DONE_TEXT = 'All background agents stopped'

/** What one press of the chord does, given how many agents could be stopped and whether it is armed. */
export function stopAllStep(running: number, armed: boolean): StopAllStep {
	if (running === 0)
		return {
			kind: 'none',
			notice: 'No background agents running',
			footerMs: STOP_ALL_NONE_MS,
		}
	if (!armed) {
		return {
			kind: 'arm',
			notice: 'Press ctrl+x ctrl+k again to stop background agents',
			footerMs: STOP_ALL_CONFIRM_MS,
		}
	}
	return { kind: 'stop', notice: STOP_ALL_DONE_TEXT }
}
