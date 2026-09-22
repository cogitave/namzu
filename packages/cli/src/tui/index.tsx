/**
 * TUI entry. `launchTui()` renders the React tree and resolves when the
 * user exits. Called by `cli.ts`'s default action (no subcommand).
 */

import { resolve } from 'node:path'

import { render } from 'ink'
import React from 'react'

import { App } from './App.js'
import {
	type TuiExitSummary,
	type TuiResumeInvocation,
	formatTuiExitSummary,
} from './exit-summary.js'
import { type TerminationSignal, handleTerminationSignals } from '../termination.js'
import { installTuiLogSink } from './log-pane.js'
import type { TuiContext } from './types.js'

export async function launchTui(
	ctx: TuiContext,
	options: { readonly resumeCommand?: readonly [string, ...string[]] } = {},
): Promise<void> {
	const invocation: TuiResumeInvocation = { cwd: resolve(ctx.cwd), command: options.resumeCommand }
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
	// SIGTERM, SIGHUP and SIGINT give the conversation back and leave cleanly
	// (`termination.ts`): the turn's lease is released first, so the next
	// process can /resume or /abandon at once, then the App leaves as `/exit`
	// does, which is what hands the terminal back.
	const termination = handleTerminationSignals()
	const terminationExit: { current: (() => void) | null } = { current: null }
	let terminatedBy: TerminationSignal | null = null
	const instance = render(
		React.createElement(App, {
			ctx,
			onExitSummary: (summary: TuiExitSummary) => {
				exitSummary = summary
			},
			terminationExit,
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
	termination.onTerminate(async (signal) => {
		terminatedBy = signal
		if (signal === 'SIGHUP') {
			// The terminal is gone, so Ink's last frame and the terminal reset fail
			// to write. That must not end the process ahead of the cleanup.
			process.stdout.on('error', () => undefined)
			process.stderr.on('error', () => undefined)
		}
		if (terminationExit.current) terminationExit.current()
		else instance.unmount()
		await instance.waitUntilExit()
	})
	try {
		await instance.waitUntilExit()
	} finally {
		termination.dispose()
		logs.close()
		// A hangup means the terminal is gone: nobody is there to read the
		// handoff, and writing to it fails.
		const summary = terminatedBy === 'SIGHUP' ? '' : formatTuiExitSummary(exitSummary, invocation)
		if (summary.length > 0) process.stdout.write(summary)
	}
}
