/**
 * TUI entry. `launchTui()` renders the React tree and resolves when the
 * user exits. Called by `cli.ts`'s default action (no subcommand).
 */

import { resolve } from 'node:path'

import { render } from 'ink'
import React from 'react'

import { type TerminationSignal, handleTerminationSignals } from '../termination.js'
import { resolveMouseMode, writeLaunchMouseReset } from '../workspaces/mouse.js'
import { hostedByHost, workspacesSignal } from '../workspaces/signal.js'
import { App } from './App.js'
import { openConsoleInput } from './console-input.js'
import {
	type TuiExitSummary,
	type TuiResumeInvocation,
	formatTuiExitSummary,
} from './exit-summary.js'
import { installFocusReporting } from './focus-reporting.js'
import { resolveFullscreen } from './fullscreen/mode.js'
import {
	FULLSCREEN_PANIC_RESET,
	type PointerReport,
	type WheelDirection,
	installMouseWheel,
} from './fullscreen/mouse-wheel.js'
import { fileQueuedHintCount } from './hint-counts.js'
import { installTuiLogSink } from './log-pane.js'
import { watchOutputSize } from './output-size-watch.js'
import { type LivePaint, createLivePaint, startOnFreshLine } from './paint/live-paint.js'
import { installPasteMarkerGuard } from './paste-marker-guard.js'
import { liveRenderOption } from './render-mode.js'
import { terminalFocus } from './terminal-focus.js'
import { applyLaunchTheme } from './theme-launch.js'
import { fileTipHistory } from './tip-history.js'
import type { TuiContext } from './types.js'
import { leaveWorkspacesBounded } from './zoom/leave.js'
import { type TerminalProxy, createTerminalProxy } from './zoom/proxy.js'

/** How long leaving may wait for the workspaces screen to hand the terminal back. */
const LEAVE_WORKSPACES_MS = 2000

