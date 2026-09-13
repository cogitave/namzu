import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const driver = fileURLToPath(new URL('./tool-evidence-cli.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
// This mode seeds and wakes actual CLI work without running recovery.
const seeded = JSON.parse((await exec(process.execPath, [driver], { timeout: 30000 })).stdout);
const root = seeded.root;
const seed = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
const home = join(root, 'home'), cwd = join(root, 'workspace');
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\ncompaction:\n  recallEvidence: true\n');
const marker = join(root, 'recall-entered.json');
const providerMarker = join(root, 'unexpected-provider-call');
const preload = join(root, 'cancel-recall.mjs');
await writeFile(preload, `
import { writeFileSync } from 'node:fs';
import { DiskResidentAgenda, ProviderRegistry, MockLLMProvider } from ${JSON.stringify(new URL('../../packages/sdk/dist/index.js', import.meta.url).href)};
const history = DiskResidentAgenda.prototype.history;
DiskResidentAgenda.prototype.history = function(...args) {
 const source = history.apply(this,args);
 return { ...source, search: async (_input, signal) => {
  signal?.throwIfAborted();
  writeFileSync(${JSON.stringify(marker)},JSON.stringify({entered:true}));
  await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  throw new Error('A cancelled history read cannot succeed.');
 }};
};
ProviderRegistry.create = () => {
 const provider = new MockLLMProvider({turns:[]});
 provider.chatStream = async function* () { writeFileSync(${JSON.stringify(providerMarker)},'called'); throw new Error('Cancelled preparation must not call the model.'); };
 return { provider };
};
`);
const env = { ...process.env, NAMZU_HOME: home };
const flags = ['--quiet','--format','json','resident','run','--cwd',cwd,'--trust','--max-steps','1','--provider','codex','--model','gpt-5.6-luna','--effort','low'];
const report = { root, scenario: 'SIGTERM while automatic resident history preparation is pending; scripted delayed source, actual CLI lifecycle', seedOnly: true };
const hashes = async () => Object.fromEntries(await Promise.all(Object.keys(seed.buildBefore).map(async path=>[path,createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex')])));
const exists = async path => { try { await readFile(path); return true; } catch(error) { if(error.code==='ENOENT')return false; throw error; } };
async function collect() {
 const records = [];
 async function visit(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
   const path=join(directory,entry.name);
   if(entry.isDirectory()) await visit(path);
   else if(['start.json','finish.json','run.json'].includes(entry.name)) records.push({kind:entry.name,data:JSON.parse(await readFile(path,'utf8'))});
  }
 }
 await visit(join(home,'sessions'));await visit(join(home,'residents'));
 return records;
}
let operation;
try {
 report.buildBefore=await hashes();
 operation=exec(process.execPath,['--import',preload,cli,...flags],{cwd,env,timeout:15000,maxBuffer:1000000});
 let terminal=false;
 const finished=operation.then(result=>({code:0,result}),error=>({code:error.code,signal:error.signal})).finally(()=>{terminal=true;});
 const deadline=Date.now()+10000;
 while (!(await exists(marker))) {
  if(terminal)throw new Error('CLI exited before entering automatic recall.');
  if(Date.now()>deadline)throw new Error('Automatic recall never entered.');
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 report.sent=operation.child.kill('SIGTERM');
 report.exit=await finished;
 assert.equal(report.sent,true);
 assert.equal(report.exit.code,130);
 assert.equal(await exists(providerMarker),false);
 const before=await collect();
 const starts=before.filter(row=>row.kind==='start.json');
 const finishes=before.filter(row=>row.kind==='finish.json');
 assert.equal(starts.length,2);assert.equal(finishes.length,2);
 assert.ok(finishes.every(row=>row.data.cleanup==='confirmed'));
 const status=JSON.parse((await exec(process.execPath,[cli,'--quiet','--format','json','resident','status','--cwd',cwd],{env,cwd})).stdout);
 const state=status.agenda.pursuits[0].state;
 assert.equal(state.phase,'running');assert.ok(state.claimId);
 report.unresolvedClaim=state.claimId;
 report.reopen=await exec(process.execPath,[cli,...flags],{env,cwd,timeout:10000}).then(()=>({code:0}),error=>({code:error.code}));
 assert.equal(report.reopen.code,1);
 assert.equal((await collect()).filter(row=>row.kind==='start.json').length,2);
 report.modelCalls=0;
 report.providerTokens=before.filter(row=>row.kind==='run.json').reduce((sum,row)=>sum+(row.data.tokenUsage?.totalTokens??0),0);
 assert.equal(report.providerTokens,0);
 report.cleanup=finishes.map(row=>({claimId:row.data.claimId,cleanup:row.data.cleanup,stopReason:row.data.stopReason}));
 report.buildAfter=await hashes();assert.deepEqual(report.buildAfter,report.buildBefore);
 report.passed=true;
} catch(error) {
 report.passed=false;report.error=error.message;process.exitCode=1;
 if(operation?.child.exitCode===null && operation?.child.signalCode===null)operation.child.kill('SIGTERM');
} finally {
 await writeFile(join(root,'cancel-result.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({root,passed:report.passed,exit:report.exit,providerTokens:report.providerTokens,error:report.error}));
}
