/**
 * `/config triggers on|off|list`: write `composerTriggers.enabled` to the user
 * config, then read the whole cascade back and say whether the value holds.
 *
 * A project file cannot switch the feature on over the user file (it can
 * only turn things down), but the managed file can force it either way, and
 * a project file may have turned it off. Writing the user file and saying
 * "done" would then be false the next time namzu starts, so the message
 * names the file that wins. The running session follows the operator's
 * choice either way.
 */

import { COMPOSER_TRIGGER_IDS, resolveComposerTriggers } from '../../config/composer-triggers.js'
import { formatConfigSource } from '../../config/debug.js'
import { type LoadConfigOptions, loadConfigWithProvenance } from '../../config/load.js'
import { setUserConfigValue } from '../../config/user-config.js'

type CascadeOptions = Pick<LoadConfigOptions, 'cwd' | 'env' | 'home' | 'profile' | 'managedPath'>

export function setComposerTriggers(on: boolean, opts: CascadeOptions = {}): string {
	let file: string
	try {
		file = setUserConfigValue(['composerTriggers', 'enabled'], on, {
			...(opts.home ? { home: opts.home } : {}),
			...(opts.env ? { env: opts.env } : {}),
		})
	} catch (error) {
		return `Could not save composerTriggers.enabled: ${error instanceof Error ? error.message : String(error)} This session ${on ? 'reads' : 'ignores'} composer triggers until it ends.`
	}
	const saved = on
		? `Composer triggers are on: hypermode and save-as-skill words in a message act for that message, shown before you send it (alt+w drops one). Saved composerTriggers.enabled: true to ${file}.`
		: `Composer triggers are off: words in a message are only words. Saved composerTriggers.enabled: false to ${file}; /config triggers on turns them back on. /hypermode and /skills save still work.`
	let resolved: ReturnType<typeof loadConfigWithProvenance>
	try {
		resolved = loadConfigWithProvenance(opts)
	} catch (error) {
		return `${saved} Could not check the other config files (${error instanceof Error ? error.message : String(error)}); this session follows your choice.`
	}
	const effective = resolveComposerTriggers(resolved.config.composerTriggers).enabled
	if (effective === on) return saved
	const source = resolved.provenance.composerTriggers
	const winner = source ? formatConfigSource(source) : 'another config layer'
	return `${saved} But ${winner} turns them ${effective ? 'on' : 'off'}, so from the next start they will be ${effective ? 'on' : 'off'}; this session follows your choice.`
}

/** `/config triggers list`: what is in force, one line per setting. */
export function describeComposerTriggers(enabledNow: boolean, opts: CascadeOptions = {}): string {
	let config: ReturnType<typeof loadConfigWithProvenance>['config']['composerTriggers']
	try {
		config = loadConfigWithProvenance(opts).config.composerTriggers
	} catch (error) {
		return `Could not read the config files: ${error instanceof Error ? error.message : String(error)}`
	}
	const settings = resolveComposerTriggers(config)
	return [
		`Composer triggers: ${enabledNow ? 'on' : 'off'} in this session${enabledNow === settings.enabled ? '' : ` (the config files say ${settings.enabled ? 'on' : 'off'})`}.`,
		`Suggestions: ${settings.suggest ? 'on' : 'off'} · languages: ${settings.languages.join(', ')}`,
		...COMPOSER_TRIGGER_IDS.map((id) => `  ${id}: ${settings.arming[id]}`),
		'Change them under composerTriggers in ~/.namzu/config.yaml; /config triggers on|off switches all of them.',
	].join('\n')
}
