import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Seed with a scripted provider, through the real CLI resident callback and
// real read tool. No invented transcript/receipt. The later --live invocation
// is the actual small-model experiment; seeding is never reported as live AI.
if (process.argv[2] === '--seed') {
  const sdk = await import('../../packages/sdk/dist/index.js');
  const { lookupResident } = await import('../../packages/cli/dist/integrations/resident/storage.js');
  const { openSessions } = await import('../../packages/cli/dist/integrations/sessions/store.js');
  const { createResidentSessionStep } = await import('../../packages/cli/dist/integrations/resident/session-step.js');
  const { parseRunFlags } = await import('../../packages/cli/dist/commands/run-flags.js');
  const cwd = process.argv[3];
  const distractors = process.argv.includes('--distractors') ? 20 : 0;
  const resident = await lookupResident(cwd, 'default');
  assert.ok(resident);
  const sessions = await openSessions(cwd);
  const pursuit = (await resident.agenda.read()).pursuits[0];
  const tracking = `TRACK-${randomUUID()}`;
  const destination = `DEPOT-${randomUUID()}`;
  const lines = Array.from({ length: 400 }, (_, i) => i === 210
    ? `DELTA original receipt. Tracking: ${tracking}. Destination: ${destination}.`
    : `Inspection row ${i}: ${'packaging unchanged; '.repeat(30)}`);
  await writeFile(join(cwd, 'manifest.txt'), lines.join('\n'));
  for (let i=0;i<distractors;i++) await writeFile(join(cwd,`inspection-${i}.txt`),`Recipient confirmation: original packaging inspected at station ${i}. Code and destination review pending.\n`);
  const provider = new sdk.MockLLMProvider({ turns: [
    ...(distractors ? [{toolCalls:Array.from({length:distractors},(_,i)=>({id:`inspect-${i}`,name:'read',args:{path:`inspection-${i}.txt`}}))}] : []),
    { toolCalls: [{ id: 'observe-manifest-once', name: 'read', args: { path: 'manifest.txt' } }] },
    { text: '{"kind":"wait","summary":"Manifest observed and retained. Await recipient confirmation.","wakeAfterMs":null}' },
  ] });
  sdk.ProviderRegistry.create = () => ({ provider });
  const execution = resident.agenda.execution(pursuit.id);
  const claim = await execution.claim(pursuit.state, Date.now());
  const step = createResidentSessionStep({
    cwd, sessions, agenda: resident.agenda, artifactsRoot: resident.artifactsRoot,
    ctx: { config: { sandbox: { enabled: false }, web: { search: 'off' } }, formatter: { name: 'text', print() {}, info() {}, error() {} } },
    flags: parseRunFlags(['--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '20000']),
    toolLoading: 'deferred', contextProfile: 'resident',
  });
  const result = await step({ ...pursuit, state: claim }, new AbortController().signal, { agendaRevision: (await resident.agenda.read()).revision });
  await execution.settle(claim, result, Date.now());
  const start = JSON.parse(await readFile(join(resident.artifactsRoot, claim.claimId, 'start.json'), 'utf8'));
  const runDir = join(sessions.root, 'sessions', start.sessionId, 'runs', start.runId);
  const events = (await readFile(join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const observation = events.find(event => event.type === 'tool_completed' && event.toolUseId === 'observe-manifest-once');
  assert.ok(observation && !observation.isError && observation.outputTruncated);
  assert.match(observation.outputSpillIntegrity, /^[a-f0-9]{64}$/);
  assert.ok(!observation.result.includes(tracking));
  assert.ok(!observation.result.includes(destination));
  await writeFile(join(cwd, 'manifest.txt'), 'Manually replaced. The original receipt is no longer in this workspace file.\n');
  console.log(JSON.stringify({ tracking, destination, revision: (await resident.agenda.read()).revision, claimId: claim.claimId, start, runDir, originalNotInPreview: true, seededWith: 'scripted provider, real CLI resident callback and read tool' }));
} else {
  const live = process.argv.includes('--live');
  const automatic = process.argv.includes('--automatic');
  const fault = process.argv.includes('--missing-archive') ? 'missing' : process.argv.includes('--changed-archive') ? 'changed' : null;
  const scripted = process.argv.includes('--scripted');
  const boundedReads = process.argv.includes('--bounded-reads');
  const distractors = process.argv.includes('--distractors');
  const expectMiss = process.argv.includes('--expect-miss');
  if (expectMiss && (!scripted || !automatic || fault)) throw new Error('--expect-miss is a scripted automatic selection baseline, not an archive fault.');
  if (fault && (!scripted || !automatic)) throw new Error('Archive faults require scripted automatic recovery.');
  if (live && scripted) throw new Error('Choose live or scripted recovery.');
  if (boundedReads && automatic) throw new Error('--bounded-reads tests explicit tools; automatic recall has its own aggregate allowance.');
  if (boundedReads && !scripted) throw new Error('--bounded-reads requires --scripted.');
  const profile = process.argv.includes('--interactive') ? 'interactive' : 'resident';
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'namzu-tool-evidence-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\ncompaction:\n  recallEvidence: '+automatic+'\n');
  const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
  const env = { ...process.env, NAMZU_HOME: home };
  const report = { root, live, scripted, automatic, fault, boundedReads, distractors, expectMiss, profile, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', commands: [] };
  const preload = join(root, 'scripted-recovery.mjs');
  if (scripted || automatic) await writeFile(preload, `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { ProviderRegistry, MockLLMProvider, ToolRegistry } from ${JSON.stringify(new URL('../../packages/sdk/dist/index.js', import.meta.url).href)};
const parse = value => { const text=String(value); return JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1)); };
if (${boundedReads}) {
 const register=ToolRegistry.prototype.register;
 const wrap=tool=>{
  if(!['search_resident_tools','read_resident_tool'].includes(tool?.name))return tool;
  const execute=tool.execute;
  return {...tool,execute:async(input,context)=>{
   const result=await execute({...input,maxReadBytes:2*1024*1024},context);
   assert.equal(result.success,true);
   const page=JSON.parse(result.output);
   assert.ok(Number.isSafeInteger(page.chargedBytes)&&page.chargedBytes>=0&&page.chargedBytes<=2*1024*1024);
   return result;
  }};
 };
 ToolRegistry.prototype.register=function(first,second){
  if(Array.isArray(first))return register.call(this,first.map(wrap),second);
  if(typeof first==='string')return register.call(this,first,wrap(second));
  return register.call(this,wrap(first),second);
 };
}
if (${scripted}) ProviderRegistry.create=()=>({provider:{id:'scripted',name:'scripted',async *chatStream(params){
 const last=params.messages.filter(m=>m.role==='tool').at(-1);let turn;
 if(${automatic}) {
  const text=JSON.stringify(params);
  const tracking=text.match(/TRACK-[0-9a-f-]{36}/)?.[0];
  const destination=text.match(/DEPOT-[0-9a-f-]{36}/)?.[0];
  if (${JSON.stringify(fault)} || ${expectMiss}) {
   assert.ok(!tracking&&!destination, 'Invalid original bytes must not enter context.');
   assert.ok(text.includes(JSON.stringify('"incomplete":true').slice(1,-1)) || text.includes('Resident evidence availability'));
   turn={text:JSON.stringify({kind:'blocked',summary:'Original retained tool evidence is unavailable; no identifiers were verified.'})};
  } else {
   assert.ok(tracking&&destination, 'Automatic preparation must supply both original identifiers before the scripted response.');
   turn={text:JSON.stringify({kind:'complete',summary:tracking+' '+destination})};
  }
 } else if(!last)turn={toolCalls:[{id:'search',name:'search_resident_tools',args:{query:'DELTA'}}]};
 else {
  const page=parse(last.content);
  if(last.toolCallId.startsWith('search')) {
   const match=page.evidence?.matches[0];
   if(match)turn={toolCalls:[{id:'read-original',name:'read_resident_tool',args:{revision:page.revision,address:match.address,byteOffset:match.byteOffset}}]};
   else {assert.ok(page.nextCursor);turn={toolCalls:[{id:'search-'+params.messages.length,name:'search_resident_tools',args:{query:'DELTA',cursor:page.nextCursor}}]};}
  } else turn={text:JSON.stringify({kind:'complete',summary:page.text})};
 }
 yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
}}});
const create = ProviderRegistry.create;
ProviderRegistry.create = function(...args) {
 const result = create.apply(this,args);
 const provider = result.provider;
 const chatStream = provider.chatStream;
 provider.chatStream = function(params) {
  const text = JSON.stringify(params);
  const strings = value => typeof value==='string'?[value]:value&&typeof value==='object'?Object.values(value).flatMap(strings):[];
  const evidenceRecords=strings(params).filter(s=>s.includes('Retrieved resident evidence')).flatMap(s=>s.split('\\n').filter(line=>line.startsWith('{')&&(line.includes('"querySelection"')||line.startsWith('{"sessionId":'))).map(JSON.parse));
  appendFileSync(${JSON.stringify(join(root,'request-observations.jsonl'))}, JSON.stringify({
   automaticEvidence: text.includes('Retrieved resident evidence'),
   tracking: text.match(/TRACK-[0-9a-f-]{36}/)?.[0],
   destination: text.match(/DEPOT-[0-9a-f-]{36}/)?.[0],
   contextChars: text.length,
   toolMessages: params.messages.filter(m=>m.role==='tool').length,
   evidenceRecords,
  })+'\\n');
  return chatStream.call(this,params);
 };
 return result;
};
`);
  const builtPaths=['packages/sdk/dist/manager/resident/evidence-recall.js','packages/sdk/dist/run/evidence-recall.js','packages/cli/dist/tui/agent.js','packages/sdk/dist/manager/resident/history.js','packages/sdk/dist/manager/resident/tool-evidence.js','packages/sdk/dist/store/evidence/disk.js','packages/sdk/dist/store/evidence/search-input.js','packages/sdk/dist/store/evidence/linked.js','packages/cli/dist/integrations/resident/tool-evidence.js','packages/cli/dist/integrations/resident/session-step.js'];
  const builtHashes=async()=>Object.fromEntries(await Promise.all(builtPaths.map(async path=>[path,createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex')])));
  async function command(args) {
    const { stdout } = await exec(process.execPath, [...((scripted||automatic)&&args[0]==='run'?['--import',preload]:[]),cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd], { cwd, env, timeout: 180_000, maxBuffer: 3_000_000 });
    const result = JSON.parse(stdout); report.commands.push({ args, result }); return result;
  }
  try {
    report.buildBefore=await builtHashes();
    const added = await command(['add', '--trust', 'Recover the exact tracking code and destination from the original DELTA receipt after the recipient confirms. The receipt was previously observed by a tool, but its workspace file can change. Use retained original tool text, reading the relevant original passage before reporting. Do not send anything, edit files, run commands, or reread the mutable workspace file. Complete only with both exact identifiers.']);
    const id = added.agenda.pursuits[0].id;
    const seeded = await exec(process.execPath, [fileURLToPath(import.meta.url), '--seed', cwd,...(distractors?['--distractors']:[])], { cwd, env, timeout: 30_000, maxBuffer: 1_000_000 });
    report.seed = JSON.parse(seeded.stdout);
    if (fault) {
      const spill = join(report.seed.runDir,'tool-output',createHash('sha256').update('observe-manifest-once').digest('hex')+'.txt');
      assert.ok(spill.startsWith(home+'/sessions/'));
      if (fault==='missing') await rename(spill,spill+'.fixture-removed');
      else {
        const bytes=await readFile(spill);const where=bytes.indexOf(report.seed.tracking);assert.ok(where>=0);
        bytes[where]=bytes[where]===84?88:84;await writeFile(spill,bytes);
      }
    }
    const status = await command(['status']);
    assert.ok(!JSON.stringify(status.agenda.pursuits[0].state).includes(report.seed.tracking));
    await command(['wake', id, 'The recipient confirms DELTA. Recover the original recorded tool receipt and report its exact tracking code and destination now.']);
    if (live || scripted) {
      const finished = await command(['run', '--trust', '--max-steps', '1', '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--context-profile', profile, '--tool-loading', 'deferred', '--max-iterations', '8', '--token-budget', '40000']);
      const state = finished.agenda.pursuits[0].state;
      report.observed = { phase: state.phase, summary: state.summary };
      const starts = []; const finishes = []; const tools = []; const runs=[];
      async function collect(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collect(path);
          else if (entry.name === 'start.json') starts.push(JSON.parse(await readFile(path, 'utf8')));
          else if (entry.name === 'finish.json') finishes.push(JSON.parse(await readFile(path, 'utf8')));
          else if (entry.name === 'run.json') runs.push(JSON.parse(await readFile(path,'utf8')));
          else if (entry.name === 'transcript.jsonl')
            for (const line of (await readFile(path, 'utf8')).trim().split('\n')) {
              const event = JSON.parse(line);
              if (['tool_executing', 'tool_completed'].includes(event.type)) tools.push(event);
            }
        }
      }
      await collect(join(home, 'sessions')); await collect(join(home, 'residents'));
      report.starts = starts; report.finishes = finishes; report.toolEvents = tools;
      report.providerTokens=runs.reduce((total,run)=>total+(run.tokenUsage?.totalTokens??0),0);
      if(scripted)assert.equal(report.providerTokens,0);
      assert.equal(state.phase, fault || expectMiss ? 'blocked' : 'complete');
      assert.equal(state.summary.includes(report.seed.tracking),!fault && !expectMiss);
      assert.equal(state.summary.includes(report.seed.destination),!fault && !expectMiss);
      if (automatic) {
        report.requests=(await readFile(join(root,'request-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
        report.automaticBeforeFirstResponse=report.requests[0]?.automaticEvidence&&report.requests[0]?.tracking===report.seed.tracking&&report.requests[0]?.destination===report.seed.destination&&report.requests[0]?.toolMessages===0;
        if (fault || expectMiss) {
          assert.equal(report.requests[0]?.tracking,undefined);assert.equal(report.requests[0]?.destination,undefined);
          if(fault)report.invalidArchiveWithheld=true;
          if(expectMiss)report.selectionMissReproduced=true;
        } else assert.equal(report.automaticBeforeFirstResponse,true);
      }
      assert.equal(starts.length, 2);
      assert.equal(new Set(starts.map(start => start.sessionId)).size, 2);
      assert.ok(finishes.every(finish => finish.cleanup === 'confirmed' && finish.stopReason === 'end_turn'));
      const liveTools = tools.filter(event => event.runId !== report.seed.start.runId);
      const calls = liveTools.filter(event => event.type === 'tool_executing').map(event => event.toolName);
      report.observed.tools = calls;
      if(!automatic) { assert.ok(calls.includes('search_resident_tools')); assert.ok(calls.includes('read_resident_tool')); }
      assert.ok(calls.every(name => ['search_resident_tools', 'read_resident_tool', 'search_resident_history', 'read_resident_history'].includes(name)));
      assert.ok(liveTools.filter(event => event.type === 'tool_completed').every(event => !event.isError));
      if(boundedReads){report.readCharges=liveTools.filter(event=>event.type==='tool_completed').map(event=>({tool:event.toolName,chargedBytes:JSON.parse(event.result).chargedBytes}));assert.ok(report.readCharges.every(row=>Number.isSafeInteger(row.chargedBytes)&&row.chargedBytes<=2*1024*1024));}
      assert.equal(tools.filter(event => event.type === 'tool_executing' && event.toolName === 'read').length, distractors ? 21 : 1);
      assert.match(await readFile(join(cwd, 'manifest.txt'), 'utf8'), /^Manually replaced/);
      const idle = await command(['run', '--trust', '--max-steps', '1']);
      assert.equal(idle.agenda.pursuits[0].state.stepsAdmitted, 2);
      report.observed.terminalReopenAdmittedNoStep = true;
    }
    report.buildAfter=await builtHashes();assert.deepEqual(report.buildAfter,report.buildBefore);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  } finally {
    // Collect usage even when a model/process assertion failed before normal collection.
    report.finalRunLedgers=[];
    async function ledgers(directory) {
      let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      for(const entry of entries){const path=join(directory,entry.name);if(entry.isDirectory())await ledgers(path);else if(entry.name==='run.json'){const run=JSON.parse(await readFile(path,'utf8'));report.finalRunLedgers.push({runId:run.id??run.runId,status:run.status,tokenUsage:run.tokenUsage,cost:run.cost});}}
    }
    await ledgers(join(home,'sessions'));
    report.providerTokens=report.finalRunLedgers.reduce((sum,run)=>sum+(run.tokenUsage?.totalTokens??0),0);
    report.fingerprints = {};
    for (const path of ['packages/sdk/src/store/evidence/disk.ts', 'packages/sdk/src/store/evidence/index-page.ts', 'packages/sdk/src/store/evidence/format.ts', 'packages/sdk/src/manager/resident/tool-evidence.ts', 'packages/sdk/src/runtime/query/index.ts', 'packages/cli/src/integrations/resident/tool-evidence.ts', 'packages/cli/src/integrations/resident/session-step.ts', 'research/resident/tool-evidence-cli.mjs'])
      report.fingerprints[path] = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex');
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ root, live, automatic, fault, profile, passed: report.passed, providerTokens: report.providerTokens, automaticBeforeFirstResponse: report.automaticBeforeFirstResponse, tools:report.observed?.tools, error: report.error }));
  }
}
