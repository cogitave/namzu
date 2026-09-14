import assert from 'node:assert/strict'
import test from 'node:test'
import { configuration, preview, suite } from './exploration-policy-environment.mjs'

test('different environments require different rules, not just copied constants', () => {
  const record = { kind: 'invoice', id: '00Az', date: '2027-03-17', sealed: false }
  for (const [family, fragment] of [['year', '/2027/'], ['month', '/2027/03/'], ['day', '/2027/03/17/']]) {
    const config = configuration('seed', family)
    assert.ok(preview(config, record).includes(fragment))
    assert.ok(!preview(config, { ...record, sealed: true }).includes('/2027/'))
  }
  assert.equal(preview(configuration('seed', 'identity'), record).split('/').length, 2)
  assert.equal(preview(configuration('seed', 'kind'), record).split('/').length, 3)
})
test('rounds use new inputs and per-episode opaque namespaces', () => {
  const a = suite('seed', 'verification'), b = suite('seed', 'confirmation')
  assert.equal(new Set([...a, ...b].map(e => e.config.root)).size, 20)
  assert.equal(new Set([...a, ...b].flatMap(e => e.tests.map(r => r.id))).size, 120)
  for (const e of [...a, ...b]) assert.deepEqual(e.expected, e.tests.map(r => preview(e.config, r)))
})
