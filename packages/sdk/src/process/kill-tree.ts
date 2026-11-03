import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * Git Bash children that the Windows process tree cannot reach.
 *
 * Git for Windows' msys runtime starts a command that is not the last of its
 * line by `fork`, and the process that forked is gone by the time the command
 * runs: the command's Windows parent no longer exists, so `taskkill /T` walks
 * from the shell to its child and never finds the grandchild (`sleep 60; echo`,
 * `cd app && npm start & wait`). Each such shell is started with a unique tag
 * in its environment, which every descendant inherits however it was started;
 * the tag is how the tree is found again.
 */
const MSYS_SHELLS = new WeakMap<object, { readonly bash?: string; readonly tag: string }>()

/**
 * Whether a pid may be signalled, or addressed as a group with `-pid`.
 *
 * `kill(-1, sig)` signals every process the user may signal and `kill(0, sig)`
 * signals the caller's own process group, so a recorded pid of 1, 0, a negative
 * or a fractional number (a test double, a corrupt record, `NaN`) would take
 * down the host's whole session. Only an integer above 1 that is not this
 * process is a real, separate process. A refused pid is treated as already gone.
 */
export function isSignalablePid(pid: unknown): pid is number {
	return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/** Remember how to find every process a Git Bash child started. Called by the spawn. */
export function registerMsysShell(child: object, shell: { bash: string; tag: string }): void {
	MSYS_SHELLS.set(child, shell)
}

/**
 * Remember the tag a POSIX child's environment carries, so a kill can also find
 * a descendant that left the child's process group (`setsid`, a double fork
 * that starts its own session). Such a process has no group to signal, but it
 * inherited the environment, and the tag is how it is found again.
 *
 * The limit is the same as the group's own: a process that clears its
 * environment before it forks escapes this too.
 */
export function registerProcessTag(child: object, tag: string): void {
	MSYS_SHELLS.set(child, { tag })
}

/**
 * Signal every process of this user whose environment carries one of the tags,
 * by reading `/proc/<pid>/environ`. Linux only: other POSIX systems have no
 * `/proc`, and there the process group is all a kill can reach. A process whose
 * environment cannot be read (another user's, or one that has just ended) is
 * skipped without further work.
 *
 * Several tags are looked for in one pass, so stopping many jobs at once reads
 * each environment once, not once per job. The scan is synchronous and its cost
 * grows with the number of processes on the machine. There is also a window
 * between reading an environment and signalling its pid in which the pid could
 * be reused by an unrelated process of the same user; the window is the length
 * of one read, and the signal goes only to a pid whose environment carried the
 * tag a moment before.
 */
export function signalTagged(tags: string | readonly string[], signal: NodeJS.Signals): number {
	const needles = (typeof tags === 'string' ? [tags] : tags).map(
		(tag) => `${MSYS_TAG_VARIABLE}=${tag}\0`,
	)
	if (needles.length === 0) return 0
	let entries: string[]
	try {
		entries = readdirSync('/proc')
	} catch {
		return 0
	}
	let signalled = 0
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue
		const pid = Number(entry)
		if (!isSignalablePid(pid)) continue
		try {
			const environ = readFileSync(`/proc/${entry}/environ`, 'latin1')
			if (!needles.some((needle) => environ.includes(needle))) continue
			process.kill(pid, signal)
			signalled++
		} catch {
			// Not ours to read, or gone since the listing.
		}
	}
	return signalled
}

/** The environment variable that carries the tag. */
export const MSYS_TAG_VARIABLE = 'NAMZU_SHELL_TAG'

/** Kill every process whose environment carries the tag, from inside the msys runtime. */
function killMsysTagged(shell: { readonly bash: string; readonly tag: string }): void {
	// `$$` is skipped so the killer cannot end itself. Parameter expansion keeps
	// the script to the two programs (grep, kill) the launcher puts on PATH.
	const script = [
		`for f in $(grep -laF "${MSYS_TAG_VARIABLE}=${shell.tag}" /proc/[0-9]*/environ 2>/dev/null); do`,
		'p=${f#/proc/}; p=${p%/environ}; [ "$p" != "$$" ] && kill -9 $p;',
		'done',
	].join(' ')
	try {
		execFileSync(shell.bash, ['-c', script], {
			stdio: 'ignore',
			windowsHide: true,
			timeout: 5000,
		})
	} catch {
		// Nothing tagged was left, or the runtime could not start: taskkill still runs.
	}
}

