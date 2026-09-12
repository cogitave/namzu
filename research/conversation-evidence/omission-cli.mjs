import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Production CLI/kernel/store/tools with scripted model decisions. Inject only
// an external artifact fault after its original read, before retained recall.
const damage=process.argv.find(v=>v.startsWith('--damage='))?.slice(9)??'changed';
assert.ok(['healthy','changed','missing'].includes(damage));
const baseline=process.argv.includes('--expect-lost');
const root=await mkdtemp(join(tmpdir(),'namzu-omission-cli-'));
const home=join(root,'home');const cwd=join(root,'workspace');await mkdir(home);await mkdir(cwd);
process.env.NAMZU_HOME=home;
const sdkURL=new URL('../../packages/sdk/dist/index.js',import.meta.url);
const {openSessions,startConversation,replaceConversation}=await import('../../packages/cli/dist/integrations/sessions/store.js');
const {createUserMessage}=await import(sdkURL);
const sessions=await openSessions(cwd);const sessionId=await startConversation(sessions);
await replaceConversation(sessions,sessionId,[createUserMessage('Inspect two observations, then search their retained originals.')]);
await writeFile(join(home,'preferences.json'),JSON.stringify({version:3,providers:[{id:'codex',model:'gpt-5.6-luna'}],subagents:{active:[]}}));
await writeFile(join(home,'config.yaml'),'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n');
const healthy=Array.from({length:140},(_,i)=>i>=30&&i<130&&(i-30)%10===0?`DELTA original record CODE-${i}`:`Packing information ${i}: ${'unchanged details '.repeat(40)}`).join('\n');
const broken=Array.from({length:100},(_,i)=>`Independent inspection ${i}: ${'recorded information '.repeat(40)}`).join('\n');
await writeFile(join(cwd,'manifest.txt'),healthy);await writeFile(join(cwd,'broken.txt'),broken);
const report={root,damage,baseline,provider:'scripted',modelCalls:0,sessionId};
const files=['packages/sdk/dist/store/run/disk.js','packages/sdk/dist/store/evidence/linked.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/integrations/sessions/conversation-search.js'];
async function hashes(){const result={};for(const path of files)result[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');return result;}
try{
 const preload=join(root,'fault-and-model.mjs');
 await writeFile(preload,`import {ProviderRegistry,MockLLMProvider,RunDiskStore} from ${JSON.stringify(sdkURL.href)};
import {createHash} from 'node:crypto';import {readFile,writeFile,appendFile,unlink} from 'node:fs/promises';import {join} from 'node:path';
const capture=RunDiskStore.prototype.captureTextEvidence;let applied=false;
RunDiskStore.prototype.captureTextEvidence=async function(...args){
 const scope=args[0];
 if(scope.sessionId===${JSON.stringify(sessionId)}&&!applied){
  const path=join(${JSON.stringify(home)},'sessions',scope.sessionId,'runs',scope.runId,'tool-output',createHash('sha256').update('broken-output').digest('hex')+'.txt');
  try{const original=await readFile(path);applied=true;
   if(${JSON.stringify(damage)}==='changed')await writeFile(path,'Externally changed retained artifact.');
   if(${JSON.stringify(damage)}==='missing')await unlink(path);
   await writeFile(${JSON.stringify(join(root,'fault.json'))},JSON.stringify({damage:${JSON.stringify(damage)},originalBytes:original.length,path}));
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
 const source=await capture.apply(this,args);if(!source)return source;
 return {...source,search:async(...input)=>{const page=await source.search(...input);
 await appendFile(${JSON.stringify(join(root,'source-pages.jsonl'))},JSON.stringify({incomplete:page.incomplete,unavailable:page.unavailable.length,matches:page.matches.length,hasNext:!!page.nextCursor,scannedBytes:page.scannedBytes})+'\\n');return page;}};
};
let request=0;const factory=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=factory(...args);
created.provider.chatStream=async function*(params){
 const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const context=contexts.map(m=>m.content).join('\\n');
 const metadata=JSON.parse(context.split('\\n').find(s=>s.startsWith('{"incomplete":'))||'{}');
 await appendFile(${JSON.stringify(join(root,'requests.jsonl'))},JSON.stringify({request,metadata})+'\\n');
 let turn;
 if(request===0)turn={toolCalls:[{id:'healthy-output',name:'read',args:{path:'manifest.txt',limit:1000}},{id:'broken-output',name:'read',args:{path:'broken.txt',limit:1000}}]};
 else if(request===1){const hint=metadata.continuations?.[0];if(!hint)throw new Error('Missing live continuation');turn={toolCalls:[{id:'continue-1',name:hint.toolName,args:hint.input}]};}
 else{const last=params.messages.filter(m=>m.role==='tool').at(-1);const text=last.content;const page=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  await appendFile(${JSON.stringify(join(root,'continued-pages.jsonl'))},JSON.stringify(page)+'\\n');
  turn=page.nextCursor?{toolCalls:[{id:'continue-'+request,name:'search_conversation',args:{cursor:page.nextCursor}}]}:{text:JSON.stringify({incomplete:page.incomplete,unavailableRuns:page.unavailableRuns,hasNext:!!page.nextCursor,matches:page.matches.length})};
 }
 request++;yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
};return created;};`);
 const args=['--quiet','--format','json','run','--trust','--cwd',cwd,'--resume',sessionId,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','8','--token-budget','25000','DELTA'];
 report.command=args;report.buildBefore=await hashes();
 const result=await promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,env:{...process.env,NAMZU_HOME:home},timeout:60000,maxBuffer:2000000});
 report.result=JSON.parse(result.stdout);report.final=JSON.parse(report.result.text);
 for(const [key,file] of [['sourcePages','source-pages.jsonl'],['requests','requests.jsonl'],['continuedPages','continued-pages.jsonl']])report[key]=(await readFile(join(root,file),'utf8')).trim().split('\n').map(JSON.parse);
 report.fault=JSON.parse(await readFile(join(root,'fault.json'),'utf8'));
 const runs=join(home,'sessions',sessionId,'runs');const ids=(await readdir(runs,{withFileTypes:true})).filter(e=>e.isDirectory());assert.equal(ids.length,1);
 const events=(await readFile(join(runs,ids[0].name,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 report.calls=events.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
 report.stopReason=events.findLast(e=>e.type==='run_completed')?.stopReason;
 assert.equal(report.calls.filter(c=>c.name==='read').length,2);
 assert.ok(report.calls.every(c=>['read','search_conversation'].includes(c.name)));
 assert.ok(report.calls.some(c=>c.name==='search_conversation'));
 assert.equal(report.sourcePages.some(p=>p.unavailable>0),damage!=='healthy');
 assert.equal(report.final.hasNext,false);assert.equal(report.final.unavailableRuns,0);
 assert.equal(report.final.incomplete,!baseline&&damage!=='healthy');
 assert.equal(report.stopReason,'end_turn');assert.equal(report.result.usage.totalTokens,0);
 assert.equal(await readFile(join(cwd,'manifest.txt'),'utf8'),healthy);assert.equal(await readFile(join(cwd,'broken.txt'),'utf8'),broken);
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error);process.exitCode=1;}
finally{
 report.buildAfter=await hashes();report.buildStable=JSON.stringify(report.buildBefore)===JSON.stringify(report.buildAfter);
 if(!report.buildStable){report.passed=false;report.error='Built modules changed during the trial';process.exitCode=1;}
 await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({root,damage,baseline,passed:report.passed,final:report.final,calls:report.calls,error:report.error}));
}
