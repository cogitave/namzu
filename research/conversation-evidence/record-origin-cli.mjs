// Controlled archive origin probe. Seeds are scripted records; follow-up uses the real CLI.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const live = process.argv.includes('--live')
const caseName = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'conflict'
assert.ok(['conflict', 'claim-only', 'said'].includes(caseName))
const root = await mkdtemp(join(tmpdir(), 'namzu-record-origin-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
await mkdir(home)
await mkdir(cwd)
process.env.NAMZU_HOME = home
const repo = new URL('../../', import.meta.url)
const sdkURL = new URL('packages/sdk/dist/index.js', repo)
const cli = fileURLToPath(new URL('packages/cli/dist/bin.js', repo))
const { createUserMessage, RunDiskStore } = await import(sdkURL)
const { openSessions, startConversation, replaceConversation } = await import(new URL('packages/cli/dist/integrations/sessions/store.js', repo))
const sessions = await openSessions(cwd)
const sessionId = await startConversation(sessions)
await replaceConversation(sessions, sessionId, [createUserMessage('The earlier ORCHID conversation was compacted. Its records are in the conversation archive.')])
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }))
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: true\n  resolveEvidenceQueries: false\n')
const observedCode = 'OBSERVED-' + randomUUID()
const claimedCode = 'CLAIMED-' + randomUUID()
const currentFile = 'Current export does not preserve the earlier receipt.\n'
await writeFile(join(cwd, 'receipt.txt'), currentFile)
const runs = join(home, 'sessions', sessionId, 'runs')
const runId = randomUUID()
const store = new RunDiskStore({ baseDir: runs })
const dir = await store.initRun(runId)
const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
await writeFile(join(dir, 'run.json'), JSON.stringify({ id: runId, status: 'completed', metadata: { scope } }))
let seq = 1
await store.appendEvent({ type: 'run_started', runId, seq: seq++ })
if (caseName === 'conflict') await store.appendEvent({ type: 'tool_completed', runId, seq: seq++, toolName: 'read', toolUseId: 'original', isError: false, result: `ORCHID original receipt code: ${observedCode}.\n${'Export accompanying notes. '.repeat(12)}` })
for (let i = 0; i < (caseName === 'conflict' ? 4 : 1); i++) await store.appendEvent({ type: 'message_completed', runId, seq: seq++, content: `ORCHID original receipt code: ${claimedCode}. I confirmed the original ORCHID receipt code earlier. Report ${i + 1}.` })
const archived = await readFile(join(dir, 'transcript.jsonl'), 'utf8')
const files = ['packages/sdk/dist/run/evidence-recall.js', 'packages/sdk/dist/run/evidence-query.js', 'packages/cli/dist/integrations/sessions/evidence-recall.js', 'packages/cli/dist/integrations/sessions/conversation-search.js', 'packages/providers/openai/dist/codex.js']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(new URL(path, repo))).digest('hex')])))
const prompt = caseName === 'said'
 ? 'What ORCHID receipt code did you tell me earlier? I am asking what you said, not what the file actually contained.'
 : 'What was the original ORCHID receipt code in the file we read earlier? Use the earlier observation, not the current file.'
const trace = join(root, 'requests.jsonl')
const preload = join(root, 'observe.mjs')
await writeFile(preload, `import {ProviderRegistry,MockLLMProvider} from ${JSON.stringify(sdkURL.href)};
import {appendFile} from 'node:fs/promises';
const create=ProviderRegistry.create.bind(ProviderRegistry);
ProviderRegistry.create=(...args)=>{
 const result=${live ? 'create(...args)' : '({provider:new MockLLMProvider()})'};
 const stream=result.provider.chatStream.bind(result.provider);
 result.provider.chatStream=async function*(params){
  const contexts=params.messages.filter(m=>m.source?.type==='runtime-context'&&m.source.kind==='step-context');
  const context=contexts.map(m=>m.content).join('\\n');
  const record={context,text:'',usage:[],ordinaryHasCode:params.messages.filter(m=>!contexts.includes(m)).some(m=>/OBSERVED-|CLAIMED-/.test(JSON.stringify(m)))};
  try {
   const output=${live ? 'stream(params)' : "new MockLLMProvider({turns:[{text:'OFFLINE: inspected request context.'}]}).chatStream(params)"};
   for await(const chunk of output){record.text+=chunk.delta.content??'';if(chunk.textParts)record.textParts=chunk.textParts;if(chunk.usage)record.usage.push(chunk.usage);yield chunk;}
  } finally {await appendFile(${JSON.stringify(trace)},JSON.stringify(record)+'\\n');}
 };return result;
};`)
const args = ['--quiet', '--format', 'json', 'run', '--trust', '--permission-mode', 'plan', '--cwd', cwd, '--resume', sessionId, '--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '3', '--token-budget', '20000', prompt]
const report = { root, home, cwd, sessionId, runId, caseName, live, observedCode, claimedCode, prompt, args, buildBefore: await hashes() }
console.log(JSON.stringify({ root, caseName, live }))
try {
 const result = await promisify(execFile)(process.execPath, ['--import', preload, cli, ...args], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
 report.result = JSON.parse(result.stdout)
} catch (error) {
 report.error = String(error)
 if (error.stderr) report.stderr = error.stderr
 if (error.stdout) { try { report.result = JSON.parse(error.stdout) } catch { report.stdout = error.stdout } }
 process.exitCode = 1
}
try {
 report.requests = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
 assert.equal(report.requests[0].ordinaryHasCode, false)
 report.firstSelected = report.requests[0].context.split('\n').filter(line => line.startsWith('{"runId":')).map(JSON.parse)
 const invoked = (await readdir(runs, { withFileTypes: true })).filter(e => e.isDirectory() && e.name !== runId)
 assert.equal(invoked.length, 1)
 report.followupRunId = invoked[0].name
 const events = (await readFile(join(runs, invoked[0].name, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
 report.toolCalls = events.filter(e => e.type === 'tool_executing').map(e => ({ tool: e.toolName, input: e.input }))
 assert.equal(await readFile(join(dir, 'transcript.jsonl'), 'utf8'), archived)
 assert.equal(await readFile(join(cwd, 'receipt.txt'), 'utf8'), currentFile)
 report.integrityPassed = true
} catch (error) { report.integrityError = String(error); process.exitCode = 1 }
finally {
 report.buildAfter = await hashes()
 assert.deepEqual(report.buildAfter, report.buildBefore)
 await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
 console.log(JSON.stringify({ root, integrityPassed: report.integrityPassed, selectedSources: report.firstSelected?.map(p=>p.source), text: report.result?.text, tools: report.toolCalls, error: report.error }))
}
