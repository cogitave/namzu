#!/usr/bin/env node
/**
 * Delete tsc outputs whose source file no longer exists.
 *
 * ## Why this exists
 *
 * ci.yml restores the incremental state `tsc --build` left behind on an
 * earlier commit (every project's `tsconfig.tsbuildinfo` plus its `dist/`),
 * so the Type check step re-checks only what changed. tsc decides what to
 * re-check from file CONTENT, and that is safe: a restored cache can only be
 * stale, and stale means slower. One thing it does not do is delete. When a
 * commit removes or renames `src/foo.ts`, tsc stops emitting `dist/foo.*` but
 * leaves the old copy where it was. A fresh checkout never has that file; a
 * restored cache does, and the Build and Test steps that run after Type check
 * could then resolve a module the source tree no longer contains and pass
 * where a clean build fails.
 *
 * So after a restore, every output file with no source counterpart is
 * removed, and the cache is back to being equivalent to a clean build's
 * output, only earlier.
 *
 * ## The mapping
 *
 * Every project here compiles `src/` into `dist/` (rootDir `./src`, outDir
 * `./dist`), so `dist/a/b.d.ts.map` belongs to `src/a/b.{ts,tsx,mts,cts}`,
 * `dist/a/b.js` to `src/a/b.{ts,tsx,js,jsx}`, and a copied `dist/a/c.json`
 * to `src/a/c.json`. A `dist` file that matches none of those shapes is left
 * alone: this script removes only what it can prove is an orphan.
 *
 * Usage: node .github/scripts/prune-stale-tsc-outputs.mjs [repoRoot]
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** output suffix -> the source extensions that can produce it */
const SOURCES = [
	[".d.ts.map", [".ts", ".tsx", ".mts", ".cts"]],
	[".d.ts", [".ts", ".tsx"]],
	[".d.mts", [".mts"]],
	[".d.cts", [".cts"]],
	[".js.map", [".ts", ".tsx", ".js", ".jsx"]],
	[".mjs.map", [".mts", ".mjs"]],
	[".cjs.map", [".cts", ".cjs"]],
	[".js", [".ts", ".tsx", ".js", ".jsx"]],
	[".mjs", [".mts", ".mjs"]],
	[".cjs", [".cts", ".cjs"]],
	[".json", [".json"]],
];

function sourceCandidates(distRel) {
	for (const [suffix, exts] of SOURCES) {
		if (distRel.endsWith(suffix)) {
			const stem = distRel.slice(0, -suffix.length);
			return exts.map((ext) => `${stem}${ext}`);
		}
	}
	return undefined;
}

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile()) yield full;
	}
}

/** A directory is a tsc project here when it holds a tsbuildinfo and a src/. */
function projectDirs(root) {
	const found = [];
	const visit = (dir, depth) => {
		if (
			existsSync(join(dir, "tsconfig.tsbuildinfo")) &&
			existsSync(join(dir, "src"))
		)
			found.push(dir);
		if (depth === 0) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (
				entry.isDirectory() &&
				entry.name !== "node_modules" &&
				!entry.name.startsWith(".")
			)
				visit(join(dir, entry.name), depth - 1);
		}
	};
	visit(join(root, "packages"), 2);
	return found;
}

export function pruneProject(projectDir) {
	const dist = join(projectDir, "dist");
	const src = join(projectDir, "src");
	const removed = [];
	if (!existsSync(dist) || !statSync(dist).isDirectory()) return removed;
	for (const file of walk(dist)) {
		const candidates = sourceCandidates(relative(dist, file));
		if (!candidates) continue;
		if (candidates.some((candidate) => existsSync(join(src, candidate))))
			continue;
		rmSync(file);
		removed.push(file);
	}
	return removed;
}

export function prune(root) {
	return projectDirs(root).flatMap(pruneProject);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root =
		process.argv[2] ??
		join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const removed = prune(root);
	console.log(
		`prune-stale-tsc-outputs: removed ${removed.length} output file(s) with no source`,
	);
	for (const file of removed) console.log(`  ${relative(root, file)}`);
}