export async function launchTui(
	ctx: TuiContext,
	options: { readonly resumeCommand?: readonly [string, ...string[]] } = {},
): Promise<void> {
	const invocation: TuiResumeInvocation = {
		cwd: resolve(ctx.cwd),
		command: options.resumeCommand,
		...(ctx.palId ? { palId: ctx.palId } : {}),
	}
	// Ink owns the terminal for the life of this function: it repaints the
	// screen from its own virtual buffer, and any other write to
	// stdout/stderr while it holds the terminal corrupts the frame
	// mid-repaint. The previous fix for that forced the SDK logger's level
	// to `silent` via `configureLogger`, which threw every diagnostic away
	// rather than choosing where it belonged (LOG-05). `installTuiLogSink`
	// buffers instead of writing. A crash flushes that bounded buffer; a clean
	// exit discards it and prints only the concise conversation handoff below.
	const logs = installTuiLogSink(ctx.logging)
	// One start of the interactive terminal; the tips' cooldowns count these.
	const tipHistory = fileTipHistory()
	tipHistory.recordLaunch()
	let exitSummary: TuiExitSummary | null = null
	// The default screen starts where the shell left the cursor: what the person had on screen
	// and in the scrollback stays, and the banner and the first frame begin under it. Nothing
	// here clears either (`paint/live-paint.ts` paints only what changed from then on).
	// A killed earlier run may have left the pointer captured; clear that before the first frame.
	writeLaunchMouseReset(process.stdout, hostedByHost(process.env, process.ppid))
	// Fullscreen draws on the alternate screen, so the terminal's own screen and
	// scrollback are left exactly as they were and come back when the app ends.
	const fullscreen = resolveFullscreen({
		env: process.env,
		...(ctx.tui?.fullscreen !== undefined ? { setting: ctx.tui.fullscreen } : {}),
		interactive: process.stdout.isTTY === true && process.stdin.isTTY === true,
		hosted: hostedByHost(process.env, process.ppid),
	})
	if (process.stdout.isTTY && !fullscreen)
		process.stdout.write(startOnFreshLine(process.stdout.columns ?? 80))
	// SIGTERM, SIGHUP and SIGINT give the conversation back and leave cleanly
	// (`termination.ts`): the turn's lease is released first, so the next
	// process can /resume or /abandon at once, then the App leaves as `/exit`
	// does, which is what hands the terminal back.
	const termination = handleTerminationSignals(ctx.updates ? { updates: ctx.updates } : {})
	// Under Electron-as-Node on a Windows pseudo-console `process.stdin` is not the console;
	// the console's own input device is (see `console-input.ts`). Elsewhere this is undefined.
	const consoleInput = openConsoleInput()
	// Ink redraws only on the stream's `resize`; on a Windows pseudo-console that event can fail
	// to come, so the size is asked for on a timer there (see `output-size-watch.ts`).
	const stopSizeWatch = watchOutputSize(process.stdout)
	// The colours and motion the config asks for. `auto` asks the terminal for its background first,
	// which needs the real stdin; a Windows console input device is not asked.
	const themeReady = applyLaunchTheme(
		ctx.tui,
		consoleInput === undefined ? { input: process.stdin, output: process.stdout } : undefined,
	)
	if (themeReady) await themeReady
	// Focus reports (`ESC [ I` / `ESC [ O`) are taken off the stream before Ink reads it, and
	// switched on only while raw mode is held (see `focus-reporting.ts`).
	const inputStream = consoleInput?.stream ?? process.stdin
	// A paste marker split across two reads is held until it is whole, innermost so every
	// later filter and Ink see it as the terminal sent it (see `paste-marker-guard.ts`).
	const stopPasteMarkerGuard = installPasteMarkerGuard(inputStream)
	const stopFocusReporting = installFocusReporting(inputStream, process.stdout, (focused) =>
		terminalFocus.set(focused),
	)
	// A session the workspaces host started has no workspaces screen of its own: its `←` asks the host
	// to leave it (see `workspaces/signal.ts`). Any other session at a terminal on a POSIX system has
	// Ink mounted on a pair of pass-through streams, so the workspaces screen can be put up on demand
	// (see `zoom/`); until then they are the real terminal. The code behind it loads on the first `←`.
	const hosted = hostedByHost(process.env, process.ppid)
	const proxy: TerminalProxy | null =
		!hosted &&
		!fullscreen &&
		consoleInput === undefined &&
		process.platform !== 'win32' &&
		process.stdout.isTTY === true &&
		inputStream.isTTY === true
			? createTerminalProxy(process.stdout, inputStream as NodeJS.ReadStream)
			: null
	const terminationExit: { current: (() => void) | null } = { current: null }
	const repaint: { current: (() => void) | null } = { current: null }
	const workspaces: {
		current: Promise<import('./zoom/entry.js').WorkspacesEntry> | null
	} = {
		current: null,
	}
	const workspacesEntry = (): Promise<import('./zoom/entry.js').WorkspacesEntry> => {
		workspaces.current ??= import('./zoom/entry.js').then((m) =>
			m.createWorkspacesEntry({
				proxy: proxy as TerminalProxy,
				realOut: process.stdout,
				env: process.env,
				cwd: process.cwd(),
				entry: process.argv[1] as string,
				prefixSetting: ctx.tui?.workspacesPrefix ?? ctx.tui?.spacesPrefix,
				...(ctx.tui?.mouse !== undefined ? { mouseSetting: ctx.tui.mouse } : {}),
				...(ctx.tui?.copyOnSelect !== undefined ? { copyOnSelect: ctx.tui.copyOnSelect } : {}),
				requestExit: () =>
					terminationExit.current ? terminationExit.current() : instance.unmount(),
				repaint: () => repaint.current?.(),
			}),
		)
		return workspaces.current
	}
	const onOpenWorkspaces: (() => Promise<boolean>) | undefined = hosted
		? () => {
				process.stdout.write(workspacesSignal('zoom-out'))
				return Promise.resolve(true)
			}
		: proxy !== null
			? async () => {
					try {
						return await (await workspacesEntry()).open()
					} catch {
						return false
					}
				}
			: undefined
	const onConfirmExit: (() => Promise<boolean>) | undefined =
		!hosted && proxy !== null
			? async () => {
					try {
						return workspaces.current === null
							? true
							: await (await workspaces.current).confirmExit()
					} catch {
						return true
					}
				}
			: undefined
	// Leaving while the workspaces screen is up: the main screen comes back and the conversation
	// prints its whole history there before Ink unmounts, so the last frame follows it exactly as
	// it does in a plain session. Bounded: a stuck step never holds the exit.
	const beforeExit: (() => Promise<void>) | undefined =
		!hosted && proxy !== null
			? async () => {
					if (workspaces.current === null) return
					await leaveWorkspacesBounded({
						release: (stillWanted) =>
							(workspaces.current as NonNullable<typeof workspaces.current>).then((entry) =>
								entry.release(stillWanted),
							),
						flush: () => instance.waitUntilRenderFlush(),
						limitMs: LEAVE_WORKSPACES_MS,
					})
				}
			: undefined
	let terminatedBy: TerminationSignal | null = null
	const wheelListeners = new Set<(direction: WheelDirection) => void>()
	// Selecting text needs drags reported, which turns the terminal's own selection off:
	// `tui.mouse` and the NAMZU_DISABLE_MOUSE variables keep it for whoever wants it.
	const pointerListeners = new Set<(report: PointerReport) => void>()
	const selectable = fullscreen && resolveMouseMode(process.env, ctx.tui?.mouse) === 'full'
	const fullscreenHost = fullscreen
		? {
				...(selectable
					? {
							subscribePointer: (listener: (report: PointerReport) => void) => {
								pointerListeners.add(listener)
								return () => {
									pointerListeners.delete(listener)
								}
							},
						}
					: {}),
				...(ctx.tui?.copyOnSelect !== undefined ? { copyOnSelect: ctx.tui.copyOnSelect } : {}),
				...(ctx.tui?.wheelRows !== undefined ? { wheelRows: ctx.tui.wheelRows } : {}),
				...(ctx.tui?.wheelAccel !== undefined ? { wheelAccel: ctx.tui.wheelAccel } : {}),
				subscribeWheel: (listener: (direction: WheelDirection) => void) => {
					wheelListeners.add(listener)
					return () => {
						wheelListeners.delete(listener)
					}
				},
			}
		: undefined
	// The default screen's writer: paints only what changed, at most twelve times a second, and
	// handles a resize without clearing the scrollback. `NAMZU_LEGACY_PAINT=1` hands the writing
	// back to Ink, whole region every frame, as before.
	const inkOut = proxy?.stdout ?? process.stdout
	const paint: LivePaint | null =
		!fullscreen &&
		process.stdout.isTTY === true &&
		process.env.NAMZU_LEGACY_PAINT !== '1' &&
		liveRenderOption(process.stdout, inputStream, consoleInput !== undefined).interactive === true
			? createLivePaint(inkOut, { bypass: () => proxy?.mode === 'zoomed' })
			: null
	const instance = render(
		React.createElement(App, {
			ctx,
			onExitSummary: (summary: TuiExitSummary) => {
				exitSummary = summary
			},
			terminationExit,
			repaint,
			...(fullscreenHost ? { fullscreen: fullscreenHost } : {}),
			...(paint ? { paintsLiveRegion: true } : {}),
			...(onOpenWorkspaces ? { onOpenWorkspaces } : {}),
			...(onConfirmExit ? { onConfirmExit } : {}),
			...(beforeExit ? { beforeExit } : {}),
			examplePrompts: true,
			decisionSetup: {},
			queuedHintCount: fileQueuedHintCount(),
			tipHistory,
		}),
		{
			stdout: paint?.stream ?? inkOut,
			stderr: process.stderr,
			stdin: proxy?.stdin ?? inputStream,
			exitOnCtrlC: false,
			// A CI marker in the environment must not blank a real terminal (see render-mode.ts).
			...liveRenderOption(process.stdout, process.stdin, consoleInput !== undefined),
			// Ink enters the alternate screen here and leaves it on every way out
			// (unmount, a signal, a crash). It repaints only the lines that changed.
			...(fullscreen ? { alternateScreen: true, incrementalRendering: true } : {}),
			kittyKeyboard: {
				mode: 'auto',
				flags: ['disambiguateEscapeCodes'],
			},
		},
	)
	// The wheel is asked of the terminal once Ink holds the alternate screen. If
	// the process dies without the normal teardown, the exit hook still hands the
	// pointer and the cursor back; Ink's own exit hook returns the main screen.
	const stopWheel = fullscreen
		? installMouseWheel(
				inputStream,
				process.stdout,
				(direction) => {
					for (const listener of wheelListeners) listener(direction)
				},
				selectable
					? (report) => {
							for (const listener of pointerListeners) listener(report)
						}
					: undefined,
			)
		: undefined
	const panicReset = fullscreen ? () => process.stdout.write(FULLSCREEN_PANIC_RESET) : undefined
	if (panicReset) process.on('exit', panicReset)
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
		// The process ends when this step does, so hanging up the other sessions and handing the
		// terminal back from the workspaces screen has to finish inside it.
		if (workspaces.current !== null) await (await workspaces.current).shutdown()
	})
	try {
		await instance.waitUntilExit()
	} finally {
		// Leaving with the workspaces screen up hangs up the other sessions and hands the terminal back first.
		if (workspaces.current !== null) await (await workspaces.current).shutdown()
		termination.dispose()
		// The last frame is painted and the cursor shown before anything else is written.
		paint?.dispose()
		stopSizeWatch?.()
		stopFocusReporting()
		stopWheel?.()
		stopPasteMarkerGuard()
		if (panicReset) process.off('exit', panicReset)
		consoleInput?.release()
		logs.close()
		// A hangup means the terminal is gone: nobody is there to read the
		// handoff, and writing to it fails.
		const summary = terminatedBy === 'SIGHUP' ? '' : formatTuiExitSummary(exitSummary, invocation)
		if (summary.length > 0) process.stdout.write(summary)
	}
}