/** The system's own taskkill, so a PATH entry cannot stand in for it. */
function taskkillPath(): string {
	const root = process.env.SystemRoot ?? process.env.windir
	return root ? `${root}\\System32\\taskkill.exe` : 'taskkill'
}

/**
 * Signal a spawned child AND everything it forked.
 *
 * Extracted from `sandbox/provider/local.ts` unchanged, because a second
 * caller arrived — the background job registry — and this is not a function
 * anybody should write twice. Every sentence of the reasoning below was
 * paid for by a bug where a cancelled command kept running, and a
 * near-copy would reproduce the bug in the copy.
 *
 * Some callers reach a command through a shell or isolation wrapper; the
 * local execution context can also spawn the authored executable directly.
 * In every case, signalling only `child.pid` — which is both what
 * `child.kill()` does and what `spawn`'s own `signal`/`timeout` options do —
 * can reap that direct child while leaving a descendant running past both a
 * cancel and a timeout.
 *
 * POSIX: the caller must spawn with `detached: true`, which makes the child
 * the leader of a new process group (pgid === pid) instead of joining this
 * Node process's own. A negative pid signals that whole group in one call.
 * Group membership is a host-kernel fact that an ordinary forked descendant
 * inherits from its parent, including under the namespaced isolation tiers.
 * A process which deliberately starts a new session/process group can escape
 * this boundary; this helper is process-group signalling, not a portable
 * arbitrary-descendant ownership primitive.
 *
 * Windows has no process-group id to sign a kill with — `process.kill` with
 * a negative pid there either throws or silently does nothing, depending on
 * the signal — so there is no equivalent single call. The OS's own
 * tree-walk, `taskkill /T`, runs instead. Windows also has no soft-vs-forced
 * distinction the way SIGTERM/SIGKILL do: `child.kill()` there already
 * terminates unconditionally, so `/F` is passed every time this runs,
 * including the post-grace call that follows a POSIX SIGTERM — against an
 * already-dead tree that second call is a deliberate no-op, the same as the
 * POSIX SIGKILL that follows a SIGTERM which already worked.
 */
export function killTree(
	child: { readonly pid?: number | undefined },
	signal: NodeJS.Signals,
): void {
	killTrees([child], signal)
}

/**
 * `killTree` for several children at once: each child's group is signalled, then
 * the environment scan runs once for all their tags. Used where the number of
 * kills is unbounded and cannot wait, such as the host's exit.
 */
export function killTrees(
	children: readonly { readonly pid?: number | undefined }[],
	signal: NodeJS.Signals,
): void {
	const tags: string[] = []
	for (const child of children) {
		if (!isSignalablePid(child.pid)) continue
		killOne(child, signal, tags)
	}
	if (tags.length > 0 && process.platform === 'linux') signalTagged(tags, signal)
}

function killOne(
	child: { readonly pid?: number | undefined },
	signal: NodeJS.Signals,
	tags: string[],
): void {
	if (!isSignalablePid(child.pid)) return
	try {
		if (process.platform === 'win32') {
			const msys = MSYS_SHELLS.get(child)
			if (msys?.bash !== undefined) killMsysTagged({ bash: msys.bash, tag: msys.tag })
			execFileSync(taskkillPath(), ['/pid', String(child.pid), '/t', '/f'], {
				stdio: 'ignore',
				windowsHide: true,
			})
		} else {
			try {
				process.kill(-child.pid, signal)
			} finally {
				// After the group, which is cheap and exact: what is left is only
				// what started its own session. Also when the group is already gone.
				const tagged = MSYS_SHELLS.get(child)
				if (tagged !== undefined) tags.push(tagged.tag)
			}
		}
	} catch {
		// Group (or tree) already gone
	}
}
