import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDiskStore, asRunId } from '../../packages/sdk/dist/index.js';
import { applyToolOutputBudget } from '../../packages/sdk/dist/runtime/query/tool-output-budget.js';

const seedPath = process.argv.find(arg => arg.startsWith('--seed='))?.slice('--seed='.length);
const seed = seedPath ? JSON.parse(await readFile(seedPath, 'utf8')) : undefined;
const root = await mkdtemp(join(tmpdir(), 'namzu-text-link-measure-'));
const scope = seed?.scope ?? { tenantId: randomUUID(), projectId: randomUUID(), sessionId: randomUUID(), runId: asRunId(randomUUID()) };
const store = new RunDiskStore({ baseDir: root });
const runDir = await store.initRun(scope.runId);
await writeFile(join(runDir, 'run.json'), JSON.stringify({ id: scope.runId, status: 'running', metadata: { scope } }));
const code = seed?.code ?? `RECEIPT-${randomUUID()}`;
const text = `${'packing record '.repeat(12000)}\nDELTA tracking ${code}\n${'remaining record '.repeat(12000)}`;
const retained = applyToolOutputBudget({ toolUseId: 'receipt', toolName: 'read', output: text, maxChars: 1000, spillDir: join(runDir, 'tool-output') });
let seq = 0;
const append = (event) => store.appendEvent({ ...event, runId: scope.runId, seq: ++seq });
await append({ type: 'run_started' });
await append({ type: 'tool_completed', toolName: 'read', toolUseId: 'receipt', isError: false, result: retained.output, outputTruncated: true, outputSpillIntegrity: retained.spillIntegrity });
for (let i = 0; i < 512; i++) await append({ type: 'iteration_started', iteration: i + 1 });

const pages = []; let cursor; let found;
for (let i = 0; i < 2; i++) {
  const source = await store.captureTextEvidence(scope);
  const page = await source.search({ terms: ['DELTA', 'tracking'], caseSensitive: false, cursor, limit: 4 });
  pages.push({ scannedBytes: page.scannedBytes, indexedRecords: page.indexedRecords, matches: page.matches.length, incomplete: page.incomplete, hasContinuation: page.nextCursor !== null });
  found ??= page.matches.find(m=>m.excerpt.includes(code));
  cursor = page.nextCursor ?? undefined;
  if(!cursor)break;
}
assert.ok(!retained.output.includes(code));
const report = { root, scope, code, seedPath, nontextRecords: 512, withinTwoPages: !!found, pages, scannedBytes: pages.reduce((n,p)=>n+p.scannedBytes,0), transcriptBytes: (await readFile(join(runDir,'transcript.jsonl'))).length, fingerprints: {} };
if(found) {
  const source = await store.captureTextEvidence(scope);
  const exact = await source.read({address:found.address,byteOffset:found.byteOffset});
  report.exactRecovered = exact.text.includes(code);
  assert.equal(report.exactRecovered,true);
}
for(const path of ['packages/sdk/src/store/run/disk.ts','packages/sdk/src/store/evidence/record-chain.ts','packages/sdk/src/store/evidence/linked.ts','research/conversation-evidence/text-links.mjs'])report.fingerprints[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');
await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if (process.argv.includes('--expect-found')) assert.equal(report.withinTwoPages,true);
