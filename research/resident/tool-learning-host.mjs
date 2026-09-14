// Host-owned real-tool experiment. It never installs a provider or changes personal state.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as sdk from '../../packages/sdk/dist/index.js'
import { evidenceVersion, scoreSourceObservation } from './tool-learning-evidence.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const model = 'muse-spark-1.3-contributor-free'
const base =
  'Inspect the workspace to answer the question using its current source. Files may contain older copies. Use read, glob or grep as needed. Return only the requested value, without prose or Markdown. Do not change files.'
export function usageIsComplete(run) {
  const b = run.budget
  return Number.isFinite(run.endedAt) && !!b && !b.poisoned &&
    b.inFlightRequests === 0 && b.unsettledChildren === 0 && b.unresolvedRequests === 0 &&
    b.ownTokens === run.tokenUsage.totalTokens
}

export function retainedUsageIsComplete(record) {
  const b = record.budget
  return record.usageComplete === true && !!b && !b.poisoned && b.inFlightRequests === 0 && b.unsettledChildren === 0 && b.unresolvedRequests === 0 && b.ownTokens === record.tokens
}

export async function executeCase(
  root,
  fixture,
  guidance,
  label,
  live,
  signal,
  context,
  store,
  scripted = false,
  limits = {},
) {
  const tools = new sdk.ToolRegistry()
  const calls = []
  tools.register(
    sdk
      .getBuiltinTools()
      .filter((t) => ['read', 'glob', 'grep'].includes(t.name))
      .map((tool) => ({
        ...tool,
        execute: async (input, runtime) => {
          try {
            const result = await tool.execute(input, runtime)
            calls.push({ name: tool.name, input, success: result.success, output: result.output })
            return result
          } catch (error) {
            calls.push({ name: tool.name, input, success: false, error: String(error) })
            throw error
          }
        },
      })),
  )
  const { ZenProvider } = live ? await import('../../packages/providers/zen/dist/index.js') : {}
  const provider = live
    ? new ZenProvider({ model })
    : new sdk.MockLLMProvider({
        turns: [
          {
            toolCalls: [
              { id: 'read-authority', name: 'read', args: { path: '.meta/authority.json' } },
            ],
          },
          { toolCalls: [{ id: 'read-source', name: 'read', args: { path: fixture.source } }] },
          { text: scripted ? fixture.expected : fixture.stale },
        ],
      })
  const start = Date.now()
  await appendFile(
    join(root, 'attempts.jsonl'),
    JSON.stringify({ label, kind: 'started', at: start }) + '\n',
  )
  const result = await sdk.runAgent({
    provider,
    model: live ? model : 'mock-model',
    effort: 'low',
    workingDirectory: fixture.cwd,
    pathBuilder: new sdk.DefaultPathBuilder(join(root, 'sdk-state', hash(label))),
    tools,
    instructions: `${base}\n${guidance}`,
    prompt: fixture.prompt,
    maxIterations: 8,
    tokenBudget: limits.tokens ?? 18000,
    timeoutMs: limits.timeoutMs ?? 45000,
    signal,
  })
  assert.ok(
    !(await readdir(fixture.cwd)).includes('.namzu'),
    'Runtime state must remain outside the measured workspace.',
  )
  const run = result.run
  const record = {
    label,
    runId: run.id,
    model: live ? model : 'mock-model',
    effort: 'low',
    output: result.output,
    stopReason: run.stopReason,
    lastError: run.lastError,
    lastProviderError: run.lastProviderError,
    tokens: run.tokenUsage.totalTokens,
    budget: run.budget,
    usageComplete: usageIsComplete(run),
    evidenceVersion,
    cost: run.costInfo,
    durationMs: Date.now() - start,
    tools: calls,
  }
  await appendFile(join(root, 'runs.jsonl'), JSON.stringify(record) + '\n')
  if (context) {
    await context.recordUsage({
      runId: run.id,
      tokens: record.usageComplete ? record.tokens : null,
      costUsd:
        record.usageComplete && run.costInfo?.unpricedTokens === 0
          ? run.costInfo.totalCost
          : null,
    })
    await store.putArtifact(context.cycleId, `run-${run.id}`, record)
  }
  return record
}

