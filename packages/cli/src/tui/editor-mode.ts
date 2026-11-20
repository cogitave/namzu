/**
 * `/vim`: switch the message box between the usual keys and vim's, for this run,
 * and keep the choice in the user config (`tui.editorMode`). A project file cannot
 * set it, so the user file is the only place written.
 */

import { setUserConfigValue } from '../config/user-config.js'
import { explainFailure } from './plain-failure.js'

export type EditorMode = 'normal' | 'vim'

interface WriteOptions {
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}

/** What `/vim` was asked for: a flip, or one mode named. `undefined` when the words are not that. */
export function parseVimArgument(args: readonly string[]): EditorMode | 'toggle' | undefined {
	if (args.length === 0) return 'toggle'
	if (args.length !== 1) return undefined
	switch (args[0]?.toLowerCase()) {
		case 'on':
		case 'vim':
			return 'vim'
		case 'off':
		case 'normal':
			return 'normal'
		default:
			return undefined
	}
}

export const VIM_USAGE = 'Usage: /vim [on|off]'

/** The one line that says the new mode. */
export function describeEditorMode(mode: EditorMode): string {
	return mode === 'vim'
		? 'Editor mode is vim: the message box starts in insert mode and Esc goes to normal mode. /vim switches it back.'
		: 'Editor mode is normal: the message box uses the usual keys. /vim turns vim on.'
}

/** Save the mode in the user config and say it. A failed write keeps the mode for this run only. */
export function saveEditorMode(mode: EditorMode, opts: WriteOptions = {}): string {
	try {
		setUserConfigValue(['tui', 'editorMode'], mode, opts)
	} catch (error) {
		return `${explainFailure(error, 'Could not save that setting.')} ${describeEditorMode(mode)} It lasts until Namzu closes.`
	}
	return describeEditorMode(mode)
}
