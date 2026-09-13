// Closed matching runs should share a public search page inside its existing caps.
// Baseline is storage-only; --live opts into one bounded low-effort CLI run.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const baseline = process.argv.includes("--baseline");
const live = process.argv.includes("--live");
assert.ok(!(baseline && live));
const root = await mkdtemp(join(tmpdir(), "namzu-matching-runs-"));
const home = join(root, "home");
const cwd = join(root, "workspace");
await mkdir(home);
await mkdir(cwd);
process.env.NAMZU_HOME = home;
await writeFile(
	join(home, "preferences.json"),
	JSON.stringify({
		version: 3,
		providers: [{ id: "codex", model: "gpt-5.6-luna" }],
		subagents: { active: [] },
	}),
);
await writeFile(
	join(home, "config.yaml"),
	"web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n",
);
const sdkURL = new URL("../../packages/sdk/dist/index.js", import.meta.url);
const sdk = await import(sdkURL);
const storage = await import(
	"../../packages/cli/dist/integrations/sessions/store.js"
);
const evidence = await import(
	"../../packages/cli/dist/integrations/sessions/conversation-search.js"
);
const fingerprints = async () =>
	Object.fromEntries(
		await Promise.all(
			[
				"packages/cli/dist/integrations/sessions/conversation-search.js",
				"packages/cli/dist/tui/agent.js",
				"packages/sdk/dist/store/evidence/disk.js",
			].map(async (path) => [
				path,
				createHash("sha256")
					.update(await readFile(new URL(`../../${path}`, import.meta.url)))
					.digest("hex"),
			]),
		),
	);
