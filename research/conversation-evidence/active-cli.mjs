import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const sessionsURL = new URL('../../packages/cli/dist/integrations/sessions/store.js', import.meta.url);
if (process.argv[2] === '--prepare') {
  const { openSessions, resolveConversation, replaceConversation } = await import(sessionsURL);
  const sessions = await openSessions(process.argv[3]);
  const sessionId = await resolveConversation(sessions, 'active-receipt');
  const { createUserMessage } = await import(sdkURL);
  await replaceConversation(sessions, sessionId, [createUserMessage('Prepare a single-invocation retained evidence check.')]);
  console.log(sessionId);
} else {
  const live = process.argv.includes('--live');
  const previewArg = process.argv.find(arg=>arg.startsWith('--preview-chars='));
  const previewChars = previewArg ? Number(previewArg.slice('--preview-chars='.length)) : undefined;
  if(previewChars !== undefined) assert.ok(Number.isSafeInteger(previewChars) && previewChars >= 0);
  const root = await mkdtemp(join(tmpdir(), 'namzu-active-evidence-cli-'));
  const home = join(root, 'home'); const cwd = join(root, 'workspace');
  await mkdir(home); await mkdir(cwd);
  const tracking = `TRACK-${randomUUID()}`; const destination = `DEPOT-${randomUUID()}`;
  await writeFile(join(cwd, 'manifest.txt'), Array.from({ length: 400 }, (_, i) => i === 210
    ? `DELTA original receipt. Tracking: ${tracking}.`
    : i === 213 ? `Destination of DELTA: ${destination}.`
    : `Inspection row ${i}: ${'α🦉 packaging unchanged; '.repeat(30)}`).join('\n'));
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
  await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n' + (previewChars === undefined ? '' : `compaction:\n  retainedToolPreviewChars: ${previewChars}\n`));
  const env = { ...process.env, NAMZU_HOME: home };
  const exec = promisify(execFile);
  const report = { root, live, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low', tracking, destination, ...(previewChars === undefined ? {} : {previewChars}) };
  try {
    const prepared = await exec(process.execPath, [fileURLToPath(import.meta.url), '--prepare', cwd], { cwd, env, timeout: 30_000, maxBuffer: 1_000_000 });
    const sessionId = prepared.stdout.trim(); report.sessionId = sessionId;
    const preload = join(root, 'observe-file-replacement.mjs');
    // The live wrapper changes only the external file between provider requests.
    // All live model decisions, history and tool calls use the production driver.
    await writeFile(preload, `import { ProviderRegistry, MockLLMProvider } from ${JSON.stringify(sdkURL.href)};
import {writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const original = ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create = (...args) => {
 const created = original(...args); const provider = created.provider;
 const stream = provider.chatStream.bind(provider); let replaced = false; let previous = ''; let requestNumber=0;
 provider.chatStream = async function* (params) {
  const system=params.messages.filter(m=>m.role==='system').map(m=>m.content).join('\\n\\n');
  const portable=params.messages.filter(m=>m.role!=='system').map(m=>JSON.stringify([m.role,m.content,m.toolCallId,m.toolCalls])).join('\\n');
  let common=0; while(common<previous.length && common<portable.length && previous[common]===portable[common])common++;
  const context=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
  await appendFile(${JSON.stringify(join(root,'request-shapes.jsonl'))},JSON.stringify({request:++requestNumber,systemChars:system.length,systemDigest:createHash('sha256').update(system).digest('hex'),portableInputChars:portable.length,commonPortablePrefixChars:common,stepContextCount:context.length,stepContextChars:context.reduce((n,m)=>n+String(m.content).length,0)})+'\\n');
  previous=portable;
  const readIds = params.messages.flatMap(m=>m.role==='assistant'?(m.toolCalls??[]):[]).filter(c=>c.function.name==='read').map(c=>c.id);
  const readResult = params.messages.find(m=>m.role==='tool'&&readIds.includes(m.toolCallId));
  if(readResult && !replaced) { await writeFile(${JSON.stringify(join(cwd, 'manifest.txt'))}, 'Manually replaced. Original receipt removed.\\n'); replaced=true; }
  if (${JSON.stringify(live)}) { yield* stream(params); return; }
  const parse = (value) => { const text=String(value);return JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1)); };
  const last = params.messages.filter(m=>m.role==='tool').at(-1); let turn;
  if(!last) turn={toolCalls:[{id:'observe-once',name:'read',args:{path:'manifest.txt'}}]};
  else if(readIds.includes(last.toolCallId)) turn={toolCalls:[{id:'search',name:'search_conversation',args:{query:'DELTA'}}]};
  else { const page=parse(last.content);
   if(last.toolCallId.startsWith('search')) { const match=page.matches?.[0];
    turn=match?{toolCalls:[{id:'recover',name:'read_conversation',args:{runId:match.runId,seq:match.seq,part:match.part,byteOffset:match.byteOffset}}]}:{toolCalls:[{id:'search-'+params.messages.length,name:'search_conversation',args:{query:'DELTA',cursor:page.nextCursor}}]};
   } else turn={text:page.text};
  }
  yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
 };
 return created;
};`);
    const prompt = 'Read manifest.txt once using the read tool. Then recover the exact tracking code and destination of the original DELTA receipt from this conversation using search_conversation and read_conversation. The file will be externally replaced after the initial read. Do not read workspace files again, run commands, edit anything or contact external services. Report both original identifiers exactly.';
    const args = ['--quiet', '--format', 'json', 'run', '--trust', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '8', '--token-budget', '65000', prompt];
    report.command = args;
    const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
    const { stdout } = await exec(process.execPath, ['--import', preload, cli, ...args], { cwd, env, timeout: 180_000, maxBuffer: 2_000_000 });
    report.result = JSON.parse(stdout);
    const runs = join(home, 'sessions', sessionId, 'runs');
    const runIds = (await readdir(runs, { withFileTypes: true })).filter(e=>e.isDirectory()).map(e=>e.name);
    assert.equal(runIds.length, 1); report.runId = runIds[0];
    const events = (await readFile(join(runs, runIds[0], 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    report.calls = events.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
    report.requestShapes=(await readFile(join(root,'request-shapes.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    report.requestUsage=events.filter(e=>e.type==='message_completed'&&e.usage).map(e=>({iteration:e.iteration,...e.usage}));
    const completed = events.filter(e=>e.type==='tool_completed');
    const first = completed.find(e=>e.toolName==='read');
    assert.ok(first.outputTruncated && first.outputSpillIntegrity);
    assert.ok(!first.result.includes(tracking) && !first.result.includes(destination));
    report.outputs = completed.map(e=>({name:e.toolName,isError:e.isError,...(e.toolName==='read'?{truncated:e.outputTruncated,previewChars:e.result.length,originalChars:e.outputLength}:{result:e.result})}));
    // User outcome and requested workflow are separate observations. The original
    // assertions below still require an exact read, even if both IDs appear in search excerpts.
    report.observations = {
      bothIdentifiersRecovered: report.result.text.includes(tracking) && report.result.text.includes(destination),
      originalReadCalls: report.calls.filter(e=>e.name==='read').length,
      searches: report.calls.filter(e=>e.name==='search_conversation').length,
      exactReads: report.calls.filter(e=>e.name==='read_conversation').length,
      failedTools: completed.filter(e=>e.isError).length,
      workspaceStillReplaced: /^Manually replaced/.test(await readFile(join(cwd,'manifest.txt'),'utf8')),
    };
    assert.ok(report.result.text.includes(tracking)); assert.ok(report.result.text.includes(destination));
    assert.equal(report.calls.filter(e=>e.name==='read').length, 1);
    assert.ok(report.calls.some(e=>e.name==='search_conversation'));
    assert.ok(report.calls.some(e=>e.name==='read_conversation'));
    assert.ok(report.calls.every(e=>['read','search_conversation','read_conversation','search_tools'].includes(e.name)));
    assert.ok(completed.every(e=>!e.isError));

    assert.match(await readFile(join(cwd, 'manifest.txt'), 'utf8'), /^Manually replaced/);
    report.passed = true;
  } catch(error) { report.passed=false;report.error=error instanceof Error?error.message:String(error);process.exitCode=1; }
  finally {
    report.fingerprints = {};
    for(const path of ['packages/sdk/src/runtime/query/tool-output-budget.ts','packages/sdk/src/runtime/query/executor.ts','packages/cli/src/tui/agent.ts','packages/cli/src/config/load.ts','packages/sdk/src/runtime/query/iteration/index.ts','packages/sdk/src/types/run/prepare-step.ts','packages/sdk/src/types/message/index.ts','packages/cli/src/integrations/sessions/context-inventory.ts','packages/sdk/src/store/evidence/passages.ts','packages/sdk/src/store/evidence/disk.ts','packages/sdk/src/store/evidence/types.ts','packages/sdk/src/store/evidence/linked.ts','packages/sdk/src/store/evidence/source-text.ts','packages/sdk/src/store/evidence/record-chain.ts','packages/sdk/src/store/run/disk.ts','packages/sdk/src/runtime/query/events.ts','packages/sdk/src/runtime/query/index.ts','packages/cli/src/integrations/sessions/conversation-search.ts','research/conversation-evidence/active-cli.mjs'])
      report.fingerprints[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');
    await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({root,live,passed:report.passed,calls:report.calls,usage:report.result?.usage,error:report.error}));
  }
}
