import type { TeamsConfig } from '../../config/schema.js'

/**
 * Whether teammates are on, and the limits they run under.
 *
 * Off unless a person turned them on: the `teams.enabled` setting, `NAMZU_TEAMS=1` or the `--teams` flag
 * (which the launcher carries as a settings layer, so it reads here as the setting). `NAMZU_TEAMS=0` (or
 * `off`, `false`) is a hard stop that wins over both. A headless run (one-shot `exec`, print, a schedule,
 * `serve`, a Pal) never starts teammates, whatever is set.
 *
 * Callers pass functions, not values, and ask again at every named `Agent` call, so a change to the
 * setting or the environment takes effect on the next call without a restart. Teammates already running
 * are not affected by a later switch off.
 */
export const TEAMS_ENV = 'NAMZU_TEAMS'

export const DEFAULT_MAX_TEAMMATES = 5
export const DEFAULT_IDLE_EXIT_MINUTES = 30

export type TeamsOffReason = 'disabled' | 'env-off' | 'headless'

export type TeamsDecision =
	| { readonly enabled: true; readonly source: 'setting' | 'env' }
	| { readonly enabled: false; readonly reason: TeamsOffReason; readonly text: string }

export interface TeamsGateInput {
	/** The `teams` section of the resolved config, read now. */
	readonly config: () => TeamsConfig | undefined
	readonly env: () => NodeJS.ProcessEnv
	/** True for a terminal or Desktop session with a person at it; false for every headless run. */
	readonly interactive: boolean
}

const OFF_WORDS = new Set(['0', 'off', 'false', 'no'])
const ON_WORDS = new Set(['1', 'on', 'true', 'yes'])

export function decideTeams(input: TeamsGateInput): TeamsDecision {
	const word = input.env()[TEAMS_ENV]?.trim().toLowerCase()
	if (word !== undefined && OFF_WORDS.has(word))
		return {
			enabled: false,
			reason: 'env-off',
			text: `Teammates are off: ${TEAMS_ENV} is set to ${word}.`,
		}
	if (!input.interactive)
		return {
			enabled: false,
			reason: 'headless',
			text: 'Teammates run only in a conversation with a person at it, not in a one-shot or scheduled run.',
		}
	if (word !== undefined && ON_WORDS.has(word)) return { enabled: true, source: 'env' }
	if (input.config()?.enabled === true) return { enabled: true, source: 'setting' }
	return {
		enabled: false,
		reason: 'disabled',
		text: 'Teammates are off. Turn them on in Settings, or start with --teams.',
	}
}

/** The one question every caller asks. */
export function teamsEnabled(input: TeamsGateInput): boolean {
	return decideTeams(input).enabled
}

export interface TeamsLimits {
	readonly maxTeammates: number
	readonly idleExitMinutes: number
}

export function teamsLimits(config: TeamsConfig | undefined): TeamsLimits {
	return {
		maxTeammates: config?.maxTeammates ?? DEFAULT_MAX_TEAMMATES,
		idleExitMinutes: config?.idleExitMinutes ?? DEFAULT_IDLE_EXIT_MINUTES,
	}
}
