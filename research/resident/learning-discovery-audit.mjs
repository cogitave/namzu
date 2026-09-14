// Recompute every recorded score from successful tool output. No provider calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoreSourceObservation } from './tool-learning-evidence.mjs'
const root = process.argv[2]
if (!root) throw new Error('Expected a completed learning-discovery study directory.')
const report = JSON.parse(await readFile(join(root,'report.json')))
const spec = JSON.parse(await readFile(join(root,'study.json')))
const raw = await readFile(join(root,'runs.jsonl'))
const runs = raw.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
assert.equal(report.passed,true)
assert.equal(report.secondAdmission.result,null)
assert.equal(new Set(runs.map(r=>r.runId)).size,runs.length)
const summaries = []
for (const round of report.rounds) {
 const scores = {}
 for (const arm of Object.keys(round.scores)) {
  const selected = runs.filter(r=>r.label.startsWith(`${round.phase}/${arm}/`))
  assert.equal(selected.length,spec[round.phase].length)
  const scored = selected.map(run=>{
   const fixture = spec[round.phase].find(f=>run.label===`${round.phase}/${arm}/${f.id}`)
   assert.ok(fixture)
   const score = scoreSourceObservation({output:run.output,stopReason:run.stopReason,toolCalls:run.tools},{expected:fixture.expected,input:fixture})
   return {runId:run.runId,taskId:fixture.family,trial:fixture.trial,...score.details,passed:score.score===1,tokens:run.tokens,usageComplete:run.usageComplete,stopReason:run.stopReason}
  })
  const passed = scored.filter(s=>s.passed).length
  assert.equal(passed,round.scores[arm].passed)
  scores[arm] = {passed,total:scored.length,trials:scored}
 }
 summaries.push({phase:round.phase,scores})
}
const audit = {
 study:root,live:report.live,model:report.model,effort:report.effort,settings:report.settings,
 sourceHashes:report.sourceHashes,seed:report.seed,
 outcome:report.cycle.status,cycleId:report.cycle.cycleId,candidate:report.cycle.result?.candidate,
 candidateRevision:report.cycle.candidateRevision,review:report.cycle.result?.review,
 consumption:report.cycle.result?.consumption,observations:report.observations.map(({trace,evidence,...summary})=>summary),
 rounds:summaries,modelRuns:runs.length,recordedTokens:runs.reduce((n,r)=>n+r.tokens,0),
 rawRunsSha256:createHash('sha256').update(raw).digest('hex'),
 replay:{newCalls:0,secondAdmission:report.secondAdmission},
 activated:report.active.map(s=>({name:s.name,hash:s.hash,evidence:s.evidence})),
 integrationPassed:true,
 limitation:report.live?'One retained failure plus an authoritative host correction; five narrow task families, not general intelligence or learned meta-optimization.':'Scripted inference with real tools/storage; not empirical model improvement.',
}
console.log(JSON.stringify(audit,null,2))
