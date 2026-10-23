#!/usr/bin/env node
/**
 * Every workspace package with a `test` script is run by some job in ci.yml.
 *
 * ## Why this exists
 *
 * `ci.yml` used to run `pnpm -r test`, which cannot skip a package. The
 * pull-request path now splits the suite across jobs (the SDK in its own jobs,
 * the CLI in shards) and `check`'s `Test` step filters those two out. A split is
 * a list of what is excluded here and what is included there, and two lists of
 * one thing drift: a shard count that does not match its matrix, a filter that
 * outlives the job it handed a package to, or a package added with a `test`
 * script that a filter happens to exclude. Each leaves tests that run nowhere
 * while every job reports green. This reads both sides and fails on any package
 * left out.
 *
 * ## What counts as covering a package
 *
 *   - the one `pnpm -r ... test` command: every package except those named in
 *     its `--filter '!<name>'` options;
 *   - a command `pnpm --filter <name> test` or `test:coverage` in any job, which
 *     covers the package outright; or, with `--shard=<expression>/N`, only when
 *     that job's `shard:` list is exactly 1..N.
 *
 * It reads text, so it only understands the spellings ci.yml uses. A spelling it
 * cannot read covers nothing, which fails closed.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Names of workspace packages that carry a `test` script. */
export function testablePackages(root) {
	const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const entries = [
		...workspace.matchAll(/^\s*-\s*["']?(!?)([^"'\s#]+)["']?\s*$/gm),
	].map((m) => ({ negated: m[1] === "!", pattern: m[2] }));
	const excluded = new Set(
		entries.filter((e) => e.negated).map((e) => e.pattern),
	);
	const dirs = [];
	for (const { negated, pattern } of entries) {
		if (negated) continue;
		if (pattern.endsWith("/*")) {
			const base = pattern.slice(0, -2);
			if (!existsSync(join(root, base))) continue;
			for (const entry of readdirSync(join(root, base), {
				withFileTypes: true,
			})) {
				if (entry.isDirectory()) dirs.push(`${base}/${entry.name}`);
			}
		} else dirs.push(pattern);
	}
	const names = [];
	for (const dir of dirs) {
		if (excluded.has(dir)) continue;
		const manifest = join(root, dir, "package.json");
		if (!existsSync(manifest)) continue;
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		if (pkg.name && typeof pkg.scripts?.test === "string") names.push(pkg.name);
	}
	return names.sort();
}

/** Each job's own lines in a workflow, keyed by job id. */
export function jobBlocks(text) {
	const found = new Map();
	let inJobs = false;
	let job;
	for (const line of text.split("\n")) {
		if (/^\S/.test(line)) {
			inJobs = /^jobs:\s*$/.test(line);
			job = undefined;
			continue;
		}
		if (!inJobs) continue;
		const head = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (head) {
			job = head[1];
			found.set(job, []);
		} else if (job) found.get(job).push(line);
	}
	return found;
}

/** Command lines of a job: single-line `run:` values and block-scalar lines. */
function commands(lines) {
	const out = [];
	for (const line of lines) {
		const inline = line.match(/^\s+(?:- )?run:\s*(?![|>]\s*$)(.+)$/);
		if (inline) {
			out.push(inline[1].trim());
			continue;
		}
		if (/^\s{10,}\S/.test(line) && !line.trim().startsWith("#"))
			out.push(line.trim());
	}
	return out;
}

/**
 * @returns {{ covered: Map<string, string[]>, problems: string[] }} how each
 * package is covered, and what is wrong with the schedule.
 */
export function analyse(ciText, packages) {
	const problems = [];
	const covered = new Map(packages.map((name) => [name, []]));
	const jobs = jobBlocks(ciText);

	// 1. The recursive run: everything except its negated filters.
	const recursive = [];
	for (const [job, lines] of jobs) {
		for (const command of commands(lines)) {
			if (/^pnpm -r\b.*\btest\s*$/.test(command))
				recursive.push({ job, command });
		}
	}
	if (recursive.length === 0)
		problems.push(
			"no job runs `pnpm -r ... test`; every package would need its own job",
		);
	if (recursive.length > 1)
		problems.push(
			`more than one \`pnpm -r ... test\` command (${recursive.map((r) => r.job).join(", ")}); this check cannot say which covers what`,
		);
	if (recursive.length === 1) {
		const { job, command } = recursive[0];
		const excluded = new Set(
			[...command.matchAll(/--filter[= ]['"]?!([^'"\s]+)['"]?/g)].map(
				(m) => m[1],
			),
		);
		if (/--filter[= ]['"]?[^!'"\s]/.test(command))
			problems.push(
				`\`${command}\` carries a positive --filter, so it no longer runs the rest of the workspace`,
			);
		for (const name of packages)
			if (!excluded.has(name)) covered.get(name).push(`${job}: ${command}`);
		for (const name of excluded)
			if (!covered.has(name))
				problems.push(
					`\`${command}\` excludes ${name}, which has no \`test\` script in the workspace`,
				);
	}

	// 2. Per-package commands in jobs, whole or sharded.
	for (const [job, lines] of jobs) {
		const shardList = lines
			.map((l) => l.match(/^\s+shard:\s*\[([^\]]*)\]\s*$/))
			.find(Boolean);
		const shards = shardList
			? shardList[1].split(",").map((s) => s.trim())
			: undefined;
		for (const command of commands(lines)) {
			const m = command.match(
				/^pnpm --filter (\S+) (test|test:coverage)\b(.*)$/,
			);
			if (!m) continue;
			const [, name, , rest] = m;
			if (!covered.has(name)) {
				problems.push(
					`job \`${job}\` runs ${name}'s tests, and it has no \`test\` script in the workspace`,
				);
				continue;
			}
			const shard = rest.match(/--shard=(.+)\/(\d+)\s*$/);
			if (rest.includes("--shard") && !shard) {
				problems.push(
					`job \`${job}\` has a --shard option this check cannot read: \`${command}\``,
				);
				continue;
			}
			if (shard) {
				const count = Number(shard[2]);
				const expected = Array.from({ length: count }, (_, i) => String(i + 1));
				if (!shards || shards.join(",") !== expected.join(",")) {
					problems.push(
						`job \`${job}\` runs ${name} as ${count} shards but its \`shard:\` list is [${shards?.join(", ") ?? "missing"}]; expected [${expected.join(", ")}]`,
					);
					continue;
				}
				covered.get(name).push(`${job}: ${count} shards`);
			} else covered.get(name).push(`${job}: ${command}`);
		}
	}

	for (const [name, by] of covered) {
		if (by.length === 0)
			problems.push(
				`${name} has a \`test\` script and no job in ci.yml runs it`,
			);
	}
	return { covered, problems };
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const root = resolve(
		process.argv[2] ?? join(import.meta.dirname, "..", ".."),
	);
	const packages = testablePackages(root);
	if (packages.length === 0) {
		console.log(
			"✗ no workspace package with a test script was found; the enumeration broke, which would pass this by checking nothing",
		);
		process.exit(1);
	}
	const { covered, problems } = analyse(
		readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"),
		packages,
	);
	if (problems.length > 0) {
		console.log(`✗ TEST COVERAGE UNION — ${problems.length} problem(s):`);
		for (const line of problems) console.log(`  ${line}`);
		process.exit(1);
	}
	const split = [...covered].filter(
		([, by]) => !by.every((entry) => entry.includes("pnpm -r")),
	).length;
	console.log(
		`✓ all ${packages.length} workspace test scripts are scheduled in ci.yml (${split} run in jobs of their own)`,
	);
}
