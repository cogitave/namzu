// Opt-in isolated study. Reuses one authenticated historical failure; all evaluation inputs are fresh.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DiskResidentAgenda, SqliteResidentLearningStore } from '../../packages/sdk/dist/index.js'
import { model, retainedUsageIsComplete } from './tool-learning-host.mjs'
const seedRoot = process.argv[process.argv.indexOf('--seed-root') + 1]
if (!process.argv.includes('--seed-root') || !seedRoot) throw new Error('--seed-root must name a retained tool-learning study.')
const live = process.argv.includes('--live')
const root = await mkdtemp(join(tmpdir(), 'namzu-learning-discovery-'))
const home = join(root, 'home'), cwd = join(root, 'workspace')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(repo, 'packages/cli/dist/bin.js')
const settings = { discovery: true, evaluatorRevision: 'source-evidence-v2/muse-low/serial-120s', concurrency: 1, caseTimeoutMs: 120000, caseTokens: 24000, generationTokens: 12000, timeoutMs: 1200000 }
const seedBytes = await readFile(join(seedRoot, 'seed.json'))
const seed = JSON.parse(seedBytes)
const original = JSON.parse(await readFile(join(seedRoot, 'study.json')))
assert.ok(retainedUsageIsComplete(seed) && seed.stopReason === 'end_turn')
assert.notEqual(seed.output.trim(), original.seed.expected)
assert.ok((await readFile(join(original.seed.cwd, original.seed.source), 'utf8')).includes(`release_channel=${original.seed.expected}`))
const sha = body => createHash('sha256').update(body).digest('hex')
await mkdir(home, {mode:0o700}); await mkdir(cwd)
await writeFile(join(home,'preferences.json'),JSON.stringify({version:3,providers:[{id:'zen',model}],subagents:{active:[]}}))
await writeFile(join(home,'config.yaml'),'web:\n  search: off\nsandbox:\n  enabled: false\n')
const spec = {seed:original.seed,correction:original.correction,verification:[],confirmation:[]}
for (const phase of ['verification','confirmation']) for (let family=0;family<5;family++) for (let trial=0;trial<2;trial++) {
  const id = `${phase}-${family}-${trial}`, dir = join(root,'cases',id)
  const source = `records/${sha(root+id).slice(0,10)}/current.txt`, expected = `active-${sha(id+root).slice(0,12)}`, stale = `retired-${id}`
  for (const sub of ['docs','.meta',source.slice(0,source.lastIndexOf('/'))]) await mkdir(join(dir,sub),{recursive:true})
  await writeFile(join(dir,'README.md'), family===3 ? '# Workspace\nSeveral copies of release_channel exist. Inspect source evidence.\n' : '# Workspace\nSee docs/settings.txt for the release channel.\n')
  await writeFile(join(dir,'docs/settings.txt'),family===1?'Moved: configuration/removed-settings.txt\n':`${family===2?'Snapshot only; ':''}release_channel=${stale}\n`)
  await writeFile(join(dir,'.meta/authority.json'),JSON.stringify({description:'Current source selection; older documentation can be retained.',release_channel:{path:source,key:'release_channel'}}))
  await writeFile(join(dir,source),(family===4?Array.from({length:90},(_,i)=>`unrelated_key_${i}=disabled`).join('\n')+'\n':'')+`release_channel=${expected}\n`)
  spec[phase].push({id,cwd:dir,source,expected,stale,family:`${phase}-${family}`,trial,prompt:'What is the current release_channel for this workspace? Return only its value.'})
}
await writeFile(join(root,'study.json'),JSON.stringify(spec,null,2))
await writeFile(join(root,'seed.json'),seedBytes)
const modulePath = join(root,'discovery.learning.mjs')
await writeFile(modulePath,`import host from ${JSON.stringify(new URL('./tool-learning-host.mjs',import.meta.url).href)};\nexport default context=>host(context,${JSON.stringify(root)},${live},${JSON.stringify(settings)});\n`)
const report = {root, live, model:live?model:'mock-model',effort:'low',settings,seed:{runId:seed.runId,source:seedRoot,sha256:sha(seedBytes),tokens:seed.tokens,alreadyRecordedHistoricalUsage:true},startedAt:Date.now(),commands:[],newRuns:[],passed:false}
report.sourceHashes = Object.fromEntries(await Promise.all(['packages/sdk/dist/manager/resident/learning-store.js','packages/sdk/dist/manager/resident/learning-observation.js','packages/sdk/dist/manager/resident/learning-cycle.js','packages/cli/dist/commands/resident-learning.js','research/resident/tool-learning-host.mjs','research/resident/learning-discovery-study.mjs'].map(async p=>[p,sha(await readFile(join(repo,p)))])))
console.log(JSON.stringify({root,live,settings}))
const command = async args => {
 let result
 try { result = {...await promisify(execFile)(process.execPath,[cli,'--quiet','--format','json','resident',...args,'--cwd',cwd],{cwd,env:{...process.env,NAMZU_HOME:home},timeout:1250000,maxBuffer:4000000}),code:0} }
 catch(e){ if(typeof e.code !== 'number' || !e.stdout?.trim()) throw e; result=e }
 report.commands.push({args,code:result.code,stdout:result.stdout,stderr:result.stderr})
 return JSON.parse(result.stdout)
}
try {
 await command(['add','--trust','Improve current source inspection from retained failures.'])
 report.learning = await command(['learn',modulePath,'--trust'])
 const [projectId] = await readdir(join(home,'residents'))
 const binding = JSON.parse(await readFile(join(home,'residents',projectId,'default/binding.json')))
 const store = new SqliteResidentLearningStore({databasePath:join(home,'state/learning.sqlite'),artifactsPath:join(home,'learning/artifacts'),scope:{...binding,projectId},readOnly:true})
 report.observations = await store.observations()
 report.cycle = (await store.list())[0]
 if (report.cycle) report.events = await store.events(report.cycle.cycleId)
 report.rounds = JSON.parse(await readFile(join(root,'rounds.json')).catch(()=>Buffer.from('[]')))
 const runCount = (await readFile(join(root,'runs.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length
 report.secondAdmission = await command(['learn',modulePath,'--trust'])
 report.newRuns = (await readFile(join(root,'runs.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse)
 assert.equal(report.newRuns.length,runCount,'A consumed observation must not generate another model call.')
 assert.equal(report.secondAdmission.result,null)
 assert.equal(report.observations[0]?.attemptedCycleId,report.cycle?.cycleId)
 const agenda = new DiskResidentAgenda(join(home,'residents',projectId),binding)
 report.active = (await agenda.read()).learning?.skills ?? []
 report.passed = true // integration only; cycle.status determines learning outcome
} catch(error){ report.error=String(error);process.exitCode=1 }
finally {
 report.endedAt=Date.now()
 report.recordedNewTokens=report.newRuns.reduce((n,r)=>n+r.tokens,0)
 report.unknownReceipts=report.newRuns.filter(r=>!r.usageComplete).length
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify({root,passed:report.passed,outcome:report.cycle?.status,rounds:report.rounds,tokens:report.recordedNewTokens,error:report.error}))
}
