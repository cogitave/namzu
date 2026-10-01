/** Actual attachment hook, deferred IPC replies; no copied state machine or native instance. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const React = require('react')
const { renderToString } = require('react-dom/server')
const source = join(repo, 'packages/desktop/src/renderer/use-attachments.ts')
const { useAttachments } = await import(pathToFileURL(source).href)
const previousWindow = globalThis.window
const file = { id: 'new-file', name: 'new.txt', kind: 'text', size: 1, mediaType: 'text/plain' }

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
function hook(owner, api) {
  globalThis.window = { namzu: api }
  let value
  function Harness() {
    // SSR creates the real hook refs/callbacks, without a DOM or running effects.
    // These assertions inspect get(), which is also what actual send snapshots use.
    value = useAttachments(owner, false, (error) => { throw error })
    return null
  }
  renderToString(React.createElement(Harness))
  return value
}
let receipt
try {
  const picked = deferred(), olderList = deferred()
  const draft = hook('conversation-a', {
    pickAttachments: () => picked.promise,
    attachments: () => olderList.promise,
  })
  const picking = draft.pick()
  assert.equal(draft.isBusy('conversation-a'), true)
  const reloading = draft.reload('conversation-a')
  picked.resolve([file])
  await picking
  assert.deepEqual(draft.get('conversation-a'), [file])
  olderList.resolve([])
  await reloading
  assert.deepEqual(draft.get('conversation-a'), [file], 'Older list cannot hide newly picked files')
  assert.equal(draft.isBusy('conversation-a'), false)

  const promoted = deferred(), olderTarget = deferred(), olderSource = deferred()
  const landing = hook('project:a', {
    pickAttachments: () => Promise.resolve([file]),
    moveAttachments: () => promoted.promise,
    attachments: (owner) => owner === 'project:a' ? olderSource.promise : olderTarget.promise,
  })
  await landing.pick()
  const moving = landing.promote('project:a', 'conversation-b')
  const readingTarget = landing.reload('conversation-b')
  const readingSource = landing.reload('project:a')
  promoted.resolve([file])
  await moving
  olderTarget.resolve([])
  olderSource.resolve([file])
  await Promise.all([readingTarget, readingSource])
  assert.deepEqual(landing.get('conversation-b'), [file], 'Older target list cannot hide promoted files')
  assert.deepEqual(landing.get('project:a'), [], 'Older source list cannot restore transferred files')

  const admissionList = deferred()
  let reads = 0
  const restored = hook('conversation-c', {
    attachments: () => ++reads === 1 ? admissionList.promise : Promise.resolve([file]),
  })
  const olderAdmission = restored.reload('conversation-c')
  await restored.reload('conversation-c')
  assert.deepEqual(restored.get('conversation-c'), [file])
  admissionList.resolve([])
  await olderAdmission
  assert.deepEqual(restored.get('conversation-c'), [file], 'Older admission read cannot hide a newer settlement snapshot')

  receipt = {
    actualHook: 'packages/desktop/src/renderer/use-attachments.ts',
    sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
    clockRaces: false,
    native: false,
    observedBeforeRepair: { afterPick: ['new-file'], afterOlderList: [], source: 'Read-only actual-hook deferred probe run before mutation completion fences were added' },
    verifiedAfterRepair: { heldPickerReplyRetainsFile: true, heldPromotionTargetReplyRetainsFile: true, heldPromotionSourceReplyCannotDuplicateFile: true, newerSettlementSnapshotRetainsFile: true },
  }
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}
await writeFile(join(repo, 'research/runtime-desktop-20260930/artifacts/attachment-hook-probe-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(receipt)}\n`)
