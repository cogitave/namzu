/**
 * TUI entry. `launchTui()` renders the React tree and resolves when the
 * user exits. Called by `cli.ts`'s default action (no subcommand).
 */

import { render } from 'ink'
import React from 'react'

import { App } from './App.js'
import type { TuiContext } from './types.js'

export async function launchTui(ctx: TuiContext): Promise<void> {
	const instance = render(React.createElement(App, { ctx }), {
		stdout: process.stdout,
		stderr: process.stderr,
		stdin: process.stdin,
		exitOnCtrlC: false,
	})
	await instance.waitUntilExit()
}
