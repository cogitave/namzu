// One Electron run at a time per display.
//
// Test files under `node --test` run as parallel processes. Several real Electron windows sharing
// one Xvfb display steal focus and keyboard input from each other, which showed up as elements
// detaching and hover cards never opening. The harness takes this lock before it launches anything,
// so a parallel run queues instead of flaking. `--test-concurrency=1` (see README.md) avoids the
// queue and is what `pnpm test:e2e` uses.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True when a process with this id exists. */
export function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else.
		return error?.code === "EPERM";
	}
}

/** The lock directory for one display. */
export function lockPathFor(display, directory = tmpdir()) {
	const name = String(display || "none").replace(/[^A-Za-z0-9_.-]/g, "_");
	return join(directory, `namzu-e2e-display-${name}.lock`);
}

/**
 * Takes the display lock, waiting while another live process holds it. A lock left by a process
 * that is gone is taken over. Returns a function that releases it (idempotent).
 *
 * @param {{ path: string, pid?: number, alive?: (pid: number) => boolean, wait?: () => Promise<void> }} options
 */
export async function acquireDisplayLock({
	path,
	pid = process.pid,
	alive = processAlive,
	wait = () => new Promise((done) => setTimeout(done, 250)),
}) {
	for (;;) {
		try {
			mkdirSync(path);
			writeFileSync(join(path, "owner"), String(pid));
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let owner = Number.NaN;
			try {
				owner = Number(readFileSync(join(path, "owner"), "utf8"));
			} catch {
				// The owner is between mkdir and writing its id; look again shortly.
				await wait();
				continue;
			}
			if (!alive(owner)) {
				rmSync(path, { recursive: true, force: true });
				continue;
			}
			await wait();
		}
	}
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		rmSync(path, { recursive: true, force: true });
	};
}

/** Takes the lock for this process's display and releases it when the process ends. */
export async function holdDisplayForThisProcess() {
	if (process.env.NAMZU_E2E_NO_LOCK === "1") return () => {};
	const release = await acquireDisplayLock({ path: lockPathFor(process.env.DISPLAY) });
	process.once("exit", release);
	return release;
}
