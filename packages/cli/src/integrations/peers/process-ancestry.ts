import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { startedBySession } from '@namzu/sdk'

/**
 * Whether a process runs under another one, for telling a person's own terminal from a tool a session
 * started. A person's message must come from outside every Namzu session; a command a model ran through its
 * shell is a descendant of the terminal that runs the session, however it is spelled.
 */

const MAX_DEPTH = 64

/** The parent of a process, or undefined when it cannot be told (gone, or a platform with no answer). */
export function defaultParentPid(pid: number): number | undefined {
	try {
		if (process.platform === 'linux') {
			// "pid (comm) S ppid ...": comm may hold spaces and parentheses, so read after the last ")".
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
			const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
			return Number.isInteger(parent) && parent > 0 ? parent : undefined
		}
		if (process.platform === 'win32') return undefined
		const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
			encoding: 'utf8',
			timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		const parent = Number(out.trim())
		return Number.isInteger(parent) && parent > 0 ? parent : undefined
	} catch {
		return undefined
	}
}

/** The ancestors of `pid`, nearest first, not including `pid` itself. */
export function ancestorsOf(
	pid: number,
	parentOf: (pid: number) => number | undefined = defaultParentPid,
): number[] {
	const found: number[] = []
	let current = pid
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		const parent = parentOf(current)
		if (parent === undefined || parent <= 1 || found.includes(parent)) break
		found.push(parent)
		current = parent
	}
	return found
}

/** Whether `pid` is a descendant of any process in `sessionPids`. */
export function runsUnderAny(
	pid: number,
	sessionPids: ReadonlySet<number>,
	parentOf?: (pid: number) => number | undefined,
): boolean {
	return ancestorsOf(pid, parentOf).some((ancestor) => sessionPids.has(ancestor))
}

/**
 * Whether the process `pid` started with the session marker in its environment (Linux only: `/proc` is
 * the one place another process's starting environment can be read, and only for the same account). A
 * process that cleared its environment is not seen; this is the receiving terminal's own look at the
 * sender, in addition to the sender's look at itself.
 */
export function processStartedBySession(pid: number): boolean {
	if (process.platform !== 'linux') return false
	try {
		const env: Record<string, string> = {}
		for (const entry of readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
			const at = entry.indexOf('=')
			if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1)
		}
		return startedBySession(env, 'linux')
	} catch {
		return false
	}
}
