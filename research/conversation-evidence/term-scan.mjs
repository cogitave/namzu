import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createDiskRunTextEvidenceSource } from '../../packages/sdk/dist/index.js';

// Run against the isolated artifact produced by natural-cli.mjs, never a user's workspace.
const resultPath = process.argv[2];
assert(resultPath, 'Pass the /tmp/.../result.json produced by natural-cli.mjs.');
const fixture = JSON.parse(await readFile(resultPath, 'utf8'));
assert(fixture.prerequisites.capturedBoth && fixture.prerequisites.successfulInitialRead);
const root = dirname(resultPath);
const terms = ['DELTA', 'takip', 'deposu'];
let selected;
for (const session of await readdir(join(root, 'home', 'sessions'), { withFileTypes: true })) {
  if (!session.isDirectory()) continue;
  const runs = join(root, 'home', 'sessions', session.name, 'runs');
  for (const run of await readdir(runs, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const runDir = join(runs, run.name);
    const events = (await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const read = events.find(e => e.type === 'tool_completed' && e.toolName === 'read' && e.outputSpillIntegrity);
    if (!read) continue;
    assert(!selected, 'Fixture has more than one retained initial read; inspect rather than choosing silently.');
    const metadata = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    selected = { runDir, scope: metadata.metadata.scope, seq: read.seq };
  }
}
assert(selected, 'No retained original read found.');
const source = createDiskRunTextEvidenceSource({ ...selected, indexDir: join(selected.runDir, 'evidence-index') });
async function scan(search) {
  let cursor; const matches = []; let scannedBytes = 0; let calls = 0;
  do {
    assert(calls < 16, 'The measurement exhausted its bounded page allowance.');
    const page = await source.search({ ...search, caseSensitive: false, seq: selected.seq, cursor });
    assert(page.scannedBytes <= 8 * 1024 * 1024);
    assert(!page.incomplete && page.unavailable.length === 0, 'Source unavailable; no successful measurement.');
    scannedBytes += page.scannedBytes; calls++; matches.push(...page.matches); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { calls, scannedBytes, matches: matches.map(m => ({ seq: m.seq, part: m.part, byteOffset: m.byteOffset, excerpt: m.excerpt })) };
}
// Warm the same source/index for each condition; this is not a cold-cache comparison.
await scan({ terms });
const combined = await scan({ terms });
const separate = [];
for (const query of terms) separate.push({ query, ...await scan({ query }) });
const hasOriginals = matches => Object.values(fixture.original).every(id => matches.some(m => m.excerpt.includes(id)));
assert(hasOriginals(combined.matches)); assert(hasOriginals(separate.flatMap(s => s.matches)));
const report = { fixtureRoot: root, scope: selected.scope, seq: selected.seq, terms, combined, separate,
  separateScannedBytes: separate.reduce((n,s) => n+s.scannedBytes,0),
  separateCalls: separate.reduce((n,s) => n+s.calls,0), recoveredBoth: true, fingerprints: {} };
for (const path of ['packages/sdk/src/store/evidence/disk.ts','packages/sdk/src/store/evidence/linked.ts','packages/sdk/src/store/evidence/passages.ts','packages/sdk/src/store/evidence/search-input.ts','research/conversation-evidence/term-scan.mjs'])
  report.fingerprints[path] = createHash('sha256').update(await readFile(new URL('../../'+path, import.meta.url))).digest('hex');
await writeFile(join(root, 'term-scan.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ root, recoveredBoth:report.recoveredBoth, combinedCalls:combined.calls, combinedBytes:combined.scannedBytes,
  separateCalls:report.separateCalls, separateBytes:report.separateScannedBytes }));
