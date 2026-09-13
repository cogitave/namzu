import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = await mkdtemp(join(tmpdir(), 'namzu-text-phases-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
await mkdir(home)
await mkdir(cwd)
await writeFile(join(cwd, 'note.txt'), 'Observed fixture record.\n')
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'codex', model: 'gpt-5.6-luna' }], subagents: { active: [] } }))
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\nmemory:\n  recall: false\ncompaction:\n  recallEvidence: false\n')
const sdk = new URL('../../packages/sdk/dist/index.js', import.meta.url).href
const provider = new URL('../../packages/providers/openai/dist/index.js', import.meta.url).href
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const preload = join(root, 'native-fixture.mjs')
await writeFile(preload, `import {ProviderRegistry} from ${JSON.stringify(sdk)};
import {CodexProvider} from ${JSON.stringify(provider)};
import {randomUUID} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
ProviderRegistry.create=()=>{
 const provider=new CodexProvider({accessToken:'fixture',accountId:'fixture'});
 let step=0; const callId=randomUUID();
 provider.client={responses:{create:async (request)=>{
  const messages=request.input.filter(x=>x.type==='message');
  const phases=messages.filter(x=>x.phase).map(x=>({id:x.id,phase:x.phase,text:x.content}));
  await appendFile(${JSON.stringify(join(root, 'requests.jsonl'))},JSON.stringify({verify:!!process.env.NAMZU_VERIFY_PHASE_REPLAY,step,phases,toolOutputs:request.input.filter(x=>x.type==='function_call_output')})+'\\n');
  const message=(id,phase,text)=>({id,type:'message',role:'assistant',status:'completed',phase,content:[{type:'output_text',text,annotations:[]}]});
  let output;
  if(process.env.NAMZU_VERIFY_PHASE_REPLAY){
   if(!phases.some(x=>x.phase==='commentary')||!phases.some(x=>x.phase==='final_answer')||!request.input.some(x=>x.type==='function_call_output'))throw new Error('Native phase/tool replay was lost.');
   output=[message(randomUUID(),'final_answer','RESUMED')];
  }else if(step++===0){
   output=[message(randomUUID(),'commentary','Inspecting record.'),{id:callId,type:'function_call',call_id:callId,name:'read',arguments:'{"path":"note.txt"}',status:'completed'}];
  }else{
   if(!phases.some(x=>x.phase==='commentary'))throw new Error('Tool follow-up lost commentary replay.');
   output=[message(randomUUID(),'commentary','Which record?'),message(randomUUID(),'final_answer','Which record?')];
  }
  return (async function*(){
   yield {type:'response.created',response:{id:'fixture-response'}};
   for(const [output_index,item] of output.entries()){
    yield {type:'response.output_item.added',output_index,item};
    if(item.type==='message')yield {type:'response.output_text.delta',output_index,item_id:item.id,content_index:0,delta:item.content[0].text};
    yield {type:'response.output_item.done',output_index,item};
   }
   yield {type:'response.completed',response:{id:'fixture-response',output,usage:{input_tokens:10,output_tokens:5}}};
  })();
 }}};
 return {provider};
};`)

const turns = []
for (const verify of [false, true]) {
	const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload, cli,
		'--quiet', 'run-stream', '--session', 'phase-replay', '--trust', '--cwd', cwd,
		'--provider', 'codex', '--model', 'gpt-5.6-luna', '--effort', 'low', '--max-iterations', '4', '--token-budget', '25000',
		verify ? 'Resume the earlier observation.' : 'Read note.txt and ask which record I mean.',
	], { cwd, env: { ...process.env, NAMZU_HOME: home, ...(verify ? { NAMZU_VERIFY_PHASE_REPLAY: '1' } : {}) }, timeout: 30000 })
	await writeFile(join(root, verify ? 'resumed.ndjson' : 'initial.ndjson'), stdout)
	const events = stdout.trim().split('\n').map(JSON.parse)
	assert.equal(events.some((e) => e.kind === 'error'), false)
	const done = events.findLast((e) => e.kind === 'done')
	assert.equal(done?.stopReason, 'end_turn')
	assert.equal(done.text, verify ? 'RESUMED' : 'Which record?')
	const calls = events.filter((e) => e.kind === 'tool-start')
	assert.equal(calls.length, verify ? 0 : 1)
	turns.push({ verify, done, calls, deltas: events.filter((e) => e.kind === 'delta') })
}
assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), 'Observed fixture record.\n')
const result = { root, home, cwd, cli, preload, turns, liveTokens: 0, fixtureUsageOnly: true,
	requests: (await readFile(join(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) }
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
