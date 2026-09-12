import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const live=process.argv.includes('--live');
const expectMiss=process.argv.includes('--expect-miss');
assert.ok(!(live&&expectMiss),'The baseline is a scripted control.');
const root=await mkdtemp(join(tmpdir(),'namzu-refined-discovery-cli-'));
const home=join(root,'home'); const cwd=join(root,'workspace');
await mkdir(home); await mkdir(cwd); process.env.NAMZU_HOME=home;
const sdkURL=new URL('../../packages/sdk/dist/index.js',import.meta.url);
const {openSessions,startConversation,replaceConversation}=await import('../../packages/cli/dist/integrations/sessions/store.js');
const {createUserMessage,createEvidenceRecallStep,createDiskRunTextEvidenceSource}=await import(sdkURL);
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
const retained=applyToolOutputBudget({toolName:'read',toolUseId:'original',output:`${'Packing information. '.repeat(4000)}\nDELTA original observation: tracking code ${tracking}; destination ${destination}.\n${'Packing information. '.repeat(4000)}`,maxChars:1000,spillDir:join(sourceDir,'tool-output')});
assert.ok(!retained.output.includes(tracking)&&!retained.output.includes(destination));
const events=[{type:'run_started',runId:sourceRunId,seq:1},
 ...Array.from({length:12},(_,i)=>({type:'tool_completed',runId:sourceRunId,seq:i+2,toolName:'read',toolUseId:`note-${i}`,result:`An unrelated item is in queue ${i}.`,isError:false})),
 {type:'tool_completed',runId:sourceRunId,seq:14,toolName:'read',toolUseId:'original',result:retained.output,isError:false,outputTruncated:true,outputSpillIntegrity:retained.spillIntegrity}];
await writeFile(join(sourceDir,'transcript.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
const report={root,live,expectMiss,provider:live?'codex':'scripted',model:live?'gpt-5.6-luna':'scripted',effort:'low',sourceRunId,sessionId,tracking,destination};
const files=['packages/sdk/dist/run/evidence-recall.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/integrations/sessions/conversation-search.js','packages/sdk/dist/store/evidence/source-text.js','packages/sdk/dist/store/evidence/passages.js','packages/sdk/dist/utils/evidence-tokens.js'];
async function hashes(paths){const result={};for(const path of paths)result[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');return result;}
try{
 report.buildBefore=await hashes(files);
 const query='What were the tracking code and destination in the original DELTA observation?';
 let terms;
 await createEvidenceRecallStep({scope:{tenantId:sessions.tenantId,projectId:sessions.projectId,sessionId},retrieve:async(request)=>{terms=request.terms;return {candidates:[],scannedBytes:0,incomplete:false};}})({runId:randomUUID(),messages:[createUserMessage(query)],prepared:{},steps:[],stepNumber:1});
 report.terms=terms;report.discovery={};
 for(const matchMode of ['literal','token']){
  const source=createDiskRunTextEvidenceSource({scope,runDir:sourceDir,indexDir:join(root,'reference-index-'+matchMode)});
  let cursor;const pages=[];
  for(let i=0;i<4;i++){const page=await source.search({terms,matchMode,caseSensitive:false,limit:3,cursor});pages.push({matches:page.matches.length,hasCodes:page.matches.some(m=>m.excerpt.includes(tracking)&&m.excerpt.includes(destination)),incomplete:page.incomplete,scannedBytes:page.scannedBytes,hasNext:!!page.nextCursor});cursor=page.nextCursor??undefined;if(!cursor)break;}
  report.discovery[matchMode]=pages;
 }
 assert.equal(report.discovery.literal.some(p=>p.hasCodes),false);assert.equal(report.discovery.token.some(p=>p.hasCodes),false);
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
const turn={text:context};
yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
};return created;};`);
 const prompt=query;
 const args=['--quiet','--format','json','run','--trust','--cwd',cwd,'--resume',sessionId,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','4','--token-budget','20000',prompt];
 report.command=args;
 const result=await promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,env:{...process.env,NAMZU_HOME:home},timeout:90000,maxBuffer:2000000});
 report.result=JSON.parse(result.stdout);
 report.requests=(await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const first=report.requests[0]; assert.equal(first.ordinaryHasCodes,false);
 assert.equal(first.context.includes(tracking)&&first.context.includes(destination),!expectMiss);
 assert.ok(first.metadata.incomplete);
 assert.ok(first.metadata.continuations?.length);
 const invoked=(await readdir(runs,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!==sourceRunId);
 assert.equal(invoked.length,1);
 const recorded=(await readFile(join(runs,invoked[0].name,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 report.calls=recorded.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
 report.stopReason=recorded.findLast(e=>e.type==='run_completed')?.stopReason;
 assert.equal(report.result.text.includes(tracking)&&report.result.text.includes(destination),!expectMiss);
 assert.equal(report.calls.length,0);
 assert.equal(report.stopReason,'end_turn');assert.equal(await readFile(join(cwd,'manifest.txt'),'utf8'),manifest);
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{
 report.buildAfter=await hashes(files);report.buildStable=JSON.stringify(report.buildBefore)===JSON.stringify(report.buildAfter);
 if(!report.buildStable){report.passed=false;report.error='Build changed during measurement';process.exitCode=1;}
 await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({root,live,passed:report.passed,calls:report.calls,usage:report.result?.usage,error:report.error}));
}
