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
