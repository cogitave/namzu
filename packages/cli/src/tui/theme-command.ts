/**
 * `/theme` and `/config motion`: change the setting for this run and keep it
 * in the user config (`tui.theme`, `tui.reducedMotion`), then say what happened.
 * A project file cannot set either, so the user file is the only place written.
 */

import { setUserConfigValue } from '../config/user-config.js'
import { reducedMotion, setReducedMotion } from './motion.js'
import { explainFailure } from './plain-failure.js'
import { THEME_NAMES, type ThemeSetting, parseThemeSetting, themeLabel } from './theme-palettes.js'
import { setThemeSetting } from './theme-store.js'

interface WriteOptions {
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}

/** The word typed after `/theme`, as a setting. */
export function parseThemeArgument(args: readonly string[]): ThemeSetting | undefined {
	if (args.length !== 1) return undefined
	return parseThemeSetting(args[0]?.toLowerCase())
}

export const THEME_USAGE = `Usage: /theme [auto|${THEME_NAMES.join('|')}]`

/** Apply and save a theme. The screen follows even when the file cannot be written. */
export function saveTheme(setting: ThemeSetting, opts: WriteOptions = {}): string {
	setThemeSetting(setting, opts.env ? { env: opts.env } : {})
	try {
		setUserConfigValue(['tui', 'theme'], setting, opts)
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} The theme stays ${themeLabel(setting)} until Namzu closes.`
	}
	return `Theme set to ${themeLabel(setting)}.`
}

/** Apply and save reduced motion. */
export function saveReducedMotion(on: boolean, opts: WriteOptions = {}): string {
	setReducedMotion(on)
	const saying = on
		? 'Reduced motion is on: the working line and the composer stay still.'
		: 'Reduced motion is off.'
	try {
		setUserConfigValue(['tui', 'reducedMotion'], on, opts)
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} ${saying} It lasts until Namzu closes.`
	}
	return saying
}

export function describeReducedMotion(): string {
	return reducedMotion()
		? 'Reduced motion is on. /config motion off turns the movement back on.'
		: 'Reduced motion is off. /config motion on keeps the working line and the composer still.'
}
