import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as sdk from '../../packages/sdk/dist/index.js'
import { usageIsComplete, model } from './tool-learning-host.mjs'
import { baselinePolicy, preview, previewSchema, controlProbes } from './exploration-policy-environment.mjs'

export const sha = data => createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex')
export const skillName = 'preview-exploration-policy'
export const predictionInstructions = 'Predict this service from actual observations only. Return a JSON array of destinations in the requested order, using UNKNOWN where behavior is unknown. Do not include prose. No preview tool is available in this fresh prediction session.'
export async function execute(root, spec, label, options, context, store) {
  await appendFile(join(root, 'attempts.jsonl'), `${JSON.stringify({ label, at: Date.now() })}\n`)
  const provider = spec.live ? new (await import('../../packages/providers/zen/dist/index.js')).ZenProvider({ model }) : new sdk.MockLLMProvider({ turns: options.turns })
  const cwd = join(root, 'episodes', sha(label)); await mkdir(cwd, { recursive: true })
  const started = Date.now()
  const result = await sdk.runAgent({ provider, model: spec.live ? model : 'mock-model', effort: 'low',
    pathBuilder: new sdk.DefaultPathBuilder(join(root, 'runs', sha(label))), workingDirectory: cwd,
    instructions: options.instructions, prompt: options.prompt, tools: options.tools ?? new sdk.ToolRegistry(),
    maxIterations: options.iterations ?? 6, tokenBudget: options.tokens ?? 16000, timeoutMs: 120000,
    signal: context?.signal })
  const run = result.run
  const record = { label, runId: run.id, output: result.output, stopReason: run.stopReason,
    tokens: run.tokenUsage.totalTokens, budget: run.budget, usageComplete: usageIsComplete(run),
    cost: run.costInfo, durationMs: Date.now() - started, ...(run.lastError ? { error: run.lastError } : {}) }
  await appendFile(join(root, 'runs.jsonl'), `${JSON.stringify(record)}\n`)
  if (context) {
    await context.recordUsage({ runId: run.id, tokens: record.usageComplete ? record.tokens : null,
      costUsd: record.usageComplete && run.costInfo?.unpricedTokens === 0 ? run.costInfo.totalCost : null })
    await store.putArtifact(context.cycleId, `run-${run.id}`, record)
  }
  if (!record.usageComplete) throw new Error(`Unsettled usage for ${label}; study stops without replacement runs.`)
  if (record.stopReason !== 'end_turn') throw new Error(`Study execution stopped at ${label}: ${record.error ?? record.stopReason}. No later episode will be attempted.`)
  return record
}

