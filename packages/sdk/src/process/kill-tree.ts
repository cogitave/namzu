import { execFileSync } from 'node:child_process'

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
const MSYS_SHELLS = new WeakMap<object, { readonly bash: string; readonly tag: string }>()

/** Remember how to find every process a Git Bash child started. Called by the spawn. */
export function registerMsysShell(child: object, shell: { bash: string; tag: string }): void {
	MSYS_SHELLS.set(child, shell)
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
	if (!child.pid) return
	try {
		if (process.platform === 'win32') {
			const msys = MSYS_SHELLS.get(child)
			if (msys !== undefined) killMsysTagged(msys)
			execFileSync(taskkillPath(), ['/pid', String(child.pid), '/t', '/f'], {
				stdio: 'ignore',
				windowsHide: true,
			})
		} else {
			process.kill(-child.pid, signal)
		}
	} catch {
		// Group (or tree) already gone
	}
}
