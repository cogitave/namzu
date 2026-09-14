import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as sdk from '../../packages/sdk/dist/index.js'
import { environment, preview, previewSchema, scriptedProbes } from './autonomous-environment.mjs'
import { usageIsComplete, model } from './tool-learning-host.mjs'

export const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const skillName = 'preview-routing'
const instructions = 'Complete the requested task using available evidence. Return only the requested answer. Preserve files. If a service rule is unknown, return UNKNOWN instead of inventing it.'

async function execute(root, spec, label, options, context, store) {
  await appendFile(join(root, 'attempts.jsonl'), `${JSON.stringify({ label, at: Date.now() })}\n`)
  const provider = spec.live
    ? new (await import('../../packages/providers/zen/dist/index.js')).ZenProvider({ model })
    : new sdk.MockLLMProvider({ turns: options.turns })
  const begin = Date.now()
  const result = await sdk.runAgent({
    provider, model: spec.live ? model : 'mock-model', effort: 'low',
    workingDirectory: options.cwd, pathBuilder: new sdk.DefaultPathBuilder(join(root, 'runs', sha(label))),
    instructions: options.instructions, prompt: options.prompt, tools: options.tools,
    maxIterations: options.iterations ?? 8, tokenBudget: options.tokens ?? 24000,
    timeoutMs: 120000, signal: context?.signal,
  })
  const run = result.run
  const record = { label, runId: run.id, output: result.output, stopReason: run.stopReason,
    tokens: run.tokenUsage.totalTokens, budget: run.budget, usageComplete: usageIsComplete(run),
    cost: run.costInfo, durationMs: Date.now() - begin, tools: options.calls ?? [],
    ...(run.lastError ? { error: run.lastError } : {}),
  }
  await appendFile(join(root, 'runs.jsonl'), `${JSON.stringify(record)}\n`)
  if (context) await context.recordUsage({ runId: run.id,
    tokens: record.usageComplete ? record.tokens : null,
    costUsd: record.usageComplete && run.costInfo?.unpricedTokens === 0 ? run.costInfo.totalCost : null })
  if (store && context) await store.putArtifact(context.cycleId, `run-${run.id}`, record)
  return record
}

export async function runCase(root, spec, fixture, arm, guidance, context, store, suffix = '') {
  const label = `${fixture.id}/${arm}${suffix}`, cwd = join(root, 'cases', sha(label)), calls = []
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'input.txt'), fixture.files['input.txt'])
  const tools = new sdk.ToolRegistry(), read = sdk.getBuiltinTools().find(tool => tool.name === 'read')
  tools.register({ ...read, execute: async (input, toolContext) => {
    if (resolve(cwd, input.path) !== join(cwd, 'input.txt')) throw new Error('Only this task input is available.')
    const result = await read.execute(input, toolContext)
    calls.push({ name: 'read', input, success: result.success, output: result.output }); return result
  } })
  const record = await execute(root, spec, label, {
    cwd, tools, calls, instructions: `${instructions}\n${guidance}`, prompt: fixture.prompt,
    turns: [ { toolCalls: [{ id: 'read-input', name: 'read', args: { path: 'input.txt' } }] },
      { text: ['baseline', 'rollback'].includes(arm) && ['invoice', 'memo', 'notice'].includes(fixture.family) ? 'UNKNOWN' : fixture.expected } ],
  }, context, store)
  const inputUnchanged = await readFile(join(cwd, 'input.txt'), 'utf8') === fixture.files['input.txt']
  const passed = record.usageComplete && record.stopReason === 'end_turn' && record.output.trim() === fixture.expected &&
    calls.some(call => call.success) && inputUnchanged
  const scored = { ...record, case: fixture.id, taskId: fixture.taskId, trial: fixture.trial,
    arm, passed, inputUnchanged, expected: fixture.expected }
  await appendFile(join(root, 'scored.jsonl'), `${JSON.stringify(scored)}\n`)
  return scored
}

