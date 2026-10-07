/** Replay only the previously verified owned fixture journal; no engine/tool execution. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, lstat, stat, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const repo = resolve(process.argv[2] ?? ".");
const privateEvidence = resolve(process.argv[3] ?? "");
assert(
	process.argv[3] &&
		/human-read-native-journal-evidence-private-[\w-]+\.json$/.test(
			privateEvidence,
		),
);
const evidence = JSON.parse(await readFile(privateEvidence, "utf8"));
const publicEvidence = JSON.parse(
	await readFile(
		join(
			repo,
			"research/desktop-autonomy-20261007/artifacts/native-claude-owned-read-evidence.json",
		),
		"utf8",
	),
);
assert.deepEqual(evidence.receipt, publicEvidence);
const journal = resolve(evidence.nativeJournalPath);
assert.equal(await realpath(journal), journal);
assert((await lstat(journal)).isFile());
const bytes = await readFile(journal);
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(bytes), publicEvidence.nativeJournalSha256);
const frames = bytes
	.toString("utf8")
	.split(/\r?\n/)
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((row) => ["assistant", "user"].includes(row.type));
const oldModule = resolve(
	process.argv[4] ??
		join(
			dirname(privateEvidence),
			"runtime/packages/p0/dist/integrations/harness/claude-protocol.js",
		),
);
const nextModule = join(
	repo,
	"packages/cli/dist/integrations/harness/claude-protocol.js",
);
const oldBytes = await readFile(oldModule),
	nextBytes = await readFile(nextModule);
const initialFailure = JSON.parse(
	await readFile(
		join(
			repo,
			"research/desktop-autonomy-20261007/artifacts/claude-native-journal-replay-initial-failure.json",
		),
		"utf8",
	),
);
assert.equal(
	hash(oldBytes),
	initialFailure.oldModuleSha256,
	"Only the previously reviewed pre-fix module can be replayed.",
);
assert.notEqual(
	hash(oldBytes),
	hash(nextBytes),
	"Build the fixed CLI before replaying.",
);
async function replay(modulePath) {
	const { ClaudeTurnProjection } = await import(pathToFileURL(modulePath).href);
	const projection = new ClaudeTurnProjection(
		{
			nativeSessionId: "owned-fixture-replay",
			nativeTurnId: "one-recorded-operation",
			turnIdSource: "operation",
		},
		new Set(),
	);
	const events = frames.flatMap((frame) => projection.consume(frame));
	// Stored native journals omit partial stream boundaries. The actual private
	// Desktop receipt proves end_turn; this explicit fixture terminal adds no tool.
	events.push(
		...projection.consume({
			type: "result",
			subtype: "success",
			is_error: false,
		}),
	);
	return events;
}
const before = await replay(oldModule),
	after = await replay(nextModule);
const starts = after.filter((event) => event.kind === "tool-started");
const completions = after.filter((event) => event.kind === "tool-completed");
assert.equal(before.filter((event) => event.kind === "tool-started").length, 0);
assert.equal(
	before.filter((event) => event.kind === "tool-completed").length,
	0,
);
assert.equal(starts.length, 1);
assert.equal(completions.length, 1);
assert.equal(starts[0].name, "Read");
assert.equal(completions[0].name, "Read");
assert.equal(starts[0].nativeItemId, completions[0].nativeItemId);
assert.equal(completions[0].status, "completed");
const nativeFile = starts[0].input.file_path;
assert(typeof nativeFile === "string" && /^[a-z]:\\/i.test(nativeFile));
const drive = nativeFile[0].toLowerCase();
const physical = resolve(
	"/mnt",
	drive,
	nativeFile.slice(3).replaceAll("\\", "/"),
);
const expected = join(evidence.workspace, "proof-note.txt");
const a = await stat(physical, { bigint: true }),
	b = await stat(expected, { bigint: true });
assert(a.isFile() && a.dev === b.dev && a.ino === b.ino);
assert.equal(
	after.filter((event) => event.kind === "turn-completed").length,
	1,
);
const receipt = {
	schema: "namzu.claude-native-journal-replay.v1",
	passed: true,
	providerRequests: 0,
	nativeActions: 0,
	toolExecutionActions: 0,
	journalSha256: hash(bytes),
	oldModuleSha256: hash(oldBytes),
	fixedModuleSha256: hash(nextBytes),
	before: { toolStarts: 0, toolCompletions: 0 },
	after: {
		toolStarts: 1,
		toolCompletions: 1,
		matchedSuccessfulRead: true,
		readFilePhysicalIdentityMatches: true,
	},
	limitations: [
		"The actual owned native journal contains completed content blocks, not every partial stream event.",
		"One terminal frame is synthesized from the separately confirmed end_turn; it adds no tool evidence.",
		"This verifies the compiled normalizer against actual recorded blocks, not a new live provider request or write permission policy.",
	],
};
await writeFile(
	join(
		repo,
		"research/desktop-autonomy-20261007/artifacts/claude-native-journal-replay-proof.json",
	),
	JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt));
