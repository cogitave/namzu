import { homedir } from 'node:os'

import { setUserConfigValue } from '../config/user-config.js'
import { runTerminalSetup } from '../terminal-setup/setup.js'
import { clearFailedStarts, failedStartOnRecord } from './fullscreen/boot-canary.js'
import { getScreenModeNow } from './fullscreen/mode.js'
import { explainFailure } from './plain-failure.js'

/**
 * `/tui` and `/terminal setup`. Both run only when the person types them.
 */

export const TUI_USAGE = 'Usage: /tui <default|fullscreen>'

interface Options {
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}

function modeName(fullscreen: boolean): string {
	return fullscreen ? 'fullscreen' : 'the normal screen'
}

/** `/tui [default|fullscreen]`: show or save which screen Namzu starts on. */
export function tuiCommandText(args: readonly string[], opts: Options = {}): string {
	const env = opts.env ?? process.env
	const now = getScreenModeNow()
	const record = failedStartOnRecord(opts.home)
	if (args.length === 0) {
		const lines = [
			`Namzu is using ${now === undefined ? 'the screen it started on' : modeName(now.fullscreen)}.`,
		]
		if (record === 'repeated')
			lines.push(
				'Fullscreen was turned off on this machine after it repeatedly failed to start. /tui fullscreen tries it again.',
			)
		else if (record === 'once')
			lines.push(
				"A fullscreen start on this machine didn't finish last time. /tui fullscreen tries it again.",
			)
		lines.push(TUI_USAGE)
		return lines.join('\n')
	}
	const word = args[0]?.toLowerCase()
	if (args.length !== 1 || (word !== 'default' && word !== 'fullscreen'))
		return `Unknown screen mode "${args.join(' ')}". ${TUI_USAGE}`
	const wantFullscreen = word === 'fullscreen'
	// Any switch forgets the failed starts, so a later launch tries again.
	clearFailedStarts(opts.home)
	try {
		setUserConfigValue(['tui', 'fullscreen'], wantFullscreen, {
			...(opts.home ? { home: opts.home } : {}),
			env,
		})
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} Nothing was changed.`
	}
	const lines = [
		now !== undefined && now.fullscreen === wantFullscreen && !now.autoOff
			? `Already using ${modeName(wantFullscreen)}. Saved as your choice.`
			: `Saved. Namzu will use ${modeName(wantFullscreen)} the next time it starts; restart Namzu to switch now.`,
	]
	if (env.NAMZU_FULLSCREEN !== undefined)
		lines.push('NAMZU_FULLSCREEN is set in your environment and wins over this setting.')
	return lines.join('\n')
}

/** `/terminal setup`: set up the newline key for the terminal Namzu runs in. */
export function terminalSetupText(
	opts: { readonly env?: NodeJS.ProcessEnv; readonly home?: string } = {},
): string {
	return runTerminalSetup({
		env: opts.env ?? process.env,
		platform: process.platform,
		home: opts.home ?? homedir(),
	})
}
