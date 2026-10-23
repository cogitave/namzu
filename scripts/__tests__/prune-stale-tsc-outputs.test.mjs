/**
 * Tests for .github/scripts/prune-stale-tsc-outputs.mjs, on a synthetic tree.
 *
 * What matters is both directions: an output whose source is gone must go (or
 * a restored cache could satisfy a build the source tree cannot), and an
 * output whose source exists must stay (or the restored cache stops saving
 * anything, and tsc, finding the emit missing, would not re-emit it).
 */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prune } from "../../.github/scripts/prune-stale-tsc-outputs.mjs";

function fixture(files) {
	const root = mkdtempSync(join(tmpdir(), "prune-tsc-"));
	for (const file of files) {
		const full = join(root, file);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "");
	}
	return root;
}

const emitted = (stem) => [
	`${stem}.js`,
	`${stem}.js.map`,
	`${stem}.d.ts`,
	`${stem}.d.ts.map`,
];

test("removes every output of a deleted source and keeps the rest", () => {
	const root = fixture([
		"packages/a/tsconfig.tsbuildinfo",
		"packages/a/src/keep.ts",
		"packages/a/src/data.json",
		"packages/a/src/ui/view.tsx",
		...emitted("packages/a/dist/keep"),
		...emitted("packages/a/dist/gone"),
		...emitted("packages/a/dist/ui/view"),
		...emitted("packages/a/dist/ui/gone-view"),
		"packages/a/dist/data.json",
		"packages/a/dist/gone.json",
		"packages/a/dist/bundle.cjs.txt",
	]);
	try {
		const removed = prune(root);
		assert.equal(removed.length, 9);
		for (const stem of ["keep", "ui/view"])
			for (const f of emitted(`packages/a/dist/${stem}`))
				assert.ok(existsSync(join(root, f)), f);
		for (const stem of ["gone", "ui/gone-view"])
			for (const f of emitted(`packages/a/dist/${stem}`))
				assert.ok(!existsSync(join(root, f)), f);
		assert.ok(existsSync(join(root, "packages/a/dist/data.json")));
		assert.ok(!existsSync(join(root, "packages/a/dist/gone.json")));
		assert.ok(
			existsSync(join(root, "packages/a/dist/bundle.cjs.txt")),
			"unknown shapes are left alone",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reaches nested providers and ignores a directory with no tsbuildinfo", () => {
	const root = fixture([
		"packages/providers/p/tsconfig.tsbuildinfo",
		"packages/providers/p/src/index.ts",
		...emitted("packages/providers/p/dist/index"),
		...emitted("packages/providers/p/dist/old"),
		"packages/other/src/x.ts",
		...emitted("packages/other/dist/orphan"),
	]);
	try {
		prune(root);
		assert.ok(!existsSync(join(root, "packages/providers/p/dist/old.js")));
		assert.ok(existsSync(join(root, "packages/providers/p/dist/index.js")));
		assert.ok(
			existsSync(join(root, "packages/other/dist/orphan.js")),
			"not a restored project: untouched",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("removes the restored state of a package deleted from the repo", () => {
	const root = fixture([
		"packages/old/tsconfig.tsbuildinfo",
		...emitted("packages/old/dist/index"),
		"packages/providers/gone/tsconfig.tsbuildinfo",
		...emitted("packages/providers/gone/dist/index"),
		"packages/live/package.json",
		"packages/live/src/index.ts",
		"packages/live/tsconfig.tsbuildinfo",
		...emitted("packages/live/dist/index"),
	]);
	try {
		prune(root);
		assert.ok(!existsSync(join(root, "packages/old/dist")));
		assert.ok(!existsSync(join(root, "packages/old/tsconfig.tsbuildinfo")));
		assert.ok(!existsSync(join(root, "packages/providers/gone/dist")));
		assert.ok(existsSync(join(root, "packages/live/dist/index.js")));
		assert.ok(existsSync(join(root, "packages/live/tsconfig.tsbuildinfo")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
