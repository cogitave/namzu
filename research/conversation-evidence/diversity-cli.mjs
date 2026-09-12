import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Synthetic recorded history, followed by an ordinary production CLI resume.
// --live observes and forwards the real provider; otherwise the response is a control.
const live = process.argv.includes('--live');
const baseline = process.argv.includes('--expect-redundant');
assert.ok(!(live && baseline), 'Do not spend model tokens reproducing known missing context.');
const root = await mkdtemp(join(tmpdir(), 'namzu-diversity-cli-'));
const home = join(root, 'home'); const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME = home;
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const { openSessions, startConversation, replaceConversation } = await import('../../packages/cli/dist/integrations/sessions/store.js');
const { createUserMessage } = await import(sdkURL);
const sessions = await openSessions(cwd); const sessionId = await startConversation(sessions);
await replaceConversation(sessions, sessionId, [createUserMessage('An earlier receipt and its correction were recorded.')]);
await writeFile(join(home, 'preferences.json'), JSON.stringify({version:3,providers:[{id:'codex',model:'gpt-5.6-luna'}],subagents:{active:[]}}));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
const manifest='The workspace receipt was manually removed.\n';
await writeFile(join(cwd,'manifest.txt'),manifest);
const runId=randomUUID(); const runDir=join(home,'sessions',sessionId,'runs',runId);
await mkdir(runDir,{recursive:true});
const original=`OLD-${randomUUID()}`; const corrected=`NEW-${randomUUID()}`;
const texts=[...Array(4).fill(`DELTA takip kodu: ${original}.`),`DELTA takip kodu ${corrected} olarak düzeltildi. Önceki kayıtta bir yazım hatası vardı; bu kayıt o düzeltmeyi bildiriyor.`];
const scope={tenantId:sessions.tenantId,projectId:sessions.projectId,sessionId,runId};
await writeFile(join(runDir,'run.json'),JSON.stringify({id:runId,status:'completed',metadata:{scope}}));
await writeFile(join(runDir,'transcript.jsonl'),[
  {type:'run_started',runId,seq:1},
  ...texts.map((result,i)=>({type:'tool_completed',runId,seq:i+2,toolName:'read',toolUseId:`observation-${i}`,result,isError:false})),
].map(JSON.stringify).join('\n')+'\n');
const report={root,live,baseline,provider:live?'codex':'scripted',model:live?'gpt-5.6-luna':'scripted',effort:'low',sessionId,sourceRunId:runId,original,corrected,texts};
const built=['packages/cli/dist/integrations/sessions/conversation-search.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/tui/agent.js','packages/sdk/dist/store/evidence/disk.js','packages/sdk/dist/run/evidence-recall.js'];
async function hashes(paths){const result={};for(const path of paths){try{result[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;result[path]=null;}}return result;}
try{
  const preload=join(root,'observe-requests.mjs');
  await writeFile(preload,`import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const original=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=original(...args);const stream=created.provider.chatStream.bind(created.provider);
created.provider.chatStream=async function*(params){
const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
const context=contexts.map(m=>m.content).join('\\n');
await appendFile(${JSON.stringify(join(root,'requests.jsonl'))},JSON.stringify({context,ordinaryHasCodes:params.messages.filter(m=>!contexts.includes(m)).some(m=>String(m.content).includes(${JSON.stringify(original)})||String(m.content).includes(${JSON.stringify(corrected)}))})+'\\n');
if(${JSON.stringify(live)})yield* stream(params);else yield* new MockLLMProvider({turns:[{text:context}]}).chatStream(params);
};return created;};`);
  const prompt='DELTA kaydındaki ilk ve son takip kodunu söyler misin?';
  const args=['--quiet','--format','json','run','--trust','--cwd',cwd,'--resume',sessionId,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','4','--token-budget','25000',prompt];
  report.command=args;report.buildBefore=await hashes(built);
  const result=await promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,env:{...process.env,NAMZU_HOME:home},timeout:120000,maxBuffer:2000000});
  report.result=JSON.parse(result.stdout);
  report.requests=(await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const context=report.requests[0].context;
  report.passages=context.split('\n').filter(line=>line.startsWith('{"runId":')).map(JSON.parse);
  report.contextChars=context.length;
  assert.ok(report.requests.every(r=>!r.ordinaryHasCodes));
  assert.ok(context.includes(original));
  assert.equal(context.includes(corrected),!baseline);
  assert.equal(report.passages.length,baseline?4:2);
  if(!baseline){
    const old=report.passages.find(p=>p.excerpt===texts[0]);
    assert.equal(old.otherOccurrences.length,3);assert.equal(old.omittedOccurrences,0);
    assert.deepEqual([old.seq,...old.otherOccurrences.map(p=>p.seq)].sort(),[2,3,4,5]);
    assert.ok(report.result.text.includes(original)&&report.result.text.includes(corrected));
  }
  assert.equal(report.requests.length,1,'Model needed another request; inspect instead of claiming automatic recall worked.');
  const runs=join(home,'sessions',sessionId,'runs');
  const invoked=(await readdir(runs,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!==runId);
  assert.equal(invoked.length,1);
  const events=(await readFile(join(runs,invoked[0].name,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  report.calls=events.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
  report.stopReason=events.findLast(e=>e.type==='run_completed')?.stopReason;
  assert.equal(report.calls.length,0);assert.equal(report.stopReason,'end_turn');
  assert.equal(await readFile(join(cwd,'manifest.txt'),'utf8'),manifest);
  report.passed=true;
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{
  report.buildAfter=await hashes(built);report.buildStable=JSON.stringify(report.buildAfter)===JSON.stringify(report.buildBefore);
  if(!report.buildStable){report.passed=false;report.error='Built modules changed during the experiment.';process.exitCode=1;}
  report.fingerprints=await hashes(['packages/sdk/src/run/evidence-recall.ts','research/conversation-evidence/diversity-cli.mjs']);
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({root,live,baseline,passed:report.passed,passages:report.passages?.length,contextChars:report.contextChars,usage:report.result?.usage,error:report.error}));
}
