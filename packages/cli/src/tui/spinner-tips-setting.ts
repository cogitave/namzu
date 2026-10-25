/**
 * `/config tips on|off`: write `tui.spinnerTips` to the user config, then read
 * the whole cascade back and say whether the value holds, the way
 * `/config triggers` does. The running session follows the choice either way.
 */

import { formatConfigSource } from '../config/debug.js'
import { type LoadConfigOptions, loadConfigWithProvenance } from '../config/load.js'
import { setUserConfigValue } from '../config/user-config.js'
import { explainFailure } from './plain-failure.js'

type CascadeOptions = Pick<LoadConfigOptions, 'cwd' | 'env' | 'home' | 'profile' | 'managedPath'>

export function setSpinnerTips(on: boolean, opts: CascadeOptions = {}): string {
	try {
		setUserConfigValue(['tui', 'spinnerTips'], on, {
			...(opts.home ? { home: opts.home } : {}),
			...(opts.env ? { env: opts.env } : {}),
		})
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} This conversation ${on ? 'shows' : 'hides'} tips until it ends.`
	}
	const saved = on
		? 'Tips are on: one short tip shows under the working row.'
		: 'Tips are off. /config tips on turns them back on. The next task still shows under the working row.'
	let resolved: ReturnType<typeof loadConfigWithProvenance>
	try {
		resolved = loadConfigWithProvenance(opts)
	} catch (error) {
		return `${saved} ${explainFailure(error, 'Could not check the other config files.')} This conversation follows your choice.`
	}
	const effective = resolved.config.tui?.spinnerTips !== false
	if (effective === on) return saved
	const source = resolved.provenance.tui
	const winner = source ? formatConfigSource(source) : 'another config layer'
	return `${saved} But ${winner} turns them ${effective ? 'on' : 'off'}, so from the next start they will be ${effective ? 'on' : 'off'}; this conversation follows your choice.`
}
