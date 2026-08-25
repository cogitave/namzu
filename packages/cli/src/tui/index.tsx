/**
 * TUI entry. `launchTui()` renders the React tree and resolves when the
 * user exits. Called by `cli.ts`'s default action (no subcommand).
 */

import { render } from 'ink'
import React from 'react'

import { App } from './App.js'
import { type TuiExitSummary, formatTuiExitSummary } from './exit-summary.js'
import { installTuiLogSink } from './log-pane.js'
import type { TuiContext } from './types.js'

export async function launchTui(ctx: TuiContext): Promise<void> {
	// Ink owns the terminal for the life of this function: it repaints the
	// screen from its own virtual buffer, and any other write to
	// stdout/stderr while it holds the terminal corrupts the frame
	// mid-repaint. The previous fix for that forced the SDK logger's level
	// to `silent` via `configureLogger`, which threw every diagnostic away
	// rather than choosing where it belonged (LOG-05). `installTuiLogSink`
	// buffers instead of writing. A crash flushes that bounded buffer; a clean
	// exit discards it and prints only the concise conversation handoff below.
	const logs = installTuiLogSink(ctx.logging)
	let exitSummary: TuiExitSummary | null = null
	// Take over the terminal: clear the screen + scrollback and home the
	// cursor so namzu opens on a clean canvas
	// rather than below leftover shell output. Stays in the normal buffer so
	// native scrollback still works as the transcript grows.
	if (process.stdout.isTTY) {
		process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
	}
	const instance = render(
		React.createElement(App, {
			ctx,
			onExitSummary: (summary: TuiExitSummary) => {
				exitSummary = summary
			},
		}),
		{
			stdout: process.stdout,
			stderr: process.stderr,
			stdin: process.stdin,
			exitOnCtrlC: false,
			kittyKeyboard: {
				mode: 'auto',
				flags: ['disambiguateEscapeCodes'],
			},
		},
	)
	try {
		await instance.waitUntilExit()
	} finally {
		logs.close()
		const summary = formatTuiExitSummary(exitSummary)
		if (summary.length > 0) process.stdout.write(summary)
	}
}
