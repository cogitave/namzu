import type { LocalComputerCommandRunner } from '../engine.js'

/**
 * Every probe command has its own time limit, so a stuck Windows tool degrades
 * one fact to `unknown` instead of hanging the whole inspection.
 */
export const PROBE_LIMIT_MS = {
	/** reg.exe, sc.exe, wsl.exe, wslc version: local and quick. */
	command: 10_000,
	/** PowerShell starts slowly on a cold PC. */
	powershell: 15_000,
	/** The command that starts the wslc session (a virtual machine). */
	session: 60_000,
} as const

/** A probe command did not answer within its limit. */
export class ProbeTimeoutError extends Error {
	override readonly name = 'ProbeTimeoutError'
	constructor() {
		super('A Windows check did not answer in time.')
	}
}

/**
 * Run one command with its own limit. The limit aborts the runner's signal and
 * also stops waiting, so a runner that ignores the signal cannot hold the
 * caller. The caller's own signal still wins: its abort rejects with its
 * reason, not with a timeout.
 */
export async function runLimited(
	runner: LocalComputerCommandRunner,
	binary: string,
	args: readonly string[],
	limitMs: number,
	options: {
		readonly signal?: AbortSignal
		readonly env?: NodeJS.ProcessEnv
		readonly cwd?: string
	} = {},
): Promise<string> {
	options.signal?.throwIfAborted()
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	let onOuterAbort: (() => void) | undefined
	const stop = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			// Reject first: aborting makes a well-behaved runner reject at once, and
			// the caller must see the timeout, not that rejection.
			reject(new ProbeTimeoutError())
			controller.abort()
		}, limitMs)
		onOuterAbort = () => {
			reject(options.signal?.reason)
			controller.abort()
		}
		options.signal?.addEventListener('abort', onOuterAbort, { once: true })
	})
	// Whichever side loses the race must not become an unhandled rejection.
	stop.catch(() => undefined)
	try {
		const running = runner.run(binary, args, { ...options, signal: controller.signal })
		running.catch(() => undefined)
		return await Promise.race([running, stop])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		if (onOuterAbort) options.signal?.removeEventListener('abort', onOuterAbort)
	}
}
