/**
 * How much durable state the headless CLI leaves behind, measured end to end.
 *
 * Offline: a local HTTP server speaks just enough of the default provider's Messages
 * API (streamed) to script a tool loop — every model turn but the last asks
 * for `read` on a different ~4 KB file, the last one answers. The CLI under
 * test is the BUILT one (`packages/cli/dist/bin.js`), launched as a separate
 * process with `NAMZU_HOME` pointed at a scratch directory, so every byte it
 * writes is the byte a real `namzu run` would write.
 *
 *   node scripts/benchmarks/cli-state-growth.mjs [turns] [iterations] [--json]
 *
 * `turns` is how many `namzu run` invocations to make from the same working
 * directory (headless runs do not write their conversation to the session
 * store, so each is its own conversation); `iterations` is how many tool calls
 * each invocation makes before answering. It reports files and bytes under
 * the application home, how many Projects and Sessions the store holds, and
 * whether anything was written into the working directory.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const numbers = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const turns = Number(numbers[0] ?? 3);
const iterations = Number(numbers[1] ?? 10);
const asJson = process.argv.includes("--json");

const root = await mkdtemp(join(tmpdir(), "namzu-cli-growth-"));
const home = join(root, "home");
const work = join(root, "work");
await mkdir(join(work, "data"), { recursive: true });
await mkdir(home, { recursive: true });
for (let i = 1; i <= iterations; i++) {
	await writeFile(
		join(work, "data", `f${i}.txt`),
		`File ${i}\n${`line of file ${i}\n`.repeat(250)}`,
	);
}

/**
 * The tool calls already in the request decide what the model says next.
 *
 * Counted from the newest operator prompt (every prompt this script sends
 * ends "read the data files."), because the CLI adds request-only context
 * after the history and a "last user message" is not always the operator's.
 */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block?.type === "text" ? block.text : ""))
		.join("\n");
}

function nextTurn(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	let from = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user" && textOf(m.content).includes("read the data files.")) {
			from = i;
			break;
		}
	}
	let calls = 0;
	for (const m of messages.slice(from)) {
		if (m.role === "assistant" && Array.isArray(m.content))
			calls += m.content.filter((b) => b?.type === "tool_use").length;
	}
	return calls < iterations
		? { tool: { name: "read", input: { path: `data/f${calls + 1}.txt` } } }
		: { text: `Read ${calls} files.` };
}

let requests = 0;
function sse(res, events) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	for (const [event, data] of events)
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	res.end();
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", () => {
		if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
			if (req.url?.startsWith("/v1/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						data: [{ id: "claude-sonnet-4-5", type: "model" }],
						has_more: false,
					}),
				);
				return;
			}
			res.writeHead(404).end();
			return;
		}
		if (req.url.startsWith("/v1/messages/count_tokens")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
			return;
		}
		requests += 1;
		const body = JSON.parse(raw);
		const turn = nextTurn(body);
		const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20 };
		const start = [
			"message_start",
			{
				type: "message_start",
				message: {
					id: `msg_${requests}`,
					type: "message",
					role: "assistant",
					model: body.model,
					content: [],
					stop_reason: null,
					usage: { ...usage, output_tokens: 1 },
				},
			},
		];
		if (turn.tool) {
			sse(res, [
				start,
				[
					"content_block_start",
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: `toolu_${requests}`,
							name: turn.tool.name,
							input: {},
						},
					},
				],
				[
					"content_block_delta",
					{
						type: "content_block_delta",
						index: 0,
						delta: {
							type: "input_json_delta",
							partial_json: JSON.stringify(turn.tool.input),
						},
					},
				],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				[
					"message_delta",
					{
						type: "message_delta",
						delta: { stop_reason: "tool_use" },
						usage: { output_tokens: 20 },
					},
				],
				["message_stop", { type: "message_stop" }],
			]);
		} else {
			sse(res, [
				start,
				[
					"content_block_start",
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
				],
				[
					"content_block_delta",
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: turn.text },
					},
				],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				[
					"message_delta",
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: { output_tokens: 20 },
					},
				],
				["message_stop", { type: "message_stop" }],
			]);
		}
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const env = {
	...process.env,
	NAMZU_HOME: home,
	HOME: join(root, "os-home"),
	ANTHROPIC_API_KEY: "sk-ant-benchmark",
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
	NAMZU_LOG_LEVEL: "silent",
};
await mkdir(env.HOME, { recursive: true });