export async function evaluateEpisode(root, spec, e, arm, policy, context, store) {
  const label = `${e.id}/${arm}`, calls = [], tools = new sdk.ToolRegistry()
  let used = 0
  tools.register(sdk.defineTool({ name: 'preview_route', description: 'Observe a service destination for records you choose. Behavior is undocumented. Preview is read-only. At most 8 records in total may be previewed during this episode.',
    inputSchema: sdk.mcpJsonSchemaToZod(previewSchema), category: 'other', permissions: [], readOnly: true, destructive: false, concurrencySafe: false,
    execute: async input => {
      let output, success
      try {
        if (used + input.records.length > spec.limits.records) throw new Error(`Only ${spec.limits.records - used} preview records remain.`)
        used += input.records.length
        output = JSON.stringify(input.records.map(record => ({ input: record, destination: preview(e.config, record) }))); success = true
      } catch (error) { output = String(error); success = false }
      const call = { input: structuredClone(input), output, success }
      calls.push(call); await appendFile(join(root, 'probes.jsonl'), `${JSON.stringify({ label, ...call })}\n`)
      return { output, success }
    } }))
  const explorer = await execute(root, spec, `${label}/explore`, {
    tools, instructions: `${policy}\nThe host allows at most ${spec.limits.records} records across all previews. Record kinds and fields are given by the tool schema. Treat this as a new service; previous service constants and layouts are not evidence here.`,
    prompt: 'Investigate this new service so a later independent session can predict its destinations on unseen records. You do not have its test inputs. Choose the experiments yourself.',
    turns: !spec.live && spec.controlProviderError ? [{ error: { status: 429, message: 'Scripted provider rate limit.' } }] : [{ toolCalls: [{ id: 'control-preview', name: 'preview_route', args: { records: controlProbes() } }] }, { text: 'Observed service.' }],
    tokens: spec.limits.explorationTokens, iterations: spec.limits.explorationIterations,
  }, context, store)
  const observations = calls.filter(c => c.success)
  const predictor = await execute(root, spec, `${label}/predict`, {
    instructions: predictionInstructions, prompt: JSON.stringify({ observations, records: e.tests }),
    turns: [{ text: JSON.stringify(!spec.live && ['baseline', 'rollback'].includes(arm) && !['identity', 'kind'].includes(e.family) ? e.tests.map(() => 'UNKNOWN') : e.expected) }],
    tokens: spec.limits.predictionTokens, iterations: 1,
  }, context, store)
  let actual
  try { actual = JSON.parse(predictor.output.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { actual = null }
  const correct = Array.isArray(actual) ? e.expected.filter((value, i) => value === actual[i]).length : 0
  const passed = explorer.stopReason === 'end_turn' && predictor.stopReason === 'end_turn' && Array.isArray(actual) && actual.length === e.expected.length && correct === e.expected.length
  const record = { label, episode: e.id, taskId: e.taskId, family: e.family, trial: e.trial, arm,
    explorerRunId: explorer.runId, predictorRunId: predictor.runId, passed, correct, count: e.expected.length,
    output: predictor.output, actual, expected: e.expected, probesUsed: used, calls,
    tokens: explorer.tokens + predictor.tokens, durationMs: explorer.durationMs + predictor.durationMs,
    complete: explorer.stopReason === 'end_turn' && predictor.stopReason === 'end_turn',
    policyHash: sha(policy), observationsHash: sha(observations) }
  await appendFile(join(root, 'episodes.jsonl'), `${JSON.stringify(record)}\n`)
  console.error(JSON.stringify({ episode: e.id, arm, passed, correct, probes: used }))
  return record
}

export default async function host(context, root) {
  const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'))
  const training = JSON.parse(await readFile(join(root, 'training.json'), 'utf8'))
  return { skillName, purpose: 'exploration', protection: spec.protection, resources: { unit: 'tokens', maxUnits: 1500000 },
    failure: { evidence: { key: training.sourceRunId, source: 'retained-exploration-trajectory', reason: 'Inspect the prior cold gap and actual exploration to propose a reusable learning policy.' }, trace: JSON.stringify(training) },
    generate: async stage => {
      assert.equal(stage.purpose, 'exploration')
      const generated = await execute(root, spec, 'propose-policy', {
        instructions: `Improve the procedure that chooses experiments, rather than supplying a rule for the old service. Examine the actual prior trajectory and propose a reusable exploration policy for unfamiliar services with the same record schema. Return JSON only: name ${skillName}, purpose exploration, description, body (at most 4000 characters). The new explorer will have at most 8 preview records, 6 iterations and 16000 tokens; its tool observations alone reach a separate frozen predictor. Do not claim a score or copy old service constants. You cannot change the tool, evaluator, budget or held-out inputs.`,
        prompt: JSON.stringify({ baselinePolicy, training }), iterations: 1, tokens: 12000,
        turns: [{ text: JSON.stringify({ name: skillName, purpose: 'exploration', description: 'Scripted control policy, not a learned result.', body: 'Choose informative experiments within the declared limits.' }) }],
      }, stage, context.store)
      if (generated.stopReason !== 'end_turn') throw new Error(`Proposal incomplete: ${generated.stopReason}`)
      const candidate = JSON.parse(generated.output.replace(/^```(?:json)?\s*|\s*```$/g, ''))
      await writeFile(join(root, 'candidate.json'), JSON.stringify(candidate, null, 2))
      return { candidate, usageComplete: true }
    },
    evaluate: async stage => {
      const rows = []
      for (const [i, e] of spec[stage.stage].entries()) {
        for (const arm of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          rows.push(await evaluateEpisode(root, spec, e, arm, arm === 'candidate' ? stage.candidate.body : baselinePolicy, stage, context.store))
        }
      }
      const trials = arm => rows.filter(r => r.arm === arm).map(r => ({ taskId: r.taskId, trial: r.trial,
        conditions: sha({ episode: spec[stage.stage].find(e => e.id === r.episode), limits: spec.limits, model, effort: 'low', baselinePolicy, predictionInstructions }),
        trajectoryId: r.predictorRunId, result: { case: r.episode, passed: r.passed, status: r.passed ? 'passed' : 'failed', mean: Number(r.passed),
          scores: { exact: { score: r.correct / r.count, reason: 'Host compared all six withheld service destinations after model-selected exploration.' } },
          run: { output: r.output, steps: [], toolCalls: r.calls, totalTokens: r.tokens, totalCostUsd: 0, durationMs: r.durationMs,
            ...(!r.complete ? { error: 'One stage did not complete normally.' } : {}) } } }))
      const attributions = []
      for (const taskId of new Set(rows.map(r => r.taskId))) {
        const before = rows.filter(r => r.taskId === taskId && r.arm === 'baseline'), after = rows.filter(r => r.taskId === taskId && r.arm === 'candidate')
        const delta = after.filter(r => r.passed).length - before.filter(r => r.passed).length
        if (delta) attributions.push({ taskId, effect: delta > 0 ? 'improvement' : 'regression', reason: 'Only the exploration instructions differ; a fresh frozen predictor receives actual acquired observations, with equal acquisition limits and independently scored unseen records.', baselineTrajectories: before.map(r => r.predictorRunId), candidateTrajectories: after.map(r => r.predictorRunId) })
      }
      return { batch: { baselineRevision: stage.baselineRevision, candidateRevision: stage.candidateRevision, baseline: trials('baseline'), candidate: trials('candidate'), attributions }, usageComplete: true }
    },
  }
}
