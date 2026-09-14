import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observesCurrentSource, scoreSourceObservation } from './tool-learning-evidence.mjs'
const fixture = { cwd: '/fixture', source: 'records/current.txt', expected: 'live-value' }
const read = { name: 'read', success: true, input: { path: fixture.source }, output: '1\trelease_channel=live-value' }
const grep = { name: 'grep', success: true, input: { path: '.', pattern: 'release_channel' }, output: './records/current.txt:3:release_channel=live-value' }
test('accepts actual source evidence from read windows and scoped search results', () => {
  for (const tool of [read, grep, { ...grep, output: '/fixture/records/current.txt-3-release_channel=live-value' }])
    assert.equal(observesCurrentSource([tool], fixture), true)
})
test('rejects failed calls, wrong files, irrelevant windows, summaries and near matches', () => {
  for (const tool of [
    { ...read, success: false }, { ...read, input: { path: 'docs/old.txt' } },
    { ...read, output: '1 unrelated=true' }, { ...read, output: '1 release_channel=live-value-old' },
    { ...grep, output: './docs/old.txt:3:release_channel=live-value' },
    { ...grep, output: 'Searched records/current.txt. release_channel=live-value' },
  ]) assert.equal(observesCurrentSource([tool], fixture), false)
})
test('an exact value with evidence still requires task completion', () => {
  const run = { output: fixture.expected, toolCalls: [grep], stopReason: 'token_budget' }
  assert.equal(scoreSourceObservation(run, { input: fixture, expected: fixture.expected }).score, 0)
  assert.equal(scoreSourceObservation({ ...run, stopReason: 'end_turn' }, { input: fixture, expected: fixture.expected }).score, 1)
})

test('task failure and measurement uncertainty are separate', async () => {
  const { usageIsComplete } = await import('./tool-learning-host.mjs')
  const run = { stopReason: 'token_budget', endedAt: 1, tokenUsage: { totalTokens: 21000 }, budget: { ownTokens: 21000, poisoned: false, inFlightRequests: 0, unsettledChildren: 0, unresolvedRequests: 0 } }
  assert.equal(usageIsComplete(run), true)
  assert.equal(usageIsComplete({ ...run, budget: { ...run.budget, unresolvedRequests: 1 } }), false)
  assert.equal(usageIsComplete({ ...run, endedAt: undefined }), false)
  assert.equal(usageIsComplete({ ...run, budget: { ...run.budget, ownTokens: 0 } }), false)
})