export default async function createHost(host, root) {
  const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'))
  const seed = JSON.parse(await readFile(join(root, 'seed.json'), 'utf8'))
  assert.ok(seed.usageComplete && seed.stopReason === 'end_turn' && !seed.passed)
  // This trace contains only an observed failure, never its expected answer or a correction.
  const trace = JSON.stringify({ prompt: spec.seed.prompt, tools: seed.tools, output: seed.output, passed: false })
  assert.ok(!trace.includes(seed.expected))
  let observations
  return {
    skillName, protection: spec.protection, resources: { unit: 'tokens', maxUnits: 1500000 },
    failure: { evidence: { key: seed.runId, source: 'observed-preview-failure', reason: 'A cold prediction disagreed with the service.' }, trace },
    explore: async context => {
      await host.store.putArtifact(context.cycleId, 'specification', spec)
      // Cold-run usage belongs to this cycle exactly once, even though it precedes admission.
      await context.recordUsage({ runId: seed.runId, tokens: seed.tokens,
        costUsd: seed.cost?.unpricedTokens === 0 ? seed.cost.totalCost : null })
      const config = environment(spec.environmentSeed), tools = new sdk.ToolRegistry(), calls = []
      let records = 0
      tools.register(sdk.defineTool({
        name: 'preview_route', description: 'Observe the service destination for records you choose. This is a preview; it does not write files. No rule documentation is available.',
        inputSchema: sdk.mcpJsonSchemaToZod(previewSchema), category: 'other', permissions: [], readOnly: true,
        destructive: false, concurrencySafe: false,
        execute: async (input) => {
          if (records + input.records.length > 24) throw new Error('Exploration fixture allows at most 24 records.')
          records += input.records.length
          const output = JSON.stringify(input.records.map(record => ({ input: record, destination: preview(config, record) })))
          const call = { name: 'preview_route', input: structuredClone(input), success: true, output }
          calls.push(call)
          await appendFile(join(root, 'probes.jsonl'), `${JSON.stringify(call)}\n`)
          return { success: true, output }
        },
      }))
      const explored = await execute(root, spec, 'explore', {
        cwd: host.cwd, tools, calls, iterations: 12, tokens: 32000,
        instructions: 'Investigate the undocumented preview service through the provided tool. Choose your own experiments to distinguish possible rules. Use observed results to revise hypotheses. Do not claim rules you have not checked. Finish when you have enough evidence, or identify remaining uncertainty. At most 24 records can be previewed.',
        prompt: context.failure.trace,
        turns: [{ toolCalls: [{ id: 'probe', name: 'preview_route', args: { records: scriptedProbes() } }] }, { text: 'Exploration finished.' }],
      }, context, host.store)
      if (!calls.length || explored.stopReason !== 'end_turn') throw new Error(`Exploration incomplete: ${explored.stopReason}`)
      observations = { evidence: { key: explored.runId, source: 'executed-preview-tool', reason: 'Recorded service outputs for model-selected inputs.' }, trace: JSON.stringify(calls) }
      await writeFile(join(root, 'observations.json'), JSON.stringify(observations, null, 2))
      return { observations, usageComplete: explored.usageComplete }
    },
    generate: async context => {
      assert.ok(context.exploration)
      const mock = { name: skillName, description: 'Predict this workspace preview service routing from record fields.',
        body: `For preview routing only, apply this configuration: ${JSON.stringify(environment(spec.environmentSeed))}. Unsealed: root/year/month/kind-alias/id. Sealed: sealed/kind-alias/id. Preserve ID case and leading zeroes. Do not use for unrelated tasks.` }
      const generated = await execute(root, spec, 'generate', {
        cwd: host.cwd, tools: new sdk.ToolRegistry(), iterations: 1, tokens: 12000,
        instructions: `Derive reusable guidance from the recorded environment observations. There is no supplied correction. Return JSON only with name, description, body; name must be ${skillName}. Body at most 4000 characters. Separate observed rules from uncertainty. Generalize across new records rather than returning a list of sample answers. Restrict guidance to this preview service; do not claim evaluation success.`,
        prompt: JSON.stringify({ failure: context.failure, observations: context.exploration }),
        turns: [{ text: JSON.stringify(mock) }],
      }, context, host.store)
      if (generated.stopReason !== 'end_turn') throw new Error(`Generation incomplete: ${generated.stopReason}`)
      const candidate = JSON.parse(generated.output.replace(/^```(?:json)?\s*|\s*```$/g, ''))
      await writeFile(join(root, 'candidate.json'), JSON.stringify(candidate, null, 2))
      return { candidate, usageComplete: generated.usageComplete }
    },
    evaluate: async context => {
      const cases = spec[context.stage], records = []
      for (const [i, fixture] of cases.entries()) {
        const arms = ['baseline', 'memory', 'candidate']; const order = [...arms.slice(i % 3), ...arms.slice(0, i % 3)]
        for (const arm of order) {
          const guidance = arm === 'candidate' ? context.candidate.body : arm === 'memory' ? `Prior service observations:\n${observations.trace}` : ''
          records.push(await runCase(root, spec, fixture, arm, guidance, context, host.store))
        }
        console.error(JSON.stringify({ stage: context.stage, case: fixture.id, completed: records.length }))
      }
      const trials = arm => records.filter(r => r.arm === arm).map(r => ({
        taskId: r.taskId, trial: r.trial, trajectoryId: r.runId,
        conditions: sha({ fixture: cases.find(f => f.id === r.case), model: spec.live ? model : 'mock', effort: 'low', instructions, limits: spec.limits, scorer: spec.scorer }),
        result: { case: r.case, passed: r.passed, status: r.passed ? 'passed' : 'failed', mean: Number(r.passed),
          scores: { exact: { score: Number(r.passed), reason: 'Compared exact predicted service output or protected file answer; required successful input read and unchanged input.' } },
          run: { output: r.output, steps: [], toolCalls: r.tools, totalTokens: r.tokens, totalCostUsd: r.cost?.totalCost ?? 0, durationMs: r.durationMs,
            ...(!r.usageComplete || r.stopReason !== 'end_turn' ? { error: r.error ?? `Unsettled run: ${r.stopReason}` } : {}) },
        },
      }))
      const baseline = trials('baseline'), candidate = trials('candidate'), attributions = []
      for (const taskId of new Set(cases.map(f => f.taskId))) {
        const before = records.filter(r => r.taskId === taskId && r.arm === 'baseline'), after = records.filter(r => r.taskId === taskId && r.arm === 'candidate')
        const gain = after.filter(r => r.passed).length - before.filter(r => r.passed).length
        if (gain) attributions.push({ taskId, effect: gain > 0 ? 'improvement' : 'regression',
          reason: 'Independent host comparison against service outputs for withheld inputs, required input read and preserved file. Generation only received exploration observations.',
          baselineTrajectories: before.map(r => r.runId), candidateTrajectories: after.map(r => r.runId) })
      }
      await host.store.putArtifact(context.cycleId, `${context.stage}-raw-memory-control`, trials('memory'))
      return { batch: { baselineRevision: context.baselineRevision, candidateRevision: context.candidateRevision, baseline, candidate, attributions }, usageComplete: records.every(r => r.usageComplete) }
    },
  }
}
