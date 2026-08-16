import { execFileSync } from 'node:child_process'
import type { spawn } from 'node:child_process'

/**
 * Signal a spawned child AND everything it forked.
 *
 * Extracted from `sandbox/provider/local.ts` unchanged, because a second
 * caller arrived — the background job registry — and this is not a function
 * anybody should write twice. Every sentence of the reasoning below was
 * paid for by a bug where a cancelled command kept running, and a
 * near-copy would reproduce the bug in the copy.
 *
 * Every caller reaches a real command through `/bin/sh -c "cmd"`, and under
 * the local sandbox's `linux-namespace`/`macos-seatbelt` tiers that shell is
 * wrapped again (`unshare …`/`sandbox-exec … -- /bin/sh -c "cmd"`). Either
 * way, `child.pid` names the OUTERMOST wrapper Node spawned, not `cmd` —
 * signalling only that pid, which is both what `child.kill()` does and what
 * `spawn`'s own `signal` option does internally on abort, reaps the wrapper
 * and leaves `cmd`, and anything it forked, running past both a cancel and a
 * timeout.
 *
 * POSIX: the caller must spawn with `detached: true`, which makes the child
 * the leader of a new process group (pgid === pid) instead of joining this
 * Node process's own. A negative pid signals that whole group in one call.
 * Group membership is a host-kernel fact that a fork()'d descendant inherits
 * from its parent whether or not it — or an ancestor such as `unshare --pid`
 * — subsequently entered a new PID namespace, so this reaches `cmd` and its
 * descendants along with the wrapper itself even under the namespaced
 * isolation tiers.
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
export function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (!child.pid) return
	try {
		if (process.platform === 'win32') {
			execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
		} else {
			process.kill(-child.pid, signal)
		}
	} catch {
		// Group (or tree) already gone
	}
}
