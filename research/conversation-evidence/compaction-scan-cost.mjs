import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { RunDiskStore, asRunId, createUserMessage, createDiskRunTextEvidenceSource } from '../../packages/sdk/dist/index.js';
const root = await mkdtemp(join(tmpdir(), 'namzu-archive-scan-cost-'));
const scope = { tenantId: randomUUID(), projectId:randomUUID(), sessionId: randomUUID(), runId: asRunId(randomUUID()) };
const store = new RunDiskStore({baseDir:root});
const runDir = await store.initRun(scope.runId);
await writeFile(join(runDir,'run.json'), JSON.stringify({id: scope.runId, status:'completed', metadata:{scope}}));
await store.appendEvent({type:'run_started', runId: scope.runId, seq:1});
const messages = Array.from({length:2048}, (_,i)=>createUserMessage(`Message ${i}: ${'ordinary background '.repeat(200)} ${i===2047 ? 'ORCHID-SCAN-COST-RECEIPT' : ''}`));
await store.appendEvent({type:'compaction_shed', runId:scope.runId, seq:2, iteration:1,reason:'threshold',messages});
const paths = ['disk.js', 'source-text.js', 'linked.js', 'compaction-archive.js'];
const fingerprint = async () => Object.fromEntries(await Promise.all(paths.map(async name => [name, createHash('sha256').update(await readFile(new URL('../../packages/sdk/dist/store/evidence/' + name, import.meta.url))).digest('hex')])));
const before = await fingerprint();
const results = [];
for (const phase of ['cold','warm']) {
 const source = createDiskRunTextEvidenceSource({scope,runDir,indexDir:join(runDir,'evidence-index')});
 let cursor; let calls=0; let bytes=0; const found=[]; const t=performance.now();
 do {
   const page = await source.search({query:'orchid-scan-cost-receipt',caseSensitive:false,cursor});
   if (page.incomplete || page.unavailable.length) throw new Error(JSON.stringify(page.unavailable));
   bytes+=page.scannedBytes; found.push(...page.matches.map(m=>({seq:m.seq,part:m.part})));
   cursor=page.nextCursor; calls++;
   if(calls>400)throw new Error('Did not finish in 400 calls');
 } while(cursor);
 const result = {root,phase,calls,bytes,found,elapsedMs:Math.round(performance.now()-t)};
 results.push(result); console.log(JSON.stringify(result));
}
const after = await fingerprint();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Built files changed during measurement');
await writeFile(join(root, 'result.json'), JSON.stringify({before,after,results}, null, 2) + '\n');
