import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateEpisode } from './exploration-policy-host.mjs'
import { episode, baselinePolicy } from './exploration-policy-environment.mjs'

test('a provider failure retains its attempt and prevents predictor and later work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'namzu-policy-fault-test-'))
  try {
    await assert.rejects(evaluateEpisode(root, { live: false, controlProviderError: true, limits: { records: 8, explorationIterations: 6, explorationTokens: 16000, predictionTokens: 12000 } }, episode('seed', 'verification', 'month', 0), 'baseline', baselinePolicy), /Study execution stopped|Unsettled usage/)
    const attempts = (await readFile(join(root, 'attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    const runs = (await readFile(join(root, 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(attempts.length, 1)
    assert.equal(runs.length, 1)
    assert.ok(attempts[0].label.endsWith('/explore'))
    assert.notEqual(runs[0].stopReason, 'end_turn')
    await assert.rejects(readFile(join(root, 'episodes.jsonl')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
