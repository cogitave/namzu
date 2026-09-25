/**
 * How much durable state one turn leaves behind, measured through the real
 * disk stores.
 *
 * Offline and deterministic: a scripted provider drives an N-iteration turn in
 * which every iteration calls a tool that returns a few kilobytes of output and
 * pins a working-state fact, which is the shape of an agentic session (and of
 * the ARC batches whose checkpoints filled a disk). Nothing is mocked below the
 * provider: the turn goes through `drainQuery`, the turn recorder, the
 * session's `DiskSessionLog` and its `DiskSessionCheckpointStore` exactly as
 * a host's would, under a `SessionPaths` home of its own.
 *
 *   node scripts/benchmarks/runtime-state-growth.mjs [iterations] [--keep N] [--json]
 *
 * `--keep N` passes `turnConfig.pruneKeepLast`, which is what the CLI sets.
 * Reads the BUILT SDK (`packages/sdk/dist`), so run `pnpm -r build` first.
 */
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CompactionConfigSchema,
	MockLLMProvider,
	SessionPaths,
	drainQuery,
	registerMock,
	toolset,
} from "../../packages/sdk/dist/index.js";

// zod is the SDK's dependency, not the repository root's.
const sdkRequire = createRequire(
	new URL("../../packages/sdk/package.json", import.meta.url),
);
const { z } = await import(pathToFileURL(sdkRequire.resolve("zod")).href);

const args = process.argv.slice(2);
const iterations = Number(args.find((a) => /^\d+$/.test(a)) ?? 50);
const keepIndex = args.indexOf("--keep");
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) : undefined;
const asJson = args.includes("--json");

registerMock();

const root = await mkdtemp(join(tmpdir(), "namzu-state-growth-"));
const work = join(root, "work");
const stateRoot = join(root, "state");
await mkdir(work, { recursive: true });
await mkdir(stateRoot, { recursive: true });
// The layout under test: `<home>/projects/<slug>/<session-id>.jsonl`, with
// the session's checkpoints, ledgers and tool results beside it.
const paths = new SessionPaths({ home: stateRoot, slug: "bench" });

const toolsets = [
	toolset("bench", [
		{
			name: "inspect",
			description: "Inspect one region of the board",
			inputSchema: z.object({ region: z.number() }),
			readOnly: true,
			concurrencySafe: true,
			execute: async ({ region }) => ({
				success: true,
				// ~4 KB, about what a file read or a shell listing returns.
				output: `Region ${region}:\n${`cell ${region} `.repeat(400)}`,
				workingState: [{ key: "region", text: `last inspected ${region}` }],
			}),
		},
	]),
];

const turns = [];
for (let i = 1; i < iterations; i++) {
	turns.push({
		text: `Checking region ${i}.`,
		toolCalls: [{ id: `call_${i}`, name: "inspect", args: { region: i } }],
		finishReason: "tool_calls",
	});
}
turns.push({ text: "Done.", finishReason: "stop" });

const ids = {
	projectId: "00000000-0000-4000-8000-000000000001",
	sessionId: "00000000-0000-4000-8000-000000000002",
	topicId: "00000000-0000-4000-8000-000000000003",
	tenantId: "00000000-0000-4000-8000-000000000004",
};

const started = Date.now();
const turn = await drainQuery({
	provider: new MockLLMProvider({ turns }),
	toolsets,
	agentId: "bench",
	agentName: "Bench",
	messages: [{ role: "user", content: "Inspect every region." }],
	workingDirectory: work,
	paths,
	turnConfig: {
		model: "mock",
		timeoutMs: 600_000,
		tokenBudget: 100_000_000,
		maxIterations: iterations + 2,
		...(keep !== undefined ? { pruneKeepLast: keep } : {}),
	},
	compactionConfig: CompactionConfigSchema.parse({}),
	...ids,
});
const elapsedMs = Date.now() - started;

async function walk(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(path)));
		else out.push({ path, bytes: (await stat(path)).size });
	}
	return out;
}

const files = await walk(stateRoot);
const byKind = new Map();
for (const file of files) {
	const rel = relative(stateRoot, file.path);
	const kind = rel.endsWith(`${ids.sessionId}.jsonl`)
		? "<session>.jsonl"
		: rel.includes("/checkpoints/")
			? "checkpoints/*.json"
			: rel.includes("/tool-results/")
				? "tool-results/*"
				: rel.includes("/budgets/")
					? "budgets/*.json"
					: rel.split("/").at(-1);
	const entry = byKind.get(kind) ?? { files: 0, bytes: 0 };
	entry.files += 1;
	entry.bytes += file.bytes;
	byKind.set(kind, entry);
}
const checkpointFiles = files.filter(
	(f) => f.path.includes("/checkpoints/") && f.path.endsWith(".json"),
);
const report = {
	iterations,
	keep: keep ?? null,
	status: turn.status,
	messages: turn.messages.length,
	elapsedMs,
	totals: {
		files: files.length,
		bytes: files.reduce((n, f) => n + f.bytes, 0),
	},
	// The session's one log: every message and event, which checkpoints name by seq.
	log: {
		files: files.filter((f) => f.path.endsWith(`${ids.sessionId}.jsonl`))
			.length,
		bytes: files
			.filter((f) => f.path.endsWith(`${ids.sessionId}.jsonl`))
			.reduce((n, f) => n + f.bytes, 0),
	},
	checkpoints: {
		count: checkpointFiles.length,
		bytes: checkpointFiles.reduce((n, f) => n + f.bytes, 0),
		largest: Math.max(0, ...checkpointFiles.map((f) => f.bytes)),
	},
	byKind: Object.fromEntries(
		[...byKind.entries()].sort((a, b) => b[1].bytes - a[1].bytes),
	),
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
	console.log(
		`${iterations} iterations${keep !== undefined ? `, pruneKeepLast=${keep}` : ""}: ${report.status}, ${report.messages} messages, ${elapsedMs} ms`,
	);
	console.log(
		`total: ${report.totals.files} files, ${report.totals.bytes} bytes`,
	);
	console.log(
		`checkpoints: ${report.checkpoints.count} files, ${report.checkpoints.bytes} bytes (largest ${report.checkpoints.largest})`,
	);
	console.log(
		`session log: ${report.log.files} files, ${report.log.bytes} bytes`,
	);
	for (const [kind, v] of Object.entries(report.byKind))
		console.log(
			`  ${kind.padEnd(28)} ${String(v.files).padStart(4)} files ${String(v.bytes).padStart(10)} bytes`,
		);
}
if (process.env.NAMZU_BENCH_KEEP) console.log(`state kept at ${root}`);
else await rm(root, { recursive: true, force: true });
