/**
 * TUI entry. `launchTui()` renders the React tree and resolves when the
 * user exits. Called by `cli.ts`'s default action (no subcommand).
 */

import { render } from 'ink'
import React from 'react'

import { App } from './App.js'
import { installTuiLogSink } from './log-pane.js'
import type { TuiContext } from './types.js'

export async function launchTui(ctx: TuiContext): Promise<void> {
	// Ink owns the terminal for the life of this function: it repaints the
	// screen from its own virtual buffer, and any other write to
	// stdout/stderr while it holds the terminal corrupts the frame
	// mid-repaint. The previous fix for that forced the SDK logger's level
	// to `silent` via `configureLogger`, which threw every diagnostic away
	// rather than choosing where it belonged (LOG-05). `installTuiLogSink`
	// buffers instead of writing, and flushes to stderr only once Ink has
	// released the terminal — on the clean exit below, or on a crash Ink
	// itself did not catch (registered inside `log-pane.tsx`).
	const drain = installTuiLogSink(ctx.logging)
	// Take over the terminal: clear the screen + scrollback and home the
	// cursor so namzu opens on a clean canvas
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
	try {
		await instance.waitUntilExit()
	} finally {
		drain()
	}
}
