// Exercise real CLI tools with faulty metadata from a captured SDK source.
// No paid inference; the provider's decisions are controlled and synchronous.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as sdk from '../../packages/sdk/dist/index.js';

const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const files = ['packages/cli/dist/integrations/sessions/evidence-page-validation.js','packages/cli/dist/integrations/sessions/conversation-search.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/sdk/dist/store/run/disk.js'];
const fingerprints = async () => Object.fromEntries(await Promise.all(files.map(async path=>[path,await hash(new URL('../../'+path,import.meta.url))])));

if(process.env.NAMZU_BOUNDARY_PRELOAD==='1') {
  const root=process.env.NAMZU_BOUNDARY_ROOT;
  assert.ok(root && process.env.NAMZU_HOME===join(root,'home'));
  const f=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'));
  const capture=sdk.RunDiskStore.prototype.captureTextEvidence;
  sdk.RunDiskStore.prototype.captureTextEvidence=async function(...args) {
    const source=await capture.apply(this,args); if(!source)return source;
    return {...source,
      search:async (...input)=>{
        const page=await source.search(...input);
        if(f.mode!=='search' || !page.matches.length)return page;
        appendFileSync(join(root,'faults.jsonl'),JSON.stringify({kind:'search',originalScope:page.scope,matches:page.matches.length})+'\n');
        return {...page,scope:{...page.scope,sessionId:f.foreignSession},matches:page.matches.map(m=>({...m,excerpt:f.foreignText}))};
      },
      read:async (...input)=>{
        const page=await source.read(...input);
        if(f.mode!=='read')return page;
        appendFileSync(join(root,'faults.jsonl'),JSON.stringify({kind:'read',originalScope:page.scope,seq:page.seq,part:page.part})+'\n');
        return {...page,scope:{...page.scope,sessionId:f.foreignSession},text:f.foreignText,totalBytes:Buffer.byteLength(f.foreignText),byteOffset:0,nextByteOffset:null};
      },
    };
  };
  let step=0;
  const parse=text=>JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  sdk.ProviderRegistry.create=()=>({provider:new sdk.MockLLMProvider({nextTurn:request=>{
    assert.ok(!JSON.stringify(request.messages).includes(f.foreignText),'Fault text must not enter model input.');
    step++;
    if(step===1)return {toolCalls:[{id:'observe',name:'read',args:{path:'note.txt'}}]};
    if(step===2)return {toolCalls:[{id:'search-own',name:'search_conversation',args:{query:'ORIGINAL'}}]};
    const tool=request.messages.filter(m=>m.role==='tool').at(-1);
    if(f.mode==='search') {
      assert.equal(step,3); const page=parse(String(tool.content));
      assert.equal(page.matches.length,0); assert.equal(page.incomplete,true); assert.ok(page.unavailableRuns>0);
      return {text:'Arşiv kaynağı kullanılamıyor; doğrulanmamış metin aktarılmadı.'};
    }
    if(step===3) {
      const page=parse(String(tool.content)); const match=page.matches.find(m=>m.toolName==='read');
      assert.ok(match);
      return {toolCalls:[{id:'read-own',name:'read_conversation',args:{runId:match.runId,seq:match.seq,part:match.part,byteOffset:match.byteOffset}}]};
    }
    assert.equal(step,4); assert.equal(tool.isError,true);
    return {text:'Arşiv okuması reddedildi; doğrulanmamış metin aktarılmadı.'};
  }})});
} else {
  const mode=process.argv[2]??'search'; assert.ok(['search','read'].includes(mode));
  const tui=process.argv.includes('--tui');
  const root=await mkdtemp(join(tmpdir(),'namzu-source-boundary-'));
  const home=join(root,'home'),cwd=join(root,'workspace'); await mkdir(home);await mkdir(cwd);
  process.env.NAMZU_HOME=home;
  const f={root,mode,tui,original:`ORIGINAL-${randomUUID()}`,foreignText:`FOREIGN-${randomUUID()}`,foreignSession:randomUUID()};
  await writeFile(join(cwd,'note.txt'),f.original+'\n');
  await writeFile(join(home,'preferences.json'),JSON.stringify({version:3,providers:[{id:'codex',model:'gpt-5.6-luna'}],subagents:{active:[]}}));
  await writeFile(join(home,'config.yaml'),'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: false\n');
  const storage=await import('../../packages/cli/dist/integrations/sessions/store.js');
  const sessions=await storage.openSessions(cwd); f.sessionId=await storage.resolveConversation(sessions,'boundary');
  await writeFile(join(root,'fixture.json'),JSON.stringify(f,null,2)+'\n');
  if(tui) console.log(JSON.stringify(f));
  else {
    const report={...f,liveTokens:0,controlledModel:true,buildBefore:await fingerprints()};
    try {
      const args=['--quiet','run-stream','--session','boundary','--trust','--cwd',cwd,'--provider','codex','--model','gpt-5.6-luna','--effort','low','--max-iterations','5','--token-budget','20000','Read note.txt once, then recover its recorded text through the conversation tools.'];
      const output=await promisify(execFile)(process.execPath,['--import',fileURLToPath(import.meta.url),fileURLToPath(new URL('../../packages/cli/dist/bin.js',import.meta.url)),...args],{cwd,env:{...process.env,NAMZU_BOUNDARY_ROOT:root,NAMZU_BOUNDARY_PRELOAD:'1'},timeout:30000,maxBuffer:2000000});
      report.output=output; report.events=[];
      const runs=join(home,'sessions',f.sessionId,'runs');
      for(const entry of await readdir(runs,{withFileTypes:true}))if(entry.isDirectory())report.events.push(...(await readFile(join(runs,entry.name,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse));
      report.faults=(await readFile(join(root,'faults.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(report.faults.some(x=>x.kind===mode));
      assert.ok(!JSON.stringify(report.events).includes(f.foreignText));
      assert.ok(!JSON.stringify(output).includes(f.foreignText));
      assert.ok(report.events.some(e=>e.type==='run_completed'&&e.stopReason==='end_turn'));
      assert.equal(await readFile(join(cwd,'note.txt'),'utf8'),f.original+'\n');
      report.passed=true;
    }catch(error){report.passed=false;report.error=String(error);report.failedOutput={stdout:error.stdout??'',stderr:error.stderr??''};process.exitCode=1;}
    finally {
      report.buildAfter=await fingerprints();report.buildStable=JSON.stringify(report.buildBefore)===JSON.stringify(report.buildAfter);
      if(!report.buildStable){report.passed=false;report.error='Build changed during probe';process.exitCode=1;}
      await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
      console.log(JSON.stringify({root,mode,passed:report.passed,error:report.error}));
    }
  }
}
