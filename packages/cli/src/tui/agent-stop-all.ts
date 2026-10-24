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

export type StopAllStep =
	| { readonly kind: 'none'; readonly notice: string }
	| { readonly kind: 'arm'; readonly notice: string }
	| { readonly kind: 'stop'; readonly notice: string }

function agentsPhrase(count: number): string {
	return count === 1 ? '1 background agent' : `${count} background agents`
}

/** What one press of the chord does, given how many agents could be stopped and whether it is armed. */
export function stopAllStep(running: number, armed: boolean): StopAllStep {
	if (running === 0) return { kind: 'none', notice: 'No background agents running' }
	if (!armed) {
		return {
			kind: 'arm',
			notice: `Press ctrl+x ctrl+k again to stop ${agentsPhrase(running)}`,
		}
	}
	return {
		kind: 'stop',
		notice: `${agentsPhrase(running)} stopped`,
	}
}
