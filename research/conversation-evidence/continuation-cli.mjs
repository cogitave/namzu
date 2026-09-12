import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const live=process.argv.includes('--live'); const baseline=process.argv.includes('--expect-no-hint');
assert.ok(!(live&&baseline));
const root=await mkdtemp(join(tmpdir(),'namzu-continuation-cli-'));
const home=join(root,'home'); const cwd=join(root,'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME=home;
const sdkURL=new URL('../../packages/sdk/dist/index.js',import.meta.url);
const {openSessions,startConversation,replaceConversation}=await import('../../packages/cli/dist/integrations/sessions/store.js');
const {createUserMessage}=await import(sdkURL);
const {applyToolOutputBudget}=await import('../../packages/sdk/dist/runtime/query/tool-output-budget.js');
const sessions=await openSessions(cwd); const sessionId=await startConversation(sessions);
await replaceConversation(sessions,sessionId,[createUserMessage('An earlier receipt inspection is recorded.')]);
await writeFile(join(home,'preferences.json'),JSON.stringify({version:3,providers:[{id:'codex',model:'gpt-5.6-luna'}],subagents:{active:[]}}));
await writeFile(join(home,'config.yaml'),'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
const manifest='Original receipt manually removed.\n'; await writeFile(join(cwd,'manifest.txt'),manifest);
const sourceRunId=randomUUID(); const runs=join(home,'sessions',sessionId,'runs'); const sourceDir=join(runs,sourceRunId);
await mkdir(sourceDir,{recursive:true});
const tracking=`TRACK-${randomUUID()}`; const destination=`DEPOT-${randomUUID()}`;
const scope={tenantId:sessions.tenantId,projectId:sessions.projectId,sessionId,runId:sourceRunId};
await writeFile(join(sourceDir,'run.json'),JSON.stringify({id:sourceRunId,status:'completed',metadata:{scope}}));
const retained=applyToolOutputBudget({toolName:'read',toolUseId:'original',output:`${'Packaging detail. '.repeat(4000)}\nDELTA takip kodu ${tracking}; hedef depo ${destination}.\n${'Packaging detail. '.repeat(4000)}`,maxChars:1000,spillDir:join(sourceDir,'tool-output')});
assert.ok(!retained.output.includes(tracking)&&!retained.output.includes(destination));
const events=[{type:'run_started',runId:sourceRunId,seq:1},
 ...Array.from({length:9},(_,i)=>({type:'tool_completed',runId:sourceRunId,seq:i+2,toolName:'read',toolUseId:`note-${i}`,result:'DELTA kayıt incelemesi sırada.',isError:false})),
 {type:'tool_completed',runId:sourceRunId,seq:11,toolName:'read',toolUseId:'original',result:retained.output,isError:false,outputTruncated:true,outputSpillIntegrity:retained.spillIntegrity}];
await writeFile(join(sourceDir,'transcript.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
const report={root,live,baseline,provider:live?'codex':'scripted',model:live?'gpt-5.6-luna':'scripted',effort:'low',sourceRunId,sessionId,tracking,destination};
const files=['packages/sdk/dist/run/evidence-recall.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/integrations/sessions/conversation-search.js','packages/cli/dist/tui/agent.js'];
async function hashes(paths){const result={};for(const path of paths)result[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');return result;}
try{
 const preload=join(root,'observe.mjs');
 await writeFile(preload,`import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const original=ProviderRegistry.create.bind(ProviderRegistry);let request=0;
ProviderRegistry.create=(...args)=>{const created=original(...args);const stream=created.provider.chatStream.bind(created.provider);
created.provider.chatStream=async function*(params){
const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
const context=contexts.map(m=>m.content).join('\\n');
const metadata=JSON.parse(context.split('\\n').find(s=>s.startsWith('{"incomplete":'))||'{}');
await appendFile(${JSON.stringify(join(root,'requests.jsonl'))},JSON.stringify({context,metadata,ordinaryHasCodes:params.messages.filter(m=>!contexts.includes(m)).some(m=>String(m.content).includes(${JSON.stringify(tracking)})||String(m.content).includes(${JSON.stringify(destination)}))})+'\\n');
const step=request++;
if(${JSON.stringify(live)}){yield* stream(params);return;}
let turn={text:context};
if(!${JSON.stringify(baseline)}){
 if(step===0){const hint=metadata.continuations?.[0];if(!hint)throw new Error('No continuation supplied');turn={toolCalls:[{id:'continue-archive',name:hint.toolName,args:hint.input}]};}
 else turn={text:params.messages.filter(m=>m.role==='tool').map(m=>m.content).join('\\n')};
}
yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
};return created;};`);
 const prompt='DELTA kaydının takip kodunu ve hedef deposunu söyler misin?';
 const args=['--quiet','--format','json','run','--trust','--cwd',cwd,'--resume',sessionId,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','6','--token-budget','30000',prompt];
 report.command=args; report.buildBefore=await hashes(files);
 const result=await promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,env:{...process.env,NAMZU_HOME:home},timeout:120000,maxBuffer:2000000});
 report.result=JSON.parse(result.stdout);
 report.requests=(await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const first=report.requests[0]; assert.equal(first.ordinaryHasCodes,false);
 assert.ok(!first.context.includes(tracking)&&!first.context.includes(destination));
 assert.equal(first.metadata.incomplete,true);
 const invoked=(await readdir(runs,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!==sourceRunId);
 assert.equal(invoked.length,1);
 const recorded=(await readFile(join(runs,invoked[0].name,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 report.calls=recorded.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
 report.stopReason=recorded.findLast(e=>e.type==='run_completed')?.stopReason;
 if(baseline){assert.equal(first.metadata.continuations,undefined);assert.equal(report.calls.length,0);}
 else{
  assert.ok(report.result.text.includes(tracking)&&report.result.text.includes(destination));
  const cursor=first.metadata.continuations[0].input.cursor;
  assert.ok(report.calls.some(c=>c.name==='search_conversation'&&c.input.cursor===cursor&&!c.input.query));
  assert.ok(report.calls.every(c=>['search_tools','search_conversation'].includes(c.name)));
 }
 assert.equal(report.stopReason,'end_turn');assert.equal(await readFile(join(cwd,'manifest.txt'),'utf8'),manifest);
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{
 report.buildAfter=await hashes(files);report.buildStable=JSON.stringify(report.buildBefore)===JSON.stringify(report.buildAfter);
 if(!report.buildStable){report.passed=false;report.error='Build changed during measurement';process.exitCode=1;}
 await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({root,live,baseline,passed:report.passed,calls:report.calls,usage:report.result?.usage,error:report.error}));
}
