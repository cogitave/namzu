import { killTrees } from "../../process/kill-tree.js";

/**
 * What the host's exit has to stop: a job's process, and how to signal it.
 */
export interface HostExitTarget {
	readonly child: { readonly pid?: number | undefined };
	/** The spawner's own kill, when it gave one; otherwise the process group is signalled. */
	readonly kill?: (signal: NodeJS.Signals) => void;
}

const live = new Set<HostExitTarget>();
let installed = false;

/**
 * Runs when the host process is about to end, by whatever road: `process.exit`,
 * an uncaught exception, the event loop emptying. It is synchronous on purpose.
 * An `exit` listener cannot await, so it starts no promise and no timer, signals
 * each live job with SIGKILL (its own kill when it gave one, then its process
 * group and any descendant found by the environment tag), and does not wait for any of them
 * to stop or claim that they have. A job that was already stopped has been
 * untracked and is not touched.
 *
 * It does not cover a SIGKILL of the host itself, which no listener can see.
 */
function finalizeAtHostExit(): void {
	const children: HostExitTarget["child"][] = [];
	for (const target of live) {
		children.push(target.child);
		try {
			target.kill?.("SIGKILL");
		} catch {
			// The process is already gone; the host is exiting either way.
		}
	}
	live.clear();
	try {
		// One pass over the machine's processes for all the jobs, not one each.
		// Every job goes through it, whether or not it has a kill of its own, so
		// a descendant that left the process group is found in both cases.
		killTrees(children, "SIGKILL");
	} catch {
		// As above.
	}
}

/**
 * Track a running job so the host's exit stops it. Returns the untrack, to be
 * called once the job has ended. The listener is installed once per process, on
 * the first job, and is put first so a later listener that throws cannot
 * keep it from running.
 */
export function stopAtHostExit(target: HostExitTarget): () => void {
	live.add(target);
	if (!installed) {
		installed = true;
		process.prependListener("exit", finalizeAtHostExit);
	}
	return () => {
		live.delete(target);
	};
}

/** Jobs the host's exit would stop. For tests. */
export function trackedForHostExit(): number {
	return live.size;
}
