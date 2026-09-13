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
const referential = process.argv.includes('--referential');
const scriptedObservation = process.argv.includes('--scripted-observation');
const queryAblation = process.argv.includes('--query-ablation');
const resolveEvidenceQueries = process.argv.includes('--resolve-queries');
const checkTopic = process.argv.includes('--check-topic');
const progressUpdates = process.argv.includes('--progress-updates');
if(progressUpdates && (!referential || !scriptedObservation)) throw new Error('--progress-updates requires --referential --scripted-observation.');
if(resolveEvidenceQueries && !live) throw new Error('--resolve-queries requires --live; offline planning is covered by SDK/Session tests.');
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
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\n' + (recallEvidence ? 'compaction:\n  recallEvidence: true\n  resolveEvidenceQueries: '+resolveEvidenceQueries+'\n' : ''));
const sdkURL = new URL('../../packages/sdk/dist/index.js', import.meta.url);
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));
const preload = join(root, 'scripted-provider.mjs');
const observer = join(root, 'observe-provider.mjs');
await writeFile(observer, `import {ProviderRegistry} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const create=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{const created=create(...args);const stream=created.provider.chatStream.bind(created.provider);
created.provider.chatStream=async function*(params){
 const context=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
 const ordinary=params.messages.filter(m=>!context.includes(m));
 const codes=${JSON.stringify(Object.values(original))};
 let preparationText='';
 const preparation=params.messages.length===2&&String(params.messages[0]?.content).startsWith('Resolve a conversation-history search query.');
 await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({phase:process.env.NAMZU_NATURAL_PHASE,preparation,contextChars:context.reduce((n,m)=>n+String(m.content).length,0),contextOriginals:codes.map(code=>context.some(m=>String(m.content).includes(code))),ordinaryOriginals:codes.map(code=>ordinary.some(m=>JSON.stringify(m).includes(code)))})+'\\n');
 for await(const chunk of stream(params)){
  if(preparation) preparationText+=(chunk.delta.content??'');
  if(chunk.usage) await appendFile(${JSON.stringify(join(root, 'receipts.jsonl'))},JSON.stringify({phase:process.env.NAMZU_NATURAL_PHASE,preparation,...(preparation?{text:preparationText}:{}),usage:chunk.usage})+'\\n');
  yield chunk;
 }
};return created;};`);
// Offline controls, and the optional initial observation, script only model
// decisions. All file tools and persistence remain production implementations.
await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
const parse=c=>{const s=String(c);return JSON.parse(s.slice(s.indexOf('{'),s.lastIndexOf('}')+1));};
ProviderRegistry.create=()=>{let step=0;return {provider:{id:'scripted',name:'scripted',async *chatStream(params){
 const phase=process.env.NAMZU_NATURAL_PHASE; const last=params.messages.filter(m=>m.role==='tool').at(-1); let turn;
if(phase==='1') {
 const index=step++;
 turn=index===0?{toolCalls:[{id:'initial-read',name:'read',args:{path:'sevkiyatlar.txt'}}]}:
 ${progressUpdates} && index<=7 ? {text:'Inspection progress '+index+'.',toolCalls:[{id:'progress-'+index,name:'glob',args:{path:'.',pattern:'sevkiyatlar.txt'}}]}:
 {text:${JSON.stringify(progressUpdates ? 'Inspection completed.' : referential ? 'DELTA kaydı, takip kodu ve hedef depo bilgisi içeriyor.' : 'Döküm sevkiyat denetim kayıtlarını içeriyor.')}};
}
 else if(phase==='3')turn=step++===0?{toolCalls:[{id:'current-read',name:'read',args:{path:'sevkiyatlar.txt'}}]}:{text:String(last.content)};
 else if(step++===0)turn={toolCalls:[{id:'history-search',name:'search_conversation',args:{query:'DELTA'}}]};
 else {const page=parse(last.content);if(last.toolCallId.startsWith('history-search')){
 const match=page.matches?.find(m=>m.toolName==='read')??page.matches?.[0];
 turn=match?{toolCalls:[{id:'history-read',name:'read_conversation',args:{runId:match.runId,seq:match.seq,part:match.part,byteOffset:match.byteOffset}}]}:{toolCalls:[{id:'history-search-'+step,name:'search_conversation',args:{query:'DELTA',cursor:page.nextCursor}}]};
 }else turn={text:page.text};}
 yield* new MockLLMProvider({turns:[turn]}).chatStream(params);
}}};};`);

const builtFiles=['packages/sdk/dist/runtime/query/callback-inference.js','packages/sdk/dist/runtime/query/iteration/index.js','packages/sdk/dist/run/evidence-query.js','packages/sdk/dist/run/evidence-recall.js','packages/sdk/dist/store/evidence/disk.js','packages/sdk/dist/store/evidence/linked.js','packages/sdk/dist/store/evidence/selection.js','packages/cli/dist/integrations/sessions/evidence-recall.js','packages/cli/dist/integrations/sessions/conversation-search.js','packages/cli/dist/commands/run-stream.js','packages/cli/dist/tui/agent.js'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(builtFiles.map(async path=>[path,createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex')])));
const report = { root, live, checkCurrent, recallEvidence, referential, scriptedObservation, progressUpdates, queryAblation, resolveEvidenceQueries, checkTopic, provider: live ? 'codex' : 'scripted', model: live ? 'gpt-5.6-luna' : 'scripted', effort: 'low', original, replacement, turns: [], buildBefore:await fingerprints() };
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
    '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', phase===1 && progressUpdates ? '12' : referential ? '4' : '6', '--token-budget', String(tokenBudget), prompt];
  const before = new Set((phase === 1 ? [] : await allEvents()).map(e=>e.runId));
  const scripted = !live || (phase===1 && scriptedObservation);
  const record = { phase, prompt, args, tokenBudget, scripted };
  report.turns.push(record);
  let result;
  try {
    result = await exec(process.execPath, ['--import', scripted ? preload : observer, cli, ...args], {
      cwd, env: {...process.env, NAMZU_HOME:home, NAMZU_NATURAL_PHASE:String(phase)}, timeout:referential ? 120_000 : 180_000, maxBuffer:2_000_000,
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
  record.mainMessageTokens = record.requestUsage.reduce((n,u)=>n+u.totalTokens,0);
  record.totalTokens = record.done?.budget?.ownTokens;
  record.auxiliaryTokens = record.totalTokens === undefined ? undefined : record.totalTokens-record.mainMessageTokens;
  record.cachedTokens = record.requestUsage.reduce((n,u)=>n+(u.cachedTokens??0),0);
  return {record, events};
}

try {
  const first = await turn(referential ? 'sevkiyatlar.txt dosyasındaki DELTA kaydını incele; yalnızca hangi tür bilgileri içerdiğini bir cümleyle söyle.' : 'sevkiyatlar.txt dosyasının tamamını incele; yalnızca hangi tür kayıtlar içerdiğini bir cümleyle söyle.', 1, 25_000);
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
    progressUpdates: first.events.filter(e=>e.type==='message_completed' && String(e.content??'').startsWith('Inspection progress ')).length,
  };
  if(!capturedBoth || !report.prerequisites.initialCompleted || !report.prerequisites.initialSourceUnchanged || !report.prerequisites.successfulInitialRead || visibleOriginalCount!==0)
    throw new Error('Initial observation is ineligible for a missing-detail recall trial.');
  if(progressUpdates && report.prerequisites.progressUpdates!==7) throw new Error('Expected seven recorded progress messages.');
  await writeFile(file, replacementText);
  if(queryAblation){
    process.env.NAMZU_HOME=home;
    const {openSessions,resolveConversation,loadConversation}=await import('../../packages/cli/dist/integrations/sessions/store.js');
    const {createConversationEvidenceRecall}=await import('../../packages/cli/dist/integrations/sessions/evidence-recall.js');
    const {createUserMessage,generateRunId}=await import(sdkURL);
    const sessions=await openSessions(cwd);const sessionId=await resolveConversation(sessions,'natural-recall');
    const messages=await loadConversation(sessions,sessionId);
    const recall=createConversationEvidenceRecall(sessions,sessionId,()=>{});
    const archiveDir=join(home,'sessions',sessionId,'runs');
    const archivePaths=(await readdir(archiveDir,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>join(archiveDir,e.name,'transcript.jsonl'));
    const archiveHashes=async()=>Promise.all(archivePaths.map(async path=>createHash('sha256').update(await readFile(path)).digest('hex')));
    const before=await archiveHashes();report.queryAblations=[];
    for(const [label,query] of [
      ['referential','Az önce baktığın kaydın iki kimliğini aynen yazar mısın?'],
      ['previous-operator',first.record.prompt],
      ['oracle-standalone','Az önce incelediğin DELTA siparişinin takip kodu ve hedef deposu neydi?'],
      ['new-topic','Akdeniz ikliminin özellikleri nelerdir?'],
    ]){
      const operator=createUserMessage(query);
      const result=await recall({runId:generateRunId(),stepNumber:1,steps:[],messages:[...messages,operator],latestUserMessage:operator,prepared:{}});
      const text=result?.context??'';
      report.queryAblations.push({label,query,contextChars:text.length,originals:Object.values(original).map(code=>text.includes(code)),metadata:text?JSON.parse(text.split('\n')[1]):null});
    }
    report.ablationArchivesUnchanged=JSON.stringify(before)===JSON.stringify(await archiveHashes());
    if(!report.ablationArchivesUnchanged)throw new Error('Read-only query ablation changed archive transcripts.');
  }
  const second = await turn(referential ? 'Az önce baktığın kaydın iki kimliğini aynen yazar mısın?' : 'Az önce incelediğin dökümde DELTA siparişinin takip kodu ve hedef deposu neydi?', 2, referential ? 30_000 : 50_000);
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
    const current = await turn(referential ? 'Şimdi aynı dosyadaki güncel iki kimliği söyle.' : 'Peki aynı siparişin güncel dökümdeki takip kodu ve hedef deposu ne?', 3, 25_000);
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
  if(checkTopic){
    const topic=await turn('Akdeniz ikliminin özelliklerini bir cümleyle anlat.',4,15_000);
    const topicText=topic.record.done?.text??'';
    const unrelated=Object.values(original).concat(Object.values(replacement));
    report.topicCheck={answer:topicText,sourceUnchanged:await readFile(file,'utf8')===replacementText,containsShippingIds:unrelated.some(id=>topicText.includes(id)),stopReason:topic.record.done?.stopReason};
    report.topicCheck.passed=!report.topicCheck.containsShippingIds&&report.topicCheck.sourceUnchanged&&!topic.record.processError&&topic.record.errors.length===0&&topic.record.done?.stopReason==='end_turn';
  }
  report.historicalPassed=report.passed;
  report.passed=report.passed&&report.currentCheck?.passed!==false&&report.topicCheck?.passed!==false;
  if(!report.passed)process.exitCode=1;
} catch(error) {report.passed=false;report.error=String(error.message);process.exitCode=1;}
finally {
  report.buildAfter=await fingerprints();
  report.buildStable=JSON.stringify(report.buildBefore)===JSON.stringify(report.buildAfter);
  if(!report.buildStable){report.passed=false;report.error='Built modules changed during the experiment.';process.exitCode=1;}
  try {report.receipts=(await readFile(join(root,'receipts.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);} catch(error){if(error.code!=='ENOENT')throw error;}
  try {report.requests=(await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);} catch(error){if(error.code!=='ENOENT')throw error;}
  report.fingerprints={};
  for(const path of ['packages/sdk/src/runtime/query/callback-inference.ts','packages/sdk/src/runtime/query/iteration/index.ts','packages/sdk/src/run/evidence-query.ts','packages/sdk/src/run/evidence-recall.ts','packages/cli/src/integrations/sessions/evidence-recall.ts','packages/sdk/src/prompt/coding-agent-doctrine.ts','packages/sdk/src/runtime/query/tool-output-budget.ts','packages/cli/src/integrations/sessions/conversation-search.ts','packages/cli/src/tui/agent.ts','packages/cli/src/commands/run-stream.ts','research/conversation-evidence/natural-cli.mjs'])
    report.fingerprints[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({root,live,passed:report.passed,prerequisites:report.prerequisites,observations:report.observations,currentCheck:report.currentCheck,turns:report.turns.map(t=>({phase:t.phase,calls:t.calls,totalTokens:t.totalTokens})),error:report.error}));
}