function namzu(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[join(repo, "packages/cli/dist/bin.js"), ...args],
			{ cwd: work, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

const started = Date.now();
for (let t = 0; t < turns; t++) {
	const result = await namzu([
		"run",
		"--provider",
		"anthropic",
		"--model",
		"claude-sonnet-4-5",
		"--trust",
		"--yolo",
		`Turn ${t + 1}: read the data files.`,
	]);
	if (process.env.NAMZU_BENCH_VERBOSE)
		console.error(result.out.slice(-2000), result.err.slice(-2000));
	if (result.code !== 0) {
		console.error(result.out, result.err);
		throw new Error(`namzu run exited ${result.code} on turn ${t + 1}`);
	}
}
const elapsedMs = Date.now() - started;
server.close();

async function walk(dir) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(path)));
		else out.push({ path, bytes: (await stat(path)).size });
	}
	return out;
}

const files = await walk(home);
const byKind = new Map();
for (const file of files) {
	const rel = relative(home, file.path);
	const parts = rel.split("/");
	let kind = parts.at(-1);
	if (rel.includes("/checkpoints/") && kind.endsWith(".json"))
		kind = "runs/*/checkpoints/*.json";
	else if (rel.includes("/history/")) kind = "runs/*/history/*.jsonl";
	else if (rel.includes("/runs/")) kind = `runs/*/${parts.at(-1)}`;
	else if (parts[0] === "sessions") kind = `sessions/*/${parts.at(-1)}`;
	else if (parts[0] === "memory") kind = "memory/**";
	const entry = byKind.get(kind) ?? { files: 0, bytes: 0 };
	entry.files += 1;
	entry.bytes += file.bytes;
	byKind.set(kind, entry);
}
// How many Projects the invocations produced: one per working directory is
// the contract, one per invocation is the defect this measures for.
let projects = null;
let sessions = null;
try {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(join(home, "state", "sessions.sqlite"), {
		readOnly: true,
	});
	projects = db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
	sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
	db.close();
} catch {
	// No store, or no node:sqlite: report the counts as unknown.
}
const runDirs = new Set(
	files
		.map((f) => relative(home, f.path).match(/^sessions\/[^/]+\/runs\/[0-9a-f-]{36}(?=\/)/)?.[0])
		.filter(Boolean),
);
const report = {
	turns,
	iterationsPerTurn: iterations,
	modelRequests: requests,
	elapsedMs,
	home: {
		files: files.length,
		bytes: files.reduce((n, f) => n + f.bytes, 0),
	},
	projects,
	sessions,
	runDirectories: runDirs.size,
	workingDirectoryDotNamzu: existsSync(join(work, ".namzu")),
	byKind: Object.fromEntries(
		[...byKind.entries()].sort((a, b) => b[1].bytes - a[1].bytes),
	),
};
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
	console.log(
		`${turns} turns x ${iterations} tool calls: ${requests} model requests, ${elapsedMs} ms`,
	);
	console.log(
		`NAMZU_HOME: ${report.home.files} files, ${report.home.bytes} bytes; <cwd>/.namzu written: ${report.workingDirectoryDotNamzu}`,
	);
	console.log(
		`projects: ${projects ?? "unknown"}, sessions: ${sessions ?? "unknown"}, run directories: ${runDirs.size}`,
	);
	for (const [kind, v] of Object.entries(report.byKind))
		console.log(
			`  ${kind.padEnd(34)} ${String(v.files).padStart(4)} files ${String(v.bytes).padStart(10)} bytes`,
		);
}
if (process.env.NAMZU_BENCH_KEEP) console.log(`state kept at ${root}`);
else await rm(root, { recursive: true, force: true });
