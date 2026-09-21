#!/usr/bin/env node
/**
 * Transition gate: find every remaining use of "run" as a noun.
 *
 * The session → turn → message model removes the run: a unit of work with an
 * id is a turn, and a subagent is a child session. "Run" as a verb stays
 * (`runAgent`, `runShellHook`, `namzu run`), which is what the allowlist below
 * holds. This script lists what is left to convert while that work is in
 * flight, and reports zero hits when it is done.
 *
 * It exists only for the transition. It is not wired into any workflow, and
 * the release-verification step deletes it once it reports zero hits.
 *
 * Scans packages/{name}/src, packages/{name}/README.md, docs/ (except
 * docs/log.md), scripts/ and tools/. Skips research/, CHANGELOG.md files,
 * node_modules, build output and this file.
 *
 * Usage:
 *   node scripts/check-run-noun.mjs            list every hit, exit 1 if any
 *   node scripts/check-run-noun.mjs --summary  hits per file only
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(here, "..", "..");

export const RUN_NOUN_PATTERN =
	/\b(RunId|runId|RunEvent|run_id|parentRunId|parent_run_id|NAMZU_RUN_ID|run_(started|completed|failed|paused|resuming)|RUN_(ID|STATUS|PARENT_ID))\b|namzu\.run\.|types\/run\b|\b[A-Za-z]*Run[A-Z][A-Za-z]*\b|\b[A-Z][A-Za-z]*Run\b/g;

/** Names that keep "run" as a verb: nothing they return or carry holds a run id. */
export const ALLOWLIST = new Set([
	"runAgent",
	"RunAgentOptions",
	"RunAgentResult",
	"runShellHook",
	"runExperiment",
	"runResident",
	"runResidentLearningCycle",
	"runStoredResidentLearningCycle",
	"runStoredResidentLearningFromObservations",
	"runCompactionCheck",
	"ResidentHostRunOptions",
	"AgentNotRunningError",
	"CodeRuntime",
	"WorkerCodeRuntime",
	"WorkerCodeRuntimeOptions",
	"CodeRunOutcome",
	"CodeRunResult",
	"RunCodeOptions",
	"RunCodeToolOptions",
	"buildRunCodeTool",
	"RUN_CODE_TOOL_NAME",
	"RUNTIME_DEFAULTS",
	"PluginRuntimeConfig",
	"PluginRuntimeConfigSchema",
	"RUNTIME_CONTEXT_MESSAGE_KINDS",
	"createRuntimeContextMessage",
	"isRuntimeContextMessageSource",
	"resetRuntimeMetrics",
]);

/** `Runtime*` names are the verb sense by rule, not one by one. */
function allowed(match) {
	return ALLOWLIST.has(match) || /^Runtime[A-Z]?/.test(match);
}

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", "research", ".namzu"]);
const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|sh|ya?ml)$/;

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		const stat = statSync(path);
		if (stat.isDirectory()) yield* walk(path);
		else if (TEXT.test(name) && name !== "CHANGELOG.md") yield path;
	}
}

function* scanRoots(root) {
	const packages = join(root, "packages");
	const packageDirs = [];
	for (const name of readdirSync(packages)) {
		if (name === "providers") {
			for (const provider of readdirSync(join(packages, name))) {
				packageDirs.push(join(packages, name, provider));
			}
		} else {
			packageDirs.push(join(packages, name));
		}
	}
	for (const dir of packageDirs) {
		yield* walk(join(dir, "src"));
		const readme = join(dir, "README.md");
		try {
			if (statSync(readme).isFile()) yield readme;
		} catch {
			// no README
		}
	}
	for (const path of walk(join(root, "docs"))) {
		if (relative(root, path) !== join("docs", "log.md")) yield path;
	}
	yield* walk(join(root, "scripts"));
	yield* walk(join(root, "tools"));
}

/** Every hit in one text, as `{ line, column, match }`. */
export function findRunNouns(text) {
	const hits = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		for (const found of line.matchAll(RUN_NOUN_PATTERN)) {
			if (!allowed(found[0])) {
				hits.push({ line: index + 1, column: (found.index ?? 0) + 1, match: found[0] });
			}
		}
	}
	return hits;
}

export function checkRunNouns(root = repoRoot) {
	const self = relative(root, here);
	const report = [];
	for (const path of scanRoots(root)) {
		const shown = relative(root, path).split(sep).join("/");
		if (shown === self.split(sep).join("/")) continue;
		const hits = findRunNouns(readFileSync(path, "utf8"));
		if (hits.length > 0) report.push({ file: shown, hits });
	}
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
	const summary = process.argv.includes("--summary");
	const report = checkRunNouns();
	let total = 0;
	for (const { file, hits } of report) {
		total += hits.length;
		if (summary) {
			process.stdout.write(`${hits.length}\t${file}\n`);
		} else {
			for (const hit of hits) {
				process.stdout.write(`${file}:${hit.line}:${hit.column}: ${hit.match}\n`);
			}
		}
	}
	process.stdout.write(`run-noun gate: ${total} hit(s) in ${report.length} file(s)\n`);
	process.exitCode = total > 0 ? 1 : 0;
}
