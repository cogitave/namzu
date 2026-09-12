import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Offline verification of a recorded positive probe. No model or original
// action is invoked. A complete authenticated excerpt can answer a short code;
// requiring an unnecessary extra read would measure tool count, not recovery.
const root = resolve(process.argv[2]);
const report = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const events = text => text.trim().split('\n').map(JSON.parse);
const runDir = join(root, 'home', 'sessions', report.seed.sessionId, 'runs', report.seed.runId);
const original = events(await readFile(join(root, 'original.jsonl'), 'utf8'));
const retained = original.find(e => e.type === 'tool_completed' && e.toolUseId === 'effect');
assert.ok(retained?.outputSpillIntegrity);
assert.equal(retained.result.includes(report.receipt), false);
assert.equal(digest(await readFile(retained.outputSpillPath)), report.originalOutputHash);
const final = events(await readFile(join(runDir, 'transcript.jsonl'), 'utf8'));
assert.equal(final.filter(e => e.type === 'tool_executing' && e.toolName === 'bash' && e.input?.command === 'node record-once.cjs').length, 1);
assert.equal(await readFile(join(root, 'workspace', 'counter.txt'), 'utf8'), '1');
const searches = final.filter(e => e.type === 'tool_completed' && e.toolName === 'search_conversation' && !e.isError);
assert.ok(searches.some(e => JSON.parse(e.result).matches.some(m => m.runId === report.seed.runId && m.seq === retained.seq && m.toolName === 'bash' && m.retained === 'full' && m.text.includes(report.receipt))));
assert.ok(final.findLast(e => e.type === 'run_completed')?.result.includes(report.receipt));
const metadata = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
assert.equal(metadata.status, 'completed');
for (const field of ['tenantId', 'projectId', 'sessionId', 'runId']) assert.equal(metadata.metadata.scope[field], report.seed[field]);
const currentHashes = Object.fromEntries(await Promise.all(Object.keys(report.before).map(async path => [path, digest(await readFile(new URL('../../' + path, import.meta.url)))])));
assert.deepEqual(currentHashes, report.before);
const verification = { passed: true, root, originalHarnessPassed: report.passed, originalHarnessError: report.error, recoveredReceipt: true, originalActionStarts: 1, counter: 1, usage: metadata.tokenUsage, budget: metadata.budget, currentHashes };
await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify({ root, passed: true, tokens: metadata.tokenUsage.totalTokens }));