export default async function createHost(host, root, live, settings = {}) {
  const spec = JSON.parse(await readFile(join(root, 'study.json'), 'utf8'))
  const seed = JSON.parse(await readFile(join(root, 'seed.json'), 'utf8'))
  // No model request during factory loading. All owned requests are inside callbacks.
  const trace = JSON.stringify({
    prompt: spec.seed.prompt,
    tools: seed.tools,
    output: seed.output,
    expected: spec.seed.expected,
    correction: spec.correction,
  })
  assert.ok(trace.length <= 32000)
  let count = 0
  const summaries = []
  const signal = AbortSignal.any([host.signal, AbortSignal.timeout(settings.timeoutMs ?? 600000)])
  if (settings.discovery) {
    if (!retainedUsageIsComplete(seed) || seed.stopReason !== 'end_turn' || seed.output.trim() === spec.seed.expected)
      throw new Error('Discovery requires a settled, independently checked seed failure.');
    await host.store.observe({
      runId: seed.runId, taskKey: 'source-map/seed-v0', skillName: 'workspace-source-selection',
      evaluatorRevision: settings.evaluatorRevision, baselineRevision: 'none',
      outcome: 'failed', usageComplete: true,
      evidence: { key: seed.runId, source: 'retained-sdk-run', reason: 'Returned the retired value instead of the current source value.' }, trace,
    });
  }
  return {
    ...(settings.discovery ? { evaluators: [{ skillName: 'workspace-source-selection', evaluatorRevision: settings.evaluatorRevision }] } : {}),
    skillName: 'workspace-source-selection',
    failure: {
      evidence: {
        key: seed.runId,
        source: 'retained-sdk-run',
        reason:
          seed.stopReason === 'end_turn'
            ? 'The independently checked workspace value differed from the returned answer.'
            : 'The source inspection did not produce a settled answer; execution details remain in the retained run.',
      },
      trace,
    },
    resources: { unit: 'tokens', maxUnits: 800000 },
    generate: async (context) => {
      await host.store.putArtifact(context.cycleId, 'observed-failure', seed)
      await host.store.putArtifact(context.cycleId, 'host-specification', spec)
      const { ZenProvider } = live ? await import('../../packages/providers/zen/dist/index.js') : {}
      const candidate = {
        name: 'workspace-source-selection',
        description: 'Find the current source in this workspace family.',
        body: spec.correction,
      }
      const provider = live
        ? new ZenProvider({ model })
        : new sdk.MockLLMProvider({ responseText: JSON.stringify(candidate) })
      const generated = await sdk.runAgent({
        provider,
        model: live ? model : 'mock-model',
        effort: 'low',
        workingDirectory: host.cwd,
        pathBuilder: new sdk.DefaultPathBuilder(join(root, 'sdk-state', 'generation')),
        tools: new sdk.ToolRegistry(),
        instructions:
          'Derive reusable instructions from the retained failure and authoritative correction. Return only JSON with name, description, body. name must be workspace-source-selection. Do not hardcode sample values or sample-specific leaf paths. Do not claim evaluation success.',
        prompt: context.failure.trace,
        maxIterations: 1,
        tokenBudget: settings.generationTokens ?? 3000,
        timeoutMs: settings.caseTimeoutMs ?? 45000,
        signal,
      })
      const r = generated.run
      const retained = {
        label: 'generate',
        runId: r.id,
        output: generated.output,
        stopReason: r.stopReason,
        lastError: r.lastError,
        lastProviderError: r.lastProviderError,
        tokens: r.tokenUsage.totalTokens,
        budget: r.budget,
        usageComplete: usageIsComplete(r),
        evidenceVersion,
        cost: r.costInfo,
        tools: [],
      }
      await appendFile(join(root, 'runs.jsonl'), JSON.stringify(retained) + '\n')
      await context.recordUsage({
        runId: r.id,
        tokens: retained.usageComplete ? r.tokenUsage.totalTokens : null,
        costUsd:
          retained.usageComplete && r.costInfo?.unpricedTokens === 0
            ? r.costInfo.totalCost
            : null,
      })
      await host.store.putArtifact(context.cycleId, `run-${r.id}`, retained)
      if (r.stopReason !== 'end_turn') throw new Error(`Generation ended with ${r.stopReason}.`)
      return {
        candidate: JSON.parse(
          generated.output.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u, '$1'),
        ),
        usageComplete: retained.usageComplete,
      }
    },
    evaluate: async (context) => {
      const phase = context.stage
      const fixtures = spec[phase]
      const reports = {}
      const receipts = []
      // Rotate arm order between rounds; each case starts with a new tool registry/history.
      const arms = settings.discovery ? ['frozen', 'guidance'] : ['frozen', 'memory', 'guidance']
      for (const arm of phase === 'verification' ? arms : [...arms].reverse()) {
        const guidance =
          arm === 'memory'
            ? `Retained experience: ${trace}`
            : arm === 'guidance'
              ? context.candidate.body
              : (context.baseline?.body ?? '')
        reports[arm] = await sdk.runExperiment({
          name: `${phase}/${arm}`,
          cases: fixtures.map((f) => ({ name: f.id, input: f, expected: f.expected })),
          concurrency: settings.concurrency ?? 2,
          timeoutMs: (settings.caseTimeoutMs ?? 45000) + 5000,
          passThreshold: 1,
          run: async (fixture, _case, caseSignal) => {
            assert.ok(++count <= 60)
            const record = await executeCase(
              root,
              fixture,
              guidance,
              `${phase}/${arm}/${fixture.id}`,
              live,
              AbortSignal.any([signal, caseSignal]),
              context,
              host.store,
              arm !== 'frozen',
              { tokens: settings.caseTokens, timeoutMs: settings.caseTimeoutMs },
            )
            receipts.push(record)
            return {
              output: record.output,
              steps: [],
              toolCalls: record.tools
                .filter((t) => t.success)
                .map((t) => ({ name: t.name, input: t.input, output: t.output })),
              stopReason: record.stopReason,
              totalTokens: record.tokens,
              totalCostUsd: record.cost?.totalCost ?? 0,
              durationMs: record.durationMs,
            }
          },
          scorers: [
            {
              name: 'observed-source',
              severity: 'gate',
              threshold: 1,
              score: scoreSourceObservation,
            },
          ],
        })
      }
      const trials = (arm) =>
        reports[arm].cases.map((result, i) => ({
          taskId: fixtures[i].family,
          trial: fixtures[i].trial,
          conditions: hash({
            phase,
            fixture: fixtures[i],
            model: live ? model : 'mock-model',
            effort: 'low',
            tools: ['read', 'glob', 'grep'],
            settings,
          }),
          trajectoryId: `${phase}/${arm}/${fixtures[i].id}`,
          result,
        }))
      const baseline = trials('frozen'),
        candidate = trials('guidance')
      const attributions = [...new Set(fixtures.map((f) => f.family))].flatMap((taskId) => {
        const before = baseline.filter((t) => t.taskId === taskId),
          after = candidate.filter((t) => t.taskId === taskId)
        const b = before.filter((t) => t.result.passed).length,
          c = after.filter((t) => t.result.passed).length
        return b === c
          ? []
          : [
              {
                taskId,
                effect: c > b ? 'improvement' : 'regression',
                reason: `Independent source/output checks: baseline ${b}/2, guidance ${c}/2.`,
                baselineTrajectories: before.map((t) => t.trajectoryId),
                candidateTrajectories: after.map((t) => t.trajectoryId),
              },
            ]
      })
      const batch = {
        baselineRevision: context.baselineRevision,
        candidateRevision: context.candidateRevision,
        baseline,
        candidate,
        attributions,
      }
      await host.store.putArtifact(context.cycleId, `${phase}-all-arms`, reports)
      summaries.push({
        phase,
        scores: Object.fromEntries(
          Object.entries(reports).map(([arm, r]) => [
            arm,
            { passed: r.passed, failed: r.failed, inconclusive: r.inconclusive },
          ]),
        ),
      })
      await writeFile(join(root, 'rounds.json'), JSON.stringify(summaries, null, 2))
      process.stderr.write(JSON.stringify(summaries.at(-1)) + '\n')
      return {
        batch,
        usageComplete: receipts.length === fixtures.length * arms.length && receipts.every((r) => r.usageComplete),
      }
    },
  }
}
