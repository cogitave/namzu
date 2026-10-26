/**
 * The theme and motion the terminal UI starts with, from the user config.
 * For `auto`, the terminal is asked for its background colour once, before the
 * UI takes over the keyboard; no answer within a moment means the environment's
 * hint, then dark.
 */

import type { TuiConfig } from '../config/schema.js'
import { setReducedMotion } from './motion.js'
import {
	type BackgroundQueryStreams,
	backgroundFromColorFgBg,
	queryTerminalBackground,
} from './theme-detect.js'
import { setThemeSetting } from './theme-store.js'

/** How long the terminal has to answer the background query. */
export const BACKGROUND_QUERY_WAIT_MS = 250

/**
 * Returns nothing to wait for unless the terminal has to be asked, so the
 * ordinary start does not yield before the UI mounts.
 */
export function applyLaunchTheme(
	tui: Pick<TuiConfig, 'theme' | 'reducedMotion'> | undefined,
	streams: BackgroundQueryStreams | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> | undefined {
	setReducedMotion(tui?.reducedMotion === true)
	const setting = tui?.theme ?? 'dark'
	if (setting !== 'auto') {
		setThemeSetting(setting, { env })
		return undefined
	}
	const settle = (reported: 'dark' | 'light' | undefined): void => {
		const answer = reported ?? backgroundFromColorFgBg(env.COLORFGBG)
		setThemeSetting('auto', { env, ...(answer ? { reported: answer } : {}) })
	}
	if (!streams) {
		settle(undefined)
		return undefined
	}
	return askTerminal(streams).then(settle)
}

async function askTerminal(streams: BackgroundQueryStreams): Promise<'dark' | 'light' | undefined> {
	let timer: NodeJS.Timeout | undefined
	const giveUp = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, BACKGROUND_QUERY_WAIT_MS)
	})
	try {
		return await queryTerminalBackground(streams, giveUp)
	} finally {
		clearTimeout(timer)
	}
}
