/**
 * Whether the away recap is on, and how a person changes it.
 *
 * Order: `NAMZU_RECAP` set to `0`/`false`/`no`/`off` turns it off; set to
 * `1`/`true`/`yes`/`on` turns it on; a run with no screen (`exec`, `--json`)
 * never recaps; `tui.recap: false` turns it off; otherwise it is on.
 */

import type { TuiConfig } from '../config/schema.js'
import { deleteUserConfigValue, setUserConfigValue } from '../config/user-config.js'
import { RECAP_WAIT_MS } from './away-recap.js'
import { explainFailure } from './plain-failure.js'

const OFF_WORDS = new Set(['0', 'false', 'no', 'off'])
const ON_WORDS = new Set(['1', 'true', 'yes', 'on'])

export function recapEnabled(input: {
	readonly env: Readonly<Record<string, string | undefined>>
	readonly tui: Pick<TuiConfig, 'recap'> | undefined
	/** A screen a person is looking at; false for a run without one. */
	readonly interactive: boolean
}): boolean {
	const word = input.env.NAMZU_RECAP?.trim().toLowerCase()
	if (word !== undefined && OFF_WORDS.has(word)) return false
	if (word !== undefined && ON_WORDS.has(word)) return true
	if (!input.interactive) return false
	return input.tui?.recap !== false
}

/**
 * How long after a reply ended the recap is written, in milliseconds. Three
 * minutes unless `NAMZU_RECAP_WAIT_MS` names a whole number of milliseconds
 * (a way to test the recap without waiting).
 */
export function recapWaitMs(env: Readonly<Record<string, string | undefined>>): number {
	const raw = env.NAMZU_RECAP_WAIT_MS?.trim()
	if (raw === undefined || !/^\d{1,9}$/u.test(raw)) return RECAP_WAIT_MS
	return Number(raw)
}

/**
 * `/config recap on|off`: off writes `tui.recap: false` to the user config, on
 * removes the key (on is the default). Says so when the environment decides
 * otherwise for later starts.
 */
export function setRecapSetting(
	on: boolean,
	opts: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string {
	const env = opts.env ?? process.env
	try {
		const target = { ...(opts.home ? { home: opts.home } : {}), env }
		if (on) deleteUserConfigValue(['tui', 'recap'], target)
		else setUserConfigValue(['tui', 'recap'], false, target)
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} This conversation ${on ? 'shows' : 'skips'} recaps until it ends.`
	}
	const saved = on
		? 'Recaps are on: after a few minutes away, a one-line recap of where things stand is shown when you come back.'
		: 'Recaps are off. /config recap on turns them back on; /recap still writes one on request.'
	const word = env.NAMZU_RECAP?.trim().toLowerCase()
	if (word !== undefined && (OFF_WORDS.has(word) || ON_WORDS.has(word))) {
		const forced = ON_WORDS.has(word)
		if (forced !== on) {
			return `${saved} But NAMZU_RECAP is set in the environment and turns them ${forced ? 'on' : 'off'} on the next start; this conversation follows your choice.`
		}
	}
	return saved
}

/** `/config recap list`: what is in force. */
export function describeRecapSetting(input: {
	readonly enabledNow: boolean
	readonly env: Readonly<Record<string, string | undefined>>
	readonly tui: Pick<TuiConfig, 'recap'> | undefined
}): string {
	const fromFiles = input.tui?.recap !== false
	const word = input.env.NAMZU_RECAP?.trim().toLowerCase()
	const lines = [`Recaps: ${input.enabledNow ? 'on' : 'off'} in this conversation.`]
	lines.push(`Config files: ${fromFiles ? 'on (the default)' : 'off'}.`)
	if (word !== undefined && (OFF_WORDS.has(word) || ON_WORDS.has(word))) {
		lines.push(`NAMZU_RECAP is set and turns them ${ON_WORDS.has(word) ? 'on' : 'off'}.`)
	}
	lines.push('/config recap on|off changes it; /recap writes one now.')
	return lines.join('\n')
}
