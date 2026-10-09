// Run: node --test e2e/display-lock.test.mjs  (no Electron, no display needed)
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireDisplayLock, lockPathFor } from "./display-lock.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "display-lock-test-"));

test("a second run waits until the first releases, in order", async () => {
	const dir = scratch();
	try {
		const path = lockPathFor(":99", dir);
		const releaseFirst = await acquireDisplayLock({ path, pid: 1, alive: () => true });
		const events = [];
		let turns = 0;
		const second = acquireDisplayLock({
			path,
			pid: 2,
			alive: () => true,
			// Each wait is one turn of the queue; the first holder lets go after three.
			wait: async () => {
				turns += 1;
				events.push(`wait ${turns}`);
				if (turns === 3) {
					events.push("release first");
					releaseFirst();
				}
			},
		}).then((release) => {
			events.push("second holds");
			return release;
		});
		const releaseSecond = await second;
		assert.deepEqual(events, ["wait 1", "wait 2", "wait 3", "release first", "second holds"]);
		assert.equal(existsSync(path), true);
		releaseSecond();
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a lock left by a process that is gone is taken over", async () => {
	const dir = scratch();
	try {
		const path = lockPathFor(":98", dir);
		await acquireDisplayLock({ path, pid: 111, alive: () => true });
		const release = await acquireDisplayLock({
			path,
			pid: 222,
			alive: (pid) => pid !== 111,
			wait: async () => assert.fail("must not wait for a dead owner"),
		});
		release();
		release();
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("different displays do not share a lock", () => {
	assert.notEqual(lockPathFor(":99", "/t"), lockPathFor(":100", "/t"));
	assert.equal(lockPathFor(undefined, "/t"), lockPathFor("", "/t"));
});
