/**
 * `/config showTurnDuration on|off`: write `tui.showTurnDuration` to the user
 * config, then read the whole cascade back and say whether the value holds,
 * the way `/config tips` does. The running session follows the choice either way.
 */

import { formatConfigSource } from '../config/debug.js'
import { type LoadConfigOptions, loadConfigWithProvenance } from '../config/load.js'
import { DEFAULT_SHOW_TURN_DURATION } from '../config/turn-duration-default.js'
import { setUserConfigValue } from '../config/user-config.js'
import { explainFailure } from './plain-failure.js'

type CascadeOptions = Pick<LoadConfigOptions, 'cwd' | 'env' | 'home' | 'profile' | 'managedPath'>

export function describeTurnDuration(on: boolean): string {
	return on
		? 'Turn duration is on: each reply ends with how long it took and when it finished. /config showTurnDuration off turns it off.'
		: 'Turn duration is off: replies end without the time line. /config showTurnDuration on turns it back on.'
}

export function setShowTurnDuration(on: boolean, opts: CascadeOptions = {}): string {
	try {
		setUserConfigValue(['tui', 'showTurnDuration'], on, {
			...(opts.home ? { home: opts.home } : {}),
			...(opts.env ? { env: opts.env } : {}),
		})
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} This conversation ${on ? 'shows' : 'hides'} the turn duration until it ends.`
	}
	const saved = describeTurnDuration(on)
	let resolved: ReturnType<typeof loadConfigWithProvenance>
	try {
		resolved = loadConfigWithProvenance(opts)
	} catch (error) {
		return `${saved} ${explainFailure(error, 'Could not check the other config files.')} This conversation follows your choice.`
	}
	const effective = resolved.config.tui?.showTurnDuration ?? DEFAULT_SHOW_TURN_DURATION
	if (effective === on) return saved
	const source = resolved.provenance.tui
	const winner = source ? formatConfigSource(source) : 'another config layer'
	return `${saved} But ${winner} turns it ${effective ? 'on' : 'off'}, so from the next start it will be ${effective ? 'on' : 'off'}; this conversation follows your choice.`
}
