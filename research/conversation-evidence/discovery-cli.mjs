import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, opendir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const live = process.argv.includes('--live');
const root = await mkdtemp(join(tmpdir(), 'namzu-discovery-cli-'));
const home = join(root, 'home'); const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { createUserMessage } = await import(sdkURL);
const { applyToolOutputBudget } = await import('../../packages/sdk/dist/runtime/query/tool-output-budget.js');
const sessions = await openSessions(cwd); const sessionId = await startConversation(sessions);
await replaceConversation(sessions, sessionId, [createUserMessage('An earlier receipt inspection is recorded in this conversation.')]);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
await writeFile(join(cwd, 'manifest.txt'), 'Manually replaced. Original receipt removed.\n');
const runs = join(home, 'sessions', sessionId, 'runs'); await mkdir(runs, { recursive: true });
for (let i = 0; i < 120; i++) await mkdir(join(runs, randomUUID()));
async function directoryIds() { const ids=[]; const dir=await opendir(runs); for await (const e of dir) if(e.isDirectory())ids.push(e.name); return ids; }
const ids = await directoryIds(); const target = ids.at(-1);
const tracking=`TRACK-${randomUUID()}`; const destination=`DEPOT-${randomUUID()}`;
const scope={tenantId:sessions.tenantId,projectId:sessions.projectId,sessionId,runId:target};
for (const id of ids) {
  const event={type:'message_completed',runId:id,seq:2,content:'Unrelated earlier observation.'};
  if(id===target) {
    const retained=applyToolOutputBudget({toolUseId:'observe-once',toolName:'read',output:`${'Earlier packaging record. '.repeat(4000)}\nDELTA tracking ${tracking}. Destination ${destination}.\n${'Remaining packaging record. '.repeat(4000)}`,maxChars:1000,spillDir:join(runs,id,'tool-output')});
    assert.ok(!retained.output.includes(tracking) && !retained.output.includes(destination));
    Object.assign(event,{type:'tool_completed',toolName:'read',toolUseId:'observe-once',result:retained.output,isError:false,outputTruncated:true,outputSpillIntegrity:retained.spillIntegrity}); delete event.content;
    await writeFile(join(runs,id,'run.json'),JSON.stringify({id,status:'completed',metadata:{scope}}));
  }
  await writeFile(join(runs,id,'transcript.jsonl'),JSON.stringify({type:'run_started',runId:id,seq:1})+'\n'+JSON.stringify(event)+'\n');
}
const report={root,live,provider:live?'codex':'scripted',model:live?'gpt-5.6-luna':'scripted',effort:'low',sessionId,target,tracking,destination,historicalRunCount:ids.length,targetInitialDirectoryIndex:ids.indexOf(target)};
const files=['packages/cli/dist/integrations/sessions/run-discovery.js','packages/cli/dist/integrations/sessions/conversation-search.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/tui/agent.js','packages/sdk/dist/store/evidence/disk.js','packages/sdk/dist/run/evidence-recall.js'];
async function hashes(paths) { const result={}; for(const path of paths)result[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');return result; }
try {
  const preload=join(root,'observe-requests.mjs');
  await writeFile(preload,`import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const original=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=original(...args);const stream=created.provider.chatStream.bind(created.provider);
 created.provider.chatStream=async function*(params){
 const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const context=contexts.map(m=>m.content).join('\\n');
 await appendFile(${JSON.stringify(join(root,'requests.jsonl'))},JSON.stringify({context,ordinaryHasOriginals:params.messages.filter(m=>!contexts.includes(m)).some(m=>String(m.content).includes(${JSON.stringify(tracking)})||String(m.content).includes(${JSON.stringify(destination)}))})+'\\n');
 if(${JSON.stringify(live)})yield* stream(params);else yield* new MockLLMProvider({turns:[{text:context}]}).chatStream(params);
 };return created;};`);
  const prompt='Önceki DELTA kaydının takip kodunu ve hedef deposunu aynen söyle.';
  const args=['--quiet','--format','json','run','--trust','--cwd',cwd,'--resume',sessionId,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','4','--token-budget','25000',prompt];
  report.command=args;report.buildBefore=await hashes(files);
  const result=await promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,env:{...process.env,NAMZU_HOME:home},timeout:120000,maxBuffer:2000000});
  report.result=JSON.parse(result.stdout);
  report.requests=(await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const current=(await directoryIds()).filter(id=>!ids.includes(id));assert.equal(current.length,1);report.runId=current[0];
  const events=(await readFile(join(runs,current[0],'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  report.calls=events.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
  report.stopReason=events.findLast(e=>e.type==='run_completed')?.stopReason;
  report.targetDirectoryIndexDuringInvocation=(await directoryIds()).indexOf(target);
  assert.ok(report.targetDirectoryIndexDuringInvocation>=100,'Fixture no longer places the target beyond the first batch.');
  assert.ok(report.result.text.includes(tracking)&&report.result.text.includes(destination));
  assert.ok(report.requests[0].context.includes(tracking)&&report.requests[0].context.includes(destination));
  assert.ok(report.requests.every(r=>!r.ordinaryHasOriginals));
  assert.equal(report.calls.length,0);assert.equal(report.stopReason,'end_turn');
  assert.equal(await readFile(join(cwd,'manifest.txt'),'utf8'),'Manually replaced. Original receipt removed.\n');
  report.passed=true;
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{
 report.buildAfter=await hashes(files);report.buildStable=JSON.stringify(report.buildAfter)===JSON.stringify(report.buildBefore);
 if(!report.buildStable){report.passed=false;report.error='Built modules changed during the experiment.';process.exitCode=1;}
 report.fingerprints=await hashes(['packages/cli/src/integrations/sessions/run-discovery.ts','packages/cli/src/integrations/sessions/conversation-search.ts','packages/cli/src/integrations/sessions/evidence-recall.ts','packages/cli/src/tui/agent.ts','research/conversation-evidence/discovery-cli.mjs']);
 await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({root,live,passed:report.passed,targetIndex:report.targetDirectoryIndexDuringInvocation,calls:report.calls,usage:report.result?.usage,error:report.error}));
}
