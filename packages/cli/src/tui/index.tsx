/**
 * TUI entry. `launchTui()` renders the React tree and resolves when the
 * user exits. Called by `cli.ts`'s default action (no subcommand).
 */

import { configureLogger } from '@namzu/sdk'
import { render } from 'ink'
import React from 'react'

import { App } from './App.js'
import type { TuiContext } from './types.js'

export async function launchTui(ctx: TuiContext): Promise<void> {
	// The SDK agent loop logs to stdout/stderr; Ink owns the terminal, so
	// any stray log line corrupts the rendered frame. Silence the SDK
	// logger for the lifetime of the TUI.
	configureLogger({ level: 'silent' })
	// Take over the terminal: clear the screen + scrollback and home the
	// cursor so namzu opens on a clean canvas (like claude-code / gemini-cli)
	// rather than below leftover shell output. Stays in the normal buffer so
	// native scrollback still works as the transcript grows.
	if (process.stdout.isTTY) {
		process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
	}
	const instance = render(React.createElement(App, { ctx }), {
		stdout: process.stdout,
		stderr: process.stderr,
		stdin: process.stdin,
		exitOnCtrlC: false,
	})
	await instance.waitUntilExit()
}
