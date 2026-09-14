import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environment, fixtures, preview } from './autonomous-environment.mjs'

test('preview service preserves opaque IDs and has distinct sealed behavior', () => {
  const config = { root: 'r', sealed: 's', aliases: { invoice: 'i', memo: 'm', notice: 'n' } }
  const record = { kind: 'memo', id: '000Ab-Z', date: '2031-09-07', sealed: false }
  assert.equal(preview(config, record), 'r/2031/09/m/000Ab-Z')
  assert.equal(preview(config, { ...record, sealed: true }), 's/m/000Ab-Z')
  assert.throws(() => preview(config, { ...record, id: '../secret' }))
  assert.throws(() => preview(config, { ...record, date: '2031-99-07' }))
})

test('fresh evaluation inputs differ and do not publish expected paths in model-visible files', () => {
  const a = fixtures('seed', 'verification'), b = fixtures('seed', 'confirmation')
  assert.equal(a.length, 10); assert.equal(b.length, 10)
  for (let i = 0; i < 6; i++) {
    assert.notEqual(a[i].expected, b[i].expected)
    assert.ok(!a[i].files['input.txt'].includes(a[i].expected))
  }
  assert.notDeepEqual(environment('seed'), environment('other'))
})
