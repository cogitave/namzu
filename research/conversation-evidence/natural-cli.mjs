import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const live = process.argv.includes('--live');
const checkCurrent = process.argv.includes('--check-current');
const recallEvidence = process.argv.includes('--recall-evidence');
const root = await mkdtemp(join(tmpdir(), 'namzu-natural-recall-'));
const home = join(root, 'home');
const cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd);
const original = { tracking: `TAKIP-${randomUUID()}`, depot: `DEPO-${randomUUID()}` };
const replacement = { tracking: `YENI-TAKIP-${randomUUID()}`, depot: `YENI-DEPO-${randomUUID()}` };
const file = join(cwd, 'sevkiyatlar.txt');
const originalText = Array.from({ length: 400 }, (_, i) => i === 210
  ? `DELTA siparişi. Takip kodu: ${original.tracking}.`
  : i === 213 ? `DELTA siparişinin hedef deposu: ${original.depot}.`
  : `Sevkiyat denetim kaydı ${i}: ${'ambalaj sağlam; teslimat bekleniyor; '.repeat(20)}`).join('\n');
const replacementText = `Güncel revizyon; önceki dökümün yerini aldı.\nDELTA siparişi. Takip kodu: ${replacement.tracking}. Hedef deposu: ${replacement.depot}.\n`;
await writeFile(file, originalText);
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }));
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n' + (recallEvidence ? 'compaction:\n  recallEvidence: true\n' : ''));
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
const preload = join(root, 'scripted-provider.mjs');
// Only the offline control replaces model choices. Live runs launch the plain CLI.
await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
const parse=c=>{const s=String(c);return JSON.parse(s.slice(s.indexOf('{'),s.lastIndexOf('}')+1));};
ProviderRegistry.create=()=>{let step=0;return {provider:{id:'scripted',name:'scripted',async *chatStream(params){
 const phase=process.env.NAMZU_NATURAL_PHASE; const last=params.messages.filter(m=>m.role==='tool').at(-1); let turn;
 if(phase==='1')turn=step++===0?{toolCalls:[{id:'initial-read',name:'read',args:{path:'sevkiyatlar.txt'}}]}:{text:'Döküm sevkiyat denetim kayıtlarını içeriyor.'};
 else if(phase==='3')turn=step++===0?{toolCalls:[{id:'current-read',name:'read',args:{path:'sevkiyatlar.txt'}}]}:{text:String(last.content)};
 else if(step++===0)turn={toolCalls:[{id:'history-search',name:'search_conversation',args:{query:'DELTA'}}]};
 else {const page=parse(last.content);if(last.toolCallId.startsWith('history-search')){
 const match=page.matches?.find(m=>m.toolName==='read')??page.matches?.[0];
 turn=match?{toolCalls:[{id:'history-read',name:'read_conversation',args:{runId:match.runId,seq:match.seq,part:match.part,byteOffset:match.byteOffset}}]}:{toolCalls:[{id:'history-search-'+step,name:'search_conversation',args:{query:'DELTA',cursor:page.nextCursor}}]};
 }else turn={text:page.text};}
 yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
}}};};`);

const report = { root, live, checkCurrent, recallEvidence, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low', original, replacement, turns: [] };
const allEvents = async () => {
  const events = [];
  for (const session of await readdir(join(home, 'sessions'), { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const runs = join(home, 'sessions', session.name, 'runs');
    for (const run of await readdir(runs, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const text = await readFile(join(runs, run.name, 'transcript.jsonl'), 'utf8');
      events.push(...text.trim().split('\n').map(JSON.parse));
    }
  }
  return events;
};

async function turn(prompt, phase, tokenBudget) {
  const args = ['--quiet', 'run-stream', '--session', 'natural-recall', '--trust', '--cwd', cwd,
    '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '6', '--token-budget', String(tokenBudget), prompt];
  const before = new Set((phase === 1 ? [] : await allEvents()).map(e=>e.runId));
  const record = { phase, prompt, args, tokenBudget };
  report.turns.push(record);
  let result;
  try {
    result = await exec(process.execPath, [...(live ? [] : ['--import', preload]), cli, ...args], {
      cwd, env: {...process.env, NAMZU_HOME:home, NAMZU_NATURAL_PHASE:String(phase)}, timeout:180_000, maxBuffer:2_000_000,
    });
  } catch (error) {
    record.processError = String(error.message);
    result = { stdout:error.stdout??'', stderr:error.stderr??'' };
  }
  await writeFile(join(root, `turn-${phase}.ndjson`), result.stdout);
  const lines = result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  record.done = lines.findLast(e=>e.kind==='done');
  record.errors = lines.filter(e=>e.kind==='error');
  const events = (await allEvents()).filter(e=>!before.has(e.runId));
  record.calls = events.filter(e=>e.type==='tool_executing').map(e=>({name:e.toolName,input:e.input}));
  record.requestUsage = events.filter(e=>e.type==='message_completed'&&e.usage).map(e=>e.usage);
  record.totalTokens = record.requestUsage.reduce((n,u)=>n+u.totalTokens,0);
  record.cachedTokens = record.requestUsage.reduce((n,u)=>n+(u.cachedTokens??0),0);
  return {record, events};
}

try {
  const first = await turn('sevkiyatlar.txt dosyasının tamamını incele; yalnızca hangi tür kayıtlar içerdiğini bir cümleyle söyle.', 1, 25_000);
  const outputs = first.events.filter(e=>e.type==='tool_completed');
  const containsBoth = text=>typeof text==='string' && text.includes(original.tracking) && text.includes(original.depot);
  const captured = [];
  for (const output of outputs) {
    captured.push(String(output.result));
    if (output.outputSpillPath && output.outputSpillIntegrity) captured.push(await readFile(output.outputSpillPath,'utf8'));
  }
  const capturedBoth = containsBoth(captured.join('\n'));
  const visibleText = [...outputs.map(e=>String(e.result)), ...first.events.filter(e=>e.type==='message_completed').map(e=>String(e.content??'')), first.record.done?.text??''].join('\n');
  const visibleOriginalCount = Object.values(original).filter(value=>visibleText.includes(value)).length;
  report.prerequisites = {
    capturedBoth,
    initialStopReason: first.record.done?.stopReason,
    initialCompleted: first.record.done?.stopReason==='end_turn',
    visibleOriginalCount,
    initialSourceUnchanged: await readFile(file,'utf8')===originalText,
    successfulInitialRead: outputs.some(e=>e.toolName==='read'&&!e.isError),
  };
  await writeFile(file, replacementText);
  const second = await turn('Az önce incelediğin dökümde DELTA siparişinin takip kodu ve hedef deposu neydi?', 2, 50_000);
  const answer = second.record.done?.text??'';
  report.observations = {
    correctOriginal: containsBoth(answer),
    usedReplacement: answer.includes(replacement.tracking)||answer.includes(replacement.depot),
    allOriginalAbsentFromVisible: visibleOriginalCount===0,
    archiveSearches: second.record.calls.filter(c=>c.name==='search_conversation').length,
    exactArchiveReads: second.record.calls.filter(c=>c.name==='read_conversation').length,
    workspaceObservations: second.record.calls.filter(c=>['read','grep'].includes(c.name)&&String(c.input?.path).includes('sevkiyatlar.txt')).length,
    failedTools: second.events.filter(e=>e.type==='tool_completed'&&e.isError).length,
    replacementUnchanged: await readFile(file,'utf8')===replacementText,
  };
  report.passed = capturedBoth && report.prerequisites.initialCompleted && report.prerequisites.successfulInitialRead && report.prerequisites.initialSourceUnchanged
    && report.observations.correctOriginal && !report.observations.usedReplacement && report.observations.replacementUnchanged
    && report.turns.every(t=>!t.processError&&t.errors.length===0&&t.done?.stopReason==='end_turn');
  if (checkCurrent) {
    const current = await turn('Peki aynı siparişin güncel dökümdeki takip kodu ve hedef deposu ne?', 3, 25_000);
    const currentAnswer = current.record.done?.text??'';
    report.currentCheck = {
      correctReplacement: Object.values(replacement).every(value=>currentAnswer.includes(value)),
      usedOriginal: Object.values(original).some(value=>currentAnswer.includes(value)),
      workspaceObservations: current.record.calls.filter(c=>['read','grep'].includes(c.name)&&String(c.input?.path).includes('sevkiyatlar.txt')).length,
      sourceUnchanged: await readFile(file,'utf8')===replacementText,
      failedTools: current.events.filter(e=>e.type==='tool_completed'&&e.isError).length,
    };
    report.currentCheck.passed = report.currentCheck.correctReplacement && !report.currentCheck.usedOriginal
      && report.currentCheck.sourceUnchanged && !current.record.processError && current.record.errors.length===0
      && current.record.done?.stopReason==='end_turn';
  }
  if(!report.passed || report.currentCheck?.passed===false)process.exitCode=1;
} catch(error) {report.passed=false;report.error=String(error.message);process.exitCode=1;}
finally {
  report.fingerprints={};
  for(const path of ['packages/sdk/src/run/evidence-recall.ts','packages/cli/src/integrations/sessions/evidence-recall.ts','packages/sdk/src/prompt/coding-agent-doctrine.ts','packages/sdk/src/runtime/query/tool-output-budget.ts','packages/cli/src/integrations/sessions/conversation-search.ts','packages/cli/src/tui/agent.ts','packages/cli/src/commands/run-stream.ts','research/conversation-evidence/natural-cli.mjs'])
    report.fingerprints[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({root,live,passed:report.passed,prerequisites:report.prerequisites,observations:report.observations,currentCheck:report.currentCheck,turns:report.turns.map(t=>({phase:t.phase,calls:t.calls,totalTokens:t.totalTokens})),error:report.error}));
}
