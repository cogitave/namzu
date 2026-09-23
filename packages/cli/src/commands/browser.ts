/**
 * `namzu browser <verb>`: profiles, sign-in, and which browser runs here.
 * The verbs live in `../browser/commands.ts`. See docs/cli/browser.md.
 */

import { BROWSER_HELP } from '../browser/commands.js'
import type { CommandDef } from './types.js'

export const browserCommand: CommandDef = {
	name: 'browser',
	description: 'Browser profiles for the browser tools: sign in, list, status, install, remove',
	passThrough: true,
	help: BROWSER_HELP,
	handler: async ({ ctx, rawArgs }) => {
		const { browserCommand: run } = await import('../browser/commands.js')
		return run(ctx, rawArgs)
	},
}
