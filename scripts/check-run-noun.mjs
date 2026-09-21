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

/**
 * More verb-sense names, outside the SDK list above. Each one names running a
 * process or a command, not a unit of work with an id:
 *
 * - the `namzu run` command and the functions that run the CLI and doctor
 *   (`parseRunFlags`, `RunFlags`, `RunCliOptions`, `RunDoctorOptions`);
 * - `LiveSession.run()`'s options (`LiveRunOptions`);
 * - `docker run` argv and whether a guest can run node (the sandbox names);
 * - a workflow step's `run:` body (`stepRunBody`);
 * - Apple's `CFRunLoop`.
 */
export const VERB_SENSE = new Set([
	"parseRunFlags",
	"RunFlags",
	"RunCliOptions",
	"RunDoctorOptions",
	"LiveRunOptions",
	"buildDockerRunArgs",
	"renderEgressProxyRunArgs",
	"DockerRunArgvInput",
	"DockerRun",
	"guestCanRunNode",
	"stepRunBody",
	"CFRunLoop",
]);

/**
 * AG-UI's own vocabulary. An AG-UI run is a namzu turn (spec §5.1): the
 * adapter echoes the client's `runId` verbatim and records it as
 * `origin.externalTurnId`, so these names stay, but only where AG-UI is the
 * subject: the adapter package and the page that documents it.
 */
const AG_UI_NAMES = new Set([
	"RunAgentInput",
	"RunAgentInputSchema",
	"runId",
	"onRunFailed",
	"onRunErrorEvent",
	"onRunFinishedEvent",
]);
const AG_UI_PATHS = [/^packages\/ag-ui\//, /^docs\/sdk\/ag-ui\.md$/];

/**
 * Hits that name the old concept on purpose, one file at a time: code that
 * refuses a run-era document by its run fields, and tests that assert a run
 * name is absent or refused. They go when W10 deletes this script.
 */
export const INTENTIONAL = new Map([
	// parseTurnState refuses a RunState by its `runId` and names it.
	["packages/sdk/src/types/session/turn-state.ts", new Set(["RunState", "runId"])],
	["packages/sdk/src/runtime/query/__tests__/durable-run-state.test.ts", new Set(["RunState", "runId"])],
	// A session record never carries the live-only `runId`; the schema refuses it.
	["packages/sdk/src/types/session/records.ts", new Set(["runId"])],
	// The fixtures pin that run-era type names and a `runId` field are refused.
	[
		"packages/sdk/src/session/__tests__/session-log-fixtures.test.ts",
		new Set(["run_started", "run_completed", "run_failed", "run_paused", "run_resuming", "runId"]),
	],
	// Negative assertions: an SSE frame has no `run_id`, a turn span no `namzu.run.*`.
	["packages/sdk/src/bridge/sse/mapper.test.ts", new Set(["run_id"])],
	["packages/sdk/src/telemetry/__tests__/a-turn-span-names-its-session.test.ts", new Set(["namzu.run."])],
]);

/** `Runtime*` names are the verb sense by rule, not one by one. */
function allowed(match, file) {
	if (ALLOWLIST.has(match) || VERB_SENSE.has(match) || /^Runtime[A-Z]?/.test(match)) return true;
	if (file === undefined) return false;
	if (AG_UI_NAMES.has(match) && AG_UI_PATHS.some((path) => path.test(file))) return true;
	return INTENTIONAL.get(file)?.has(match) ?? false;
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

/**
 * Every hit in one text, as `{ line, column, match }`. `file` is the
 * repo-relative path with forward slashes; the per-file exemptions apply only
 * when it is given.
 */
export function findRunNouns(text, file) {
	const hits = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		for (const found of line.matchAll(RUN_NOUN_PATTERN)) {
			if (!allowed(found[0], file)) {
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
		const hits = findRunNouns(readFileSync(path, "utf8"), shown);
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
