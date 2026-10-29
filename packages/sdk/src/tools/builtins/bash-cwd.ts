/**
 * The directory a `bash` call starts in, carried from one call to the next.
 *
 * A model that runs `cd packages/app` expects the next call to be there; shell
 * state (variables, functions, aliases) does not carry over, but the directory
 * does. After a foreground command the shell writes its physical directory to a
 * private file, and the next call of the same session starts there.
 *
 * Two limits keep this from widening what a command can reach. The new
 * directory has to lie inside the turn's roots (the working directory, the
 * directories added for the session, any path this call was approved for); a
 * command that leaves them is put back at the session's working directory and
 * the result says so. And a directory that no longer exists is dropped without
 * ceremony. Nothing here applies to a sandboxed command or to Windows shells,
 * whose paths a host process cannot use as they are printed.
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CommandShell, hostCommandShell } from '../command-shell.js'
import { pathOutsideRoots, toolRoots } from '../paths.js'
import { readBoundedFile } from './bounded-file-read.js'

interface Carried {
	/** The working directory the session started with; the fallback. */
	readonly base: string
	cwd: string
}

/** Sessions remembered; the oldest is forgotten first. */
const MAX_SESSIONS = 256
const carried = new Map<string, Carried>()

/** The notice appended to a result when the command left the allowed directories. */
export function cwdResetNotice(base: string): string {
	return `Shell cwd was reset to ${base}`
}

/** Single-quote `text` for a POSIX shell. */
function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Runs `command` unchanged and records the directory it ended in. The exit
 * status is the command's own. A command that ends the shell itself (`exit`)
 * records nothing, so the directory stays as it was.
 */
export function withCwdCapture(command: string, file: string): string {
	return `eval ${shellQuote(command)}\n__namzu_status=$?\npwd -P >| ${shellQuote(file)} 2>/dev/null\nexit $__namzu_status`
}

export function newCwdFile(): string {
	return join(tmpdir(), `namzu-cwd-${randomUUID()}`)
}

/** Where this session's next foreground call starts. Synchronous: the spawn must not wait on it. */
export function startingDirectory(sessionId: string, base: string): string {
	const entry = carried.get(sessionId)
	if (entry === undefined) return base
	if (entry.base !== base) {
		carried.delete(sessionId)
		return base
	}
	try {
		if (statSync(entry.cwd).isDirectory()) return entry.cwd
	} catch {
		// Removed or unreadable: start again from the base.
	}
	entry.cwd = base
	return base
}

/**
 * The cwd used by bash execution and host authorization. Hosts must resolve it
 * for each call, not cache the session's initial directory. Sandboxed commands
 * (including sandbox escapes) and Windows never use the carried POSIX cwd.
 */
export function effectiveBashWorkingDirectory(
	sessionId: string | undefined,
	workingDirectory: string,
	options: {
		sandboxed?: boolean
		shell?: Pick<CommandShell, 'path' | 'windows'>
	} = {},
): string {
	const shell = options.shell ?? hostCommandShell()
	if (options.sandboxed || sessionId === undefined || shell.windows || shell.path === undefined)
		return workingDirectory
	return startingDirectory(sessionId, workingDirectory)
}

/**
 * Reads what the finished command recorded and keeps it for the next call.
 * Returns the notice to append when the directory was outside the roots.
 */
export async function recordDirectory(
	sessionId: string,
	file: string,
	context: Parameters<typeof toolRoots>[0],
): Promise<string | undefined> {
	let reported: string
	try {
		reported = (await readBoundedFile(file, 64 * 1024)).toString('utf8').trim()
	} catch {
		return undefined
	} finally {
		await rm(file, { force: true })
	}
	if (reported === '') return undefined
	const base = context.workingDirectory
	const outside = await pathOutsideRoots(toolRoots(context), reported)
	const next = outside === undefined ? reported : base
	carried.delete(sessionId)
	if (next !== base) {
		carried.set(sessionId, { base, cwd: next })
		if (carried.size > MAX_SESSIONS) {
			const oldest = carried.keys().next().value
			if (oldest !== undefined) carried.delete(oldest)
		}
	}
	return outside === undefined ? undefined : cwdResetNotice(base)
}

/** For tests: forget every session. */
export function forgetCarriedDirectories(): void {
	carried.clear()
}

// Enumerable symbol crosses the executor's context copies, never the model's
// JSON input. No public ToolContext field or caller-authored cwd is trusted.
const REVIEWED_CWD = Symbol('namzu.bash.reviewed-cwd')

export function pinBashWorkingDirectory(context: object, cwd: string): void {
	Object.defineProperty(context, REVIEWED_CWD, { value: cwd, enumerable: true, configurable: true })
}

export function bashWorkingDirectoryForExecution(context: {
	sessionId?: string
	workingDirectory: string
	sandbox?: unknown
}): string {
	const current = effectiveBashWorkingDirectory(context.sessionId, context.workingDirectory, {
		sandboxed: context.sandbox !== undefined,
	})
	const reviewed = (context as { [REVIEWED_CWD]?: string })[REVIEWED_CWD]
	if (reviewed !== undefined && current !== reviewed)
		throw new Error(
			'Shell working directory changed after this call was reviewed. Nothing ran. Retry the call so its paths can be checked in the current directory.',
		)
	return reviewed ?? current
}
