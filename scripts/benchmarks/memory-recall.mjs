/** Opt-in, paid-provider benchmark. Never discovered by the offline eval runner. */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSessions } from "../../packages/cli/dist/integrations/sessions/store.js";
import { DiskMemoryStore } from "../../packages/sdk/dist/index.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const output = process.argv[2];
if (!output)
	throw new Error(
		"Usage: node scripts/benchmarks/memory-recall.mjs <new-output-directory>",
	);
const out = resolve(output);
await mkdir(out, { recursive: false });
const cwd = await mkdtemp("/tmp/namzu-recall-score-");
const scope = await openSessions(cwd);
const store = new DiskMemoryStore({
	baseDir: join(scope.root, "projects", scope.projectId),
});
const common =
	"Answer using only this project's active memory, current user instructions and any current artifact named in the question. You may use memory tools. Do not modify files or memory, delegate, or inspect outside this project. Return only the requested value, with no explanation; if it is not supported, return UNKNOWN.";
const scenarios = [
	{
		id: "body-fact",
		make: (n) => ({
			title: "Prior investigation",
			summary: "A service finding",
			content: `cobalt${n} retention is ${17 + n} hours.`,
			question: `What is cobalt${n} retention in hours?`,
			expected: String(17 + n),
		}),
	},
	{
		id: "corrected",
		make: (n) => ({
			title: `violet${n} TTL`,
			summary: "Configuration note",
			content: `violet${n} TTL is 14 hours.`,
			update: { content: `violet${n} TTL is ${28 + n} hours.` },
			question: `What is violet${n} TTL in hours?`,
			expected: String(28 + n),
		}),
	},
	{
		id: "archived",
		make: (n) => ({
			title: `copper${n} region`,
			summary: "Obsolete configuration",
			content: `copper${n} region is east.`,
			update: { status: "archived" },
			question: `What is the currently supported copper${n} region?`,
			expected: "UNKNOWN",
		}),
	},
	{
		id: "user-override",
		make: (n) => ({
			title: `saffron${n} port`,
			summary: "Earlier configuration",
			content: `saffron${n} port is 4100.`,
			question: `I have changed saffron${n} port to ${6200 + n}. What port should you use now?`,
			expected: String(6200 + n),
		}),
	},
	{
		id: "fresh-file",
		make: (n) => ({
			title: `indigo${n} concurrency`,
			summary: "Earlier configuration",
			content: `indigo${n} concurrency is 8.`,
			file: JSON.stringify({ service: `indigo${n}`, concurrency: 12 + n }),
			question: `Read current.json for the current indigo${n} configuration. What concurrency should you use?`,
			expected: String(12 + n),
		}),
	},
	{
		id: "unrelated",
		make: (n) => ({
			title: `opal${n} connection`,
			summary: "Earlier observation",
			content: `opal${n} connection timeout is 19 seconds.`,
			question: `What is quartz${n} queue delay in seconds?`,
			expected: "UNKNOWN",
		}),
	},
];
const manifest = {
	revision: execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	}).trim(),
	model: "gpt-5.6-luna",
	provider: "codex",
	effort: "low",
	maxIterations: 6,
	tokenBudget: 30000,
	trials: 2,
	cwd,
	projectId: scope.projectId,
	common,
	scenarios: scenarios.map((s) => ({
		id: s.id,
		variants: [s.make(0), s.make(1)],
	})),
	scoring:
		"trim, lowercase, remove one final period; exact equality; errors/incomplete runs are failures",
	arms: "same CLI revision; only memory.recall differs; tools available in both arms",
	startedAt: new Date().toISOString(),
};
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
const rows = [];
for (const scenario of scenarios)
	for (let trial = 0; trial < 2; trial++) {
		const fixture = scenario.make(trial);
		for (const recall of trial === 0 ? [false, true] : [true, false]) {
			for (const entry of (await store.list()).entries)
				await store.delete(entry.id);
			const { entry } = await store.create({
				title: fixture.title,
				summary: fixture.summary,
				content: fixture.content,
			});
			if (fixture.update) await store.update(entry.id, fixture.update);
			await writeFile(join(cwd, "current.json"), fixture.file ?? "{}");
			await writeFile(
				join(cwd, "namzu.config.json"),
				JSON.stringify({ memory: { recall } }),
			);
			const label = `${scenario.id}-${trial}-${recall ? "on" : "off"}`;
			const args = [
				join(repo, "packages/cli/dist/bin.js"),
				"run-stream",
				"--cwd",
				cwd,
				"--trust",
				"--provider",
				"codex",
				"--model",
				"gpt-5.6-luna",
				"--effort",
				"low",
				"--max-iterations",
				"6",
				"--token-budget",
				"30000",
				"--",
				`${common}\n${fixture.question}`,
			];
			const started = Date.now();
			const result = await new Promise((resolveChild) => {
				const child = spawn(process.execPath, args, {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				child.stdout.on("data", (d) => {
					stdout += d;
				});
				child.stderr.on("data", (d) => {
					stderr += d;
				});
				let forceTimer;
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
					forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
				}, 90000);
				child.on("error", (error) => {
					stderr += String(error);
				});
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					clearTimeout(forceTimer);
					resolveChild({ code, signal, stdout, stderr, timedOut });
				});
			});
			await writeFile(join(out, `${label}.jsonl`), result.stdout);
			await writeFile(join(out, `${label}.stderr`), result.stderr);
			const events = result.stdout.split("\n").flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
			const done = events.findLast((e) => e.kind === "done");
			const usage = events.findLast((e) => e.kind === "usage");
			const errors = events.filter((e) => e.kind === "error");
			const answer = done?.text ?? "";
			const normalized = answer.trim().toLowerCase().replace(/\.$/, "");
			const healthy =
				result.code === 0 &&
				!result.timedOut &&
				!errors.length &&
				done?.stopReason === "end_turn" &&
				!events.some((e) => e.kind === "provider-fallback");
			const row = {
				task: scenario.id,
				trial,
				recall,
				label,
				expected: fixture.expected,
				answer,
				passed: healthy && normalized === fixture.expected.toLowerCase(),
				healthy,
				stopReason: done?.stopReason,
				exitCode: result.code,
				timedOut: result.timedOut,
				errors,
				durationMs: Date.now() - started,
				tokens: usage?.totalTokens ?? null,
				cost: usage?.cost ?? null,
				tools: events
					.filter((e) => e.kind === "tool-start")
					.map((e) => e.name ?? e.toolName),
				modelRequests: events.filter((e) => e.kind === "usage").length,
			};
			rows.push(row);
			await writeFile(join(out, "results.json"), JSON.stringify(rows, null, 2));
			console.log(JSON.stringify(row));
			if (!healthy)
				throw new Error(
					`Run ${label} did not finish cleanly. Results retained; investigate before spending more.`,
				);
		}
	}
const summary = {
	totalRuns: rows.length,
	arms: [false, true].map((recall) => {
		const rs = rows.filter((r) => r.recall === recall);
		return {
			recall,
			passed: rs.filter((r) => r.passed).length,
			total: rs.length,
			tokens: rs.reduce((n, r) => n + (r.tokens ?? 0), 0),
			tools: rs.reduce((n, r) => n + r.tools.length, 0),
			durationMs: rs.reduce((n, r) => n + r.durationMs, 0),
		};
	}),
	tasks: scenarios.map((s) => ({
		id: s.id,
		off: rows.filter((r) => r.task === s.id && !r.recall && r.passed).length,
		on: rows.filter((r) => r.task === s.id && r.recall && r.passed).length,
		trials: 2,
	})),
};
await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
