import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const agentURL = new URL('../../packages/cli/dist/tui/agent.js', import.meta.url);
const sessionsURL = new URL('../../packages/cli/dist/integrations/sessions/store.js', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.env.NAMZU_CHECKPOINT_EVIDENCE_MODE;
const isQueryPreparation = params => params.messages.length === 2
  && String(params.messages[0]?.content).startsWith('Resolve a conversation-history search query.');

// Only the probe children install these adapters. The parent and production
// modules are unchanged. The resume child enters through the real CLI binary.
if (mode === 'resume') {
  const sdk = await import(sdkURL);
  const create = sdk.ProviderRegistry.create;
  const parse = content => { const text=String(content); return JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1)); };
  let first = true;
  sdk.ProviderRegistry.create = function (...args) {
    const result = process.env.NAMZU_CHECKPOINT_EVIDENCE_LIVE === '1'
      ? create.apply(this, args)
      : { provider: { id:'scripted', name:'scripted', async *chatStream(params) {
          // Preparation has no tools. Keep this deterministic probe focused on
          // explicit recovery; the live variant delegates planning normally.
          if (isQueryPreparation(params)) {
            yield* new sdk.MockLLMProvider({ turns: [{ text: JSON.stringify({ mode:'none', time:'unspecified', termIds:[], basis:[] }) }] }).chatStream(params);
            return;
          }
          const observations=params.messages.filter(m=>m.role==='tool');
          const search=observations.find(m=>m.toolCallId==='find-receipt');
          const read=observations.find(m=>m.toolCallId==='read-receipt');
          let turn;
          if(!search)turn={toolCalls:[{id:'find-receipt',name:'search_conversation',args:{query:'ORCHID'}}]};
          else if(process.env.NAMZU_CHECKPOINT_EVIDENCE_ALTERED==='1'){const found=parse(search.content);assert.ok(found.incomplete&&found.unavailableRuns>0,'Altered original must be reported unavailable');assert.equal(found.matches.some(m=>m.toolName==='bash'),false);turn={text:'Original receipt is unavailable; no action repeated.'};}
          else if(!read){const match=parse(search.content).matches.find(m=>m.toolName==='bash');assert.ok(match,'Original command evidence missing');turn={toolCalls:[{id:'read-receipt',name:'read_conversation',args:{runId:match.runId,seq:match.seq,part:match.part,byteOffset:match.byteOffset}}]};}
          else turn={text:parse(read.content).text};
          yield* new sdk.MockLLMProvider({turns:[turn]}).chatStream(params);
        } } };
    const provider = result.provider;
    const stream = provider.chatStream.bind(provider);
    provider.chatStream = async function* (params) {
      // Explicitly bound effort for the live research run. This adapter does
      // not replace tools, recovery decisions, persistence or provider output.
      const bounded = { ...params, effort: 'low' };
      const names=(params.tools??[]).map(t=>t.function?.name??t.name);
      if (isQueryPreparation(params)) {
        assert.equal(names.length, 0, 'Query preparation must remain tool-free');
        await writeFile(join(process.env.NAMZU_CHECKPOINT_EVIDENCE_ROOT, 'preparation.json'), JSON.stringify({ toolCount: names.length, scripted: process.env.NAMZU_CHECKPOINT_EVIDENCE_LIVE !== '1' }));
        yield* stream(bounded);
        return;
      }
      if(first){await writeFile(join(process.env.NAMZU_CHECKPOINT_EVIDENCE_ROOT,'offered-tools.json'),JSON.stringify(names));first=false;}
      assert.ok(names.includes('search_conversation')&&names.includes('read_conversation'),'Checkpoint resume did not mount conversation evidence tools');
      await writeFile(join(process.env.NAMZU_CHECKPOINT_EVIDENCE_ROOT, 'request.json'), JSON.stringify(bounded, null, 2));
      if(process.env.NAMZU_CHECKPOINT_EVIDENCE_FAIL==='1')throw new Error('Synthetic checkpoint provider failure');
      yield* stream(bounded);
    };
    return result;
  };
} else if (mode === 'seed') {
  const sdk = await import(sdkURL);
  const { openSessions, startConversation } = await import(sessionsURL);
  const { createAgentSession, probeAgentSession } = await import(agentURL);
  const cwd = process.cwd();
  const sessions = await openSessions(cwd);
  const sessionId = await startConversation(sessions);
  const runId = sdk.generateRunId();
  const scope = { sessionId, tenantId: sessions.tenantId, projectId: sessions.projectId, topicId: sessions.topicId };
  const execute = sdk.ReadFileTool.execute.bind(sdk.ReadFileTool);
  sdk.ReadFileTool.execute = async (...args) => {
    const result = await execute(...args);
    if(args[0].path!=='counter.txt'&&args[0].path!==join(cwd,'counter.txt'))return result;
    assert.equal(result.success, true);
    assert.equal(await readFile(join(cwd, 'counter.txt'), 'utf8'), '1');
    // The real shell completed and retained its output. Hold the following
    // read before its completion, keeping the entire batch checkpointed.
    process.send({ ...scope, runId, root: sessions.root });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  sdk.ProviderRegistry.create = () => ({ provider: new sdk.MockLLMProvider({ turns: [{ toolCalls: [
    { id: 'inspect', name: 'read', args: { path: 'record-once.cjs' } },
    { id: 'effect', name: 'bash', args: { command: 'node record-once.cjs' } },
    { id: 'pause', name: 'read', args: { path: 'counter.txt' } },
  ] }] }) });
  const probe = await probeAgentSession();
  const session = await createAgentSession(probe.preferences, probe.detected, {
    cwd, stateRoot: sessions.root, conversationSessions: sessions, scope,
    sandbox: { enabled: false }, web: { search: 'off' }, memory: { recall: false },
    limits: { maxIterations: 6, tokenBudget: 45000 },
  });
  assert.equal(session.hasProvider, true, session.errorHint);
  for await (const _event of session.send([sdk.createUserMessage('Run record-once.cjs exactly once and report the ORCHID receipt code from its output. Then inspect counter.txt.')], { runId, permissionMode: 'auto' })) { /* parent kills before tool completion */ }
} else {
  const live = process.argv.includes('--live');
  const altered = process.argv.includes('--altered');
  const failProvider = process.argv.includes('--fail-provider');
  const root = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-evidence-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\nlimits:\n  maxIterations: 6\n  tokenBudget: 45000\n');
  await writeFile(join(cwd, 'counter.txt'), '0');
  const receipt='ORCHID-'+randomUUID();
  const originalText=Array.from({length:400},(_,i)=>i===210?'Original receipt: '+receipt:'Row '+(i%2?'A':'B')+' '+i+': '+('ordinary observation '.repeat(40))).join('\n');
  await writeFile(join(cwd,'manifest.txt'),originalText);
  await writeFile(join(cwd, 'record-once.cjs'), "const fs = require('node:fs');\nconst count = Number(fs.readFileSync('counter.txt', 'utf8')) + 1;\nfs.writeFileSync('counter.txt', String(count));\nprocess.stdout.write(fs.readFileSync('manifest.txt','utf8'));\n");
  const env = { ...process.env, NAMZU_HOME: home, NAMZU_CHECKPOINT_EVIDENCE_FAIL: failProvider?'1':'0', NAMZU_CHECKPOINT_EVIDENCE_ALTERED: altered?'1':'0', NAMZU_CHECKPOINT_EVIDENCE_ROOT: root };
  const report = { root, live, altered, failProvider, model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low', receipt, entrypoint: 'CLI drain', limits: { maxIterations: 6, tokenBudget: 45000, timeoutMs: 150000 } };
  const paths = ['packages/sdk/dist/runtime/query/index.js', 'packages/sdk/dist/runtime/query/resume-pending.js', 'packages/sdk/dist/runtime/query/executor.js', 'packages/sdk/dist/store/run/tool-executions.js', 'packages/sdk/dist/store/run/disk.js', 'packages/sdk/dist/tools/builtins/bash.js', 'packages/cli/dist/tui/agent.js', 'packages/cli/dist/commands/drain.js', 'packages/cli/dist/integrations/sessions/conversation-search.js'];
  const fingerprints = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(new URL('../../' + path, import.meta.url)))])));
  let child;
  try {
    report.before = await fingerprints();
    child = fork(fileURLToPath(import.meta.url), [], { cwd, env: { ...env, NAMZU_CHECKPOINT_EVIDENCE_MODE: 'seed' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-100000); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    report.seed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Seed timed out: ' + stderr)), 30000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Seed exited: ${code} ${signal} ${stderr}`)); });
    });
    child.kill('SIGKILL'); report.seedExit = await exited;
    assert.equal(report.seedExit.signal, 'SIGKILL');
    const runDir = join(home, 'sessions', report.seed.sessionId, 'runs', report.seed.runId);
    const transcriptPath = join(runDir, 'transcript.jsonl');
    const raw = await readFile(transcriptPath, 'utf8');
    await writeFile(join(root, 'original.jsonl'), raw);
    const original = raw.trim().split('\n').map(JSON.parse);
    assert.ok(original.some(e => e.type === 'tool_completed' && e.toolUseId === 'inspect'));
    assert.ok(original.some(e => e.type === 'tool_executing' && e.toolUseId === 'effect'));
    const effect=original.find(e=>e.type==='tool_completed'&&e.toolUseId==='effect');
    assert.ok(effect?.outputSpillIntegrity); assert.ok(!effect.result.includes(receipt));
    report.originalOutputHash=digest(await readFile(effect.outputSpillPath));
    assert.equal(report.originalOutputHash,digest('STDOUT:\n'+originalText));
    report.outputSpillPath=effect.outputSpillPath;
    if(altered){const bytes=await readFile(effect.outputSpillPath);bytes[bytes.indexOf(Buffer.from(receipt))]=88;await writeFile(effect.outputSpillPath,bytes);}
    await writeFile(join(cwd,'manifest.txt'),'The current file no longer contains the historical receipt.');
    report.counterBefore = Number(await readFile(join(cwd, 'counter.txt'), 'utf8'));
    assert.equal(report.counterBefore, 1);
    const cliPath = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
    const args = ['--import', fileURLToPath(import.meta.url), cliPath, '--quiet', '--format', 'json', 'drain', '--trust', '--cwd', cwd, '--store', join(home, 'sessions', report.seed.sessionId, 'runs'), '--tenant', report.seed.tenantId, '--project', report.seed.projectId, '--session', report.seed.sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna'];
    const result = await promisify(execFile)(process.execPath, args, { cwd, env: { ...env, NAMZU_CHECKPOINT_EVIDENCE_MODE: 'resume', NAMZU_CHECKPOINT_EVIDENCE_LIVE: live ? '1' : '0' }, timeout: 150000, maxBuffer: 500000 });
    await writeFile(join(root, 'stdout.log'), result.stdout); await writeFile(join(root, 'stderr.log'), result.stderr);
    const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
    report.preparation = JSON.parse(await readFile(join(root, 'preparation.json'), 'utf8'));
    assert.ok(request.messages.some(m => m.role === 'tool' && m.toolCallId === 'pause' && m.isError && m.content.includes('outcome is unknown')));
    report.counterAfter = Number(await readFile(join(cwd, 'counter.txt'), 'utf8'));
    assert.equal(report.counterAfter, 1);
    const final = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map(JSON.parse);
    report.toolStarts = final.filter(e => e.type === 'tool_executing').map(e => ({ toolUseId: e.toolUseId, toolName: e.toolName }));
    report.originalActionStarts=final.filter(e=>e.type==='tool_executing'&&e.toolName==='bash'&&e.input?.command==='node record-once.cjs').length;
    assert.equal(report.originalActionStarts,1);
    const metadata = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    report.status = metadata.status; report.usage = metadata.tokenUsage; report.budget = metadata.budget;
    assert.equal(report.status, 'completed');
    const answer=final.findLast(e=>e.type==='run_completed')?.result;
    report.recoveredReceipt=typeof answer==='string'&&answer.includes(receipt);
    assert.equal(report.recoveredReceipt,!altered,'Unexpected receipt recovery state');
    assert.ok(report.toolStarts.some(e=>e.toolName==='search_conversation'));
    if(!altered){if(!live)assert.ok(report.toolStarts.some(e=>e.toolName==='read_conversation'));assert.equal(digest(await readFile(report.outputSpillPath)),report.originalOutputHash);}
    report.after = await fingerprints(); assert.deepEqual(report.after, report.before);
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.message;
    if(failProvider&&error.code===1&&String(error.stderr).includes('Resumed run ended with status')){
      const runDir=join(home,'sessions',report.seed.sessionId,'runs',report.seed.runId);
      const raw=await readFile(join(runDir,'transcript.jsonl'),'utf8');
      assert.ok(raw.includes('Synthetic checkpoint provider failure'));
      assert.equal(JSON.parse(await readFile(join(runDir,'run.json'),'utf8')).status,'failed');
      report.counterAfter=Number(await readFile(join(cwd,'counter.txt'),'utf8'));assert.equal(report.counterAfter,1);
      report.preparation=JSON.parse(await readFile(join(root,'preparation.json'),'utf8'));
      report.after=await fingerprints();assert.deepEqual(report.after,report.before);
      report.exitCode=1;report.passed=true;delete report.error;
    }
    if (error.stdout) await writeFile(join(root, 'stdout.log'), error.stdout);
    if (error.stderr) await writeFile(join(root, 'stderr.log'), error.stderr);
    if(!report.passed)process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
    }
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, passed: report.passed, before: report.counterBefore, after: report.counterAfter, error: report.error }));
  }
}