const report = {
	root,
	baseline,
	live,
	matchingAnnouncements: 6,
	passes: [],
	buildBefore: await fingerprints(),
};
let sessions;
let sessionId;
try {
	const seeded = await exec(
		process.execPath,
		[fileURLToPath(new URL("./cli.mjs", import.meta.url)), "--seed", cwd],
		{ cwd, timeout: 30000, maxBuffer: 1000000 },
	);
	report.seed = JSON.parse(seeded.stdout);
	sessions = await storage.openSessions(cwd);
	sessionId = sdk.asSessionId(report.seed.sessionId);
	const runs = join(home, "sessions", sessionId, "runs");
	for (let i = 1; i <= report.matchingAnnouncements; i++) {
		const runId = sdk.asRunId(
			`00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
		);
		assert.ok(runId < report.seed.runId);
		const store = new sdk.RunDiskStore({ baseDir: runs });
		await store.initRun(runId);
		await store.appendEvent({ type: "run_started", runId, seq: 1 });
		await store.appendEvent({
			type: "message_completed",
			runId,
			seq: 2,
			content: `DELTA inspection ${i}: I intend to locate the receipt; no original code is recorded in this statement.`,
		});
		await store.appendEvent({ type: "run_completed", runId, seq: 3 });
		await writeFile(
			join(runs, runId, "run.json"),
			JSON.stringify({
				id: runId,
				status: "completed",
				metadata: {
					scope: {
						tenantId: sessions.tenantId,
						projectId: sessions.projectId,
						sessionId,
						runId,
					},
				},
			}),
		);
	}
	for (const temperature of ["cold", "warm"]) {
		const pass = { temperature, pages: [] };
		const identities = new Set();
		let cursor;
		let found;
		for (let step = 0; step < 16; step++) {
			const page = await evidence.searchConversation(
				sessions,
				sessionId,
				cursor ? { cursor } : { query: "DELTA" },
			);
			assert.ok(page.matches.length <= 5);
			assert.ok(page.scannedBytes <= 8 * 1024 * 1024);
			assert.ok(Buffer.byteLength(JSON.stringify(page.matches)) <= 12000);
			assert.equal(page.unavailableRuns, 0);
			pass.pages.push(page);
			for (const m of page.matches) {
				const id = JSON.stringify([m.runId, m.seq, m.part, m.byteOffset]);
				assert.ok(!identities.has(id));
				identities.add(id);
			}
			found = page.matches.find(
				(m) => m.runId === report.seed.runId && m.seq === report.seed.seq,
			);
			cursor = page.nextCursor;
			if (found || !cursor) break;
		}
		assert.ok(found, "Original read observation must remain reachable");
		assert.equal(pass.pages.length, baseline ? 7 : 2);
		const exact = await evidence.readConversationEvidence(
			sessions,
			sessionId,
			found,
		);
		assert.ok(exact.text.includes(report.seed.tracking));
		report.passes.push(pass);
	}
	await evidence.releaseConversationEvidence(sessions, sessionId);
	if (live) {
		const args = [
			"--quiet",
			"--format",
			"json",
			"run",
			"--trust",
			"--cwd",
			cwd,
			"--resume",
			sessionId,
			"--provider",
			"codex",
			"--model",
			"gpt-5.6-luna",
			"--effort",
			"low",
			"--max-iterations",
			"6",
			"--token-budget",
			"40000",
			"Recover the exact tracking code and destination from the original DELTA receipt we observed earlier. The current manifest was replaced. Use the recorded conversation to recover the original identifiers, then read the exact retained passage. Earlier announcements about looking for the receipt are not observations. Do not use workspace files, shell commands, edits or external services.",
		];
		report.command = args;
		const output = await exec(
			process.execPath,
			[
				fileURLToPath(
					new URL("../../packages/cli/dist/bin.js", import.meta.url),
				),
				...args,
			],
			{ cwd, timeout: 120000, maxBuffer: 2000000 },
		).catch((error) => {
			report.commandError = String(error);
			return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
		});
		report.stdout = output.stdout;
		report.stderr = output.stderr;
		const events = [];
		for (const entry of await readdir(runs, { withFileTypes: true })) {
			if (
				!entry.isDirectory() ||
				entry.name === report.seed.runId ||
				entry.name.startsWith("00000000-")
			)
				continue;
			const raw = await readFile(
				join(runs, entry.name, "transcript.jsonl"),
				"utf8",
			);
			events.push(...raw.trim().split("\n").map(JSON.parse));
		}
		report.calls = events
			.filter((e) => e.type === "tool_executing")
			.map((e) => ({ name: e.toolName, input: e.input }));
		report.outputs = events
			.filter((e) => e.type === "tool_completed")
			.map((e) => ({ name: e.toolName, isError: e.isError, result: e.result }));
		report.result = JSON.parse(output.stdout);
		assert.equal(report.commandError, undefined);
		assert.ok(report.result.text.includes(report.seed.tracking));
		assert.ok(report.result.text.includes(report.seed.destination));
		assert.ok(report.calls.some((e) => e.name === "search_conversation"));
		assert.ok(report.calls.some((e) => e.name === "read_conversation"));
		assert.ok(
			report.calls.every((e) =>
				["search_conversation", "read_conversation", "search_tools"].includes(
					e.name,
				),
			),
		);
		assert.ok(report.outputs.every((e) => !e.isError));
	}
	assert.match(
		await readFile(join(cwd, "manifest.txt"), "utf8"),
		/^Manually replaced/,
	);
	report.passed = true;
} catch (error) {
	report.passed = false;
	report.error = String(error);
	process.exitCode = 1;
} finally {
	if (sessions && sessionId)
		await evidence.releaseConversationEvidence(sessions, sessionId);
	report.buildAfter = await fingerprints();
	if (
		JSON.stringify(report.buildBefore) !== JSON.stringify(report.buildAfter)
	) {
		report.passed = false;
		report.error = "Build changed during probe";
		process.exitCode = 1;
	}
	await writeFile(
		join(root, "result.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	console.log(
		JSON.stringify({
			root,
			baseline,
			live,
			passed: report.passed,
			pages: report.passes.map((p) => p.pages.length),
			usage: report.result?.usage,
			error: report.error,
		}),
	);
}
