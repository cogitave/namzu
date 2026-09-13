// Pack internal index pages into the existing public search allowance.
// Setup uses a real CLI read with scripted inference; --live opts into Luna low.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const baseline = process.argv.includes('--baseline');
const live = process.argv.includes('--live');
assert.ok(!(baseline && live));
const root = await mkdtemp(join(tmpdir(), 'namzu-index-pages-'));
const home = join(root, 'home'), cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
await writeFile(join(home, 'preferences.json'), JSON.stringify({version:3, providers:[{id:'codex',model:'gpt-5.6-luna'}], subagents:{active:[]}}));
// Isolate explicit retrieval; default automatic recall is tested separately.
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: false\n');
const sdk = await import('../../packages/sdk/dist/index.js');
const storage = await import('../../packages/cli/dist/integrations/sessions/store.js');
const evidence = await import('../../packages/cli/dist/integrations/sessions/conversation-search.js');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const builtFiles = ['packages/cli/dist/integrations/sessions/conversation-search.js','packages/cli/dist/integrations/sessions/evidence-page-validation.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/tui/agent.js','packages/sdk/dist/store/evidence/disk.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(builtFiles.map(async path => [path,await hash(new URL('../../'+path,import.meta.url))])));
const report = {root,baseline,live,recallEvidence:false,passes:[],buildBefore:await fingerprints()};
let sessions, sessionId;
try {
  const seed = await exec(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'--seed',cwd],{cwd,timeout:30000,maxBuffer:1000000});
  report.seed = JSON.parse(seed.stdout);
  sessions = await storage.openSessions(cwd); sessionId = sdk.asSessionId(report.seed.sessionId);
  const runs = join(home,'sessions',sessionId,'runs');
  const runId = sdk.asRunId('00000000-0000-4000-8000-000000000001');
  assert.ok(runId < report.seed.runId);
  const store = new sdk.RunDiskStore({baseDir:runs}); await store.initRun(runId);
  await store.appendEvent({type:'run_started',runId,seq:1});
  const messages = [sdk.createUserMessage('Inspect the DELTA receipt.'),sdk.createAssistantMessage('DELTA inspection requested; no original identifiers in this announcement.'),...Array.from({length:134},(_,i)=>sdk.createAssistantMessage(`Unrelated check ${i}.`))];
  await store.appendEvent({type:'compaction_shed',runId,seq:2,reason:'manual',messages});
  await store.appendEvent({type:'run_completed',runId,seq:3});
  await writeFile(join(runs,runId,'run.json'),JSON.stringify({id:runId,status:'completed',metadata:{scope:{tenantId:sessions.tenantId,projectId:sessions.projectId,sessionId,runId}}}));
  report.indexedCompaction = {runId,messages:messages.length,constructedArchive:true};
  const sourceDir = join(runs,report.seed.runId);
  const sourceEvents = (await readFile(join(sourceDir,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const sourceOutput = sourceEvents.find(e=>e.type==='tool_completed'&&e.toolName==='read');
  assert.ok(sourceOutput.outputSpillPath && sourceOutput.outputSpillIntegrity);
  const retained = [join(sourceDir,'transcript.jsonl'),join(sourceDir,'run.json'),sourceOutput.outputSpillPath,sourceOutput.outputSpillPath+'.manifest.json',join(runs,runId,'transcript.jsonl'),join(runs,runId,'run.json'),join(cwd,'manifest.txt')];
  const sourceHashes = async () => Object.fromEntries(await Promise.all(retained.map(async path=>[path,await hash(path)])));
  report.sourcesBefore = await sourceHashes();
  for(const temperature of ['cold','warm']) {
    const pass = {temperature,pages:[]}; let cursor, found; const identities = new Set();
    do {
      const page = await evidence.searchConversation(sessions,sessionId,cursor?{cursor}:{query:'DELTA',limit:10});
      assert.ok(page.matches.length<=10 && page.scannedBytes<=8*1024*1024 && Buffer.byteLength(JSON.stringify(page.matches))<=12000);
      assert.equal(page.unavailableRuns,0); pass.pages.push(page);
      for(const m of page.matches) {const key=JSON.stringify([m.runId,m.seq,m.part,m.byteOffset]);assert.ok(!identities.has(key));identities.add(key);}
      found = page.matches.find(m=>m.runId===report.seed.runId && m.seq===report.seed.seq);
      cursor = page.nextCursor; assert.ok(pass.pages.length<=8);
    } while(!found && cursor);
    report.passes.push(pass);
    assert.ok(found); assert.equal(pass.pages.length,baseline?3:1);
    const exact = await evidence.readConversationEvidence(sessions,sessionId,found);
    assert.ok(exact.text.includes(report.seed.tracking) && exact.text.includes(report.seed.destination));
    pass.exact = {runId:exact.runId,seq:exact.seq,part:exact.part,retained:exact.retained,containsOriginals:true};
  }
  await evidence.releaseConversationEvidence(sessions,sessionId);
  if(live) {
    const args=['--quiet','--format','json','run','--trust','--cwd',cwd,'--resume',sessionId,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','4','--token-budget','30000','DELTA kaydını ilk okuduğumuzdaki takip kodu ve hedef deposu neydi?'];
    report.command=args;
    const output=await exec(process.execPath,[fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,timeout:120000,maxBuffer:2000000}).catch(error=>{report.commandError=String(error);return {stdout:error.stdout??'',stderr:error.stderr??''};});
    report.stdout=output.stdout; report.stderr=output.stderr;
    const events=[];
    for(const entry of await readdir(runs,{withFileTypes:true})) {
      if(!entry.isDirectory() || entry.name===report.seed.runId || entry.name===runId) continue;
      events.push(...(await readFile(join(runs,entry.name,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse));
    }
    report.calls=events.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
    report.outputs=events.filter(e=>e.type==='tool_completed').map(e=>({name:e.toolName,isError:e.isError,result:e.result}));
    report.result=JSON.parse(output.stdout);
    assert.equal(report.commandError,undefined);
    assert.ok(report.result.text.includes(report.seed.tracking) && report.result.text.includes(report.seed.destination));
    assert.ok(report.calls.some(c=>c.name==='search_conversation'));
    assert.ok(report.calls.every(c=>['search_conversation','read_conversation','search_tools'].includes(c.name)));
    assert.ok(report.outputs.every(e=>!e.isError));
  }
  report.sourcesAfter=await sourceHashes();
  assert.deepEqual(report.sourcesAfter,report.sourcesBefore);
  report.passed=true;
} catch(error) {report.passed=false;report.error=String(error);process.exitCode=1;}
finally {
  if(sessions && sessionId) await evidence.releaseConversationEvidence(sessions,sessionId);
  report.buildAfter=await fingerprints(); report.buildStable=JSON.stringify(report.buildBefore)===JSON.stringify(report.buildAfter);
  if(!report.buildStable){report.passed=false;report.error='Build changed during measurement';process.exitCode=1;}
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({root,baseline,live,passed:report.passed,pages:report.passes.map(p=>p.pages.length),usage:report.result?.usage,error:report.error}));
}
