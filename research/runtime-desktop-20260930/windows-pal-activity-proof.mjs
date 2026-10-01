// Native Windows, read-only observation of an existing private Pal proof.
// The host stores verified cursor outputs privately; no renderer/model cursor
// is admitted, and this harness never starts a computer, query or writer.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32')
const [snapshotArg, homeArg, mode, payloadFile] = process.argv.slice(2)
assert.ok(snapshotArg && homeArg)
const snapshot = realpathSync(resolve(snapshotArg))
const home = realpathSync(resolve(homeArg))
assert.ok(basename(snapshot).startsWith('namzu-native-consumer-') && basename(snapshot).includes('appearance'))
assert.ok(basename(home).startsWith('pal-messaging-'))
assert.equal(lstatSync(home).isDirectory(), true)
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const sdkPackage = manifest.packages.find((item) => item.name === '@namzu/sdk')
assert.ok(sdkPackage)
const sdkDist = join(snapshot, sdkPackage.relative, 'dist')
const sdk = await import(pathToFileURL(join(sdkDist, 'index.js')).href)
const { DiskLogMedium } = await import(pathToFileURL(join(sdkDist, 'store/session-log/disk.js')).href)
assert.equal(typeof sdk.createPalActivitySource, 'function')
const workspaceRoot = join(dirname(home), `${basename(home)}-workspaces`, 'pals')
assert.equal(existsSync(join(home, 'pals')), true)
assert.equal(existsSync(workspaceRoot), true)
// The directories already exist. The default Windows constructor does not
// change ACLs; only getRevision is used, never create/update or CLI openSessions.
const pals = new sdk.DiskPalStore({ root: join(home, 'pals'), workspaceRoot })
const identity = JSON.parse(readFileSync(join(home, 'identity.json'), 'utf8'))
const signal = new AbortController().signal
const maxRecords = 7
const maxReadBytes = 128 * 1024
const options = (cursor) => ({ signal, maxRecords, maxReadBytes, ...(cursor ? { cursor } : {}) })
const fileDigest = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const firstRecord = (file) => {
  const fd = openSync(file, 'r')
  try {
    const chunks = []
    let length = 0
    while (length < 16 * 1024) {
      const buffer = Buffer.alloc(1024)
      const read = readSync(fd, buffer, 0, buffer.length, length)
      assert.ok(read > 0, 'The existing journal root is complete.')
      const chunk = buffer.subarray(0, read)
      const newline = chunk.indexOf(10)
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline))
      if (newline !== -1) return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      length += read
    }
    throw new Error('The existing journal root exceeds this fixture metadata budget.')
  } finally { closeSync(fd) }
}
const metadata = (file) => {
  const root = firstRecord(file)
  assert.equal(root.type, 'session_started')
  assert.equal(root.parent, undefined)
  assert.equal(root.forkedFrom, undefined)
  assert.equal(root.origin?.protocol, 'desktop')
  const [mark, palId, profileRevision, sessionId] = JSON.parse(root.origin.externalSessionId)
  assert.equal(mark, 'namzu-pal')
  assert.equal(sessionId, root.sessionId)
  assert.equal(root.tenantId, identity.tenantId)
  const project = JSON.parse(readFileSync(join(dirname(file), 'project.json'), 'utf8'))
  assert.equal(root.projectId, project.projectId)
  assert.equal(root.cwd, project.cwd)
  const pal = pals.getRevision(palId, profileRevision)
  assert.equal(root.cwd, pal.workspace)
  return {
    file,
    scope: { tenantId: root.tenantId, projectId: root.projectId, palId, profileRevision, sessionId },
  }
}
const createObserved = (journal, control = { allowed: true }, onSize) => {
  const medium = new DiskLogMedium(journal.file)
  const stats = { opens: 0, requests: 0, bytes: 0, sizes: 0, authorizations: 0 }
  const source = sdk.createPalActivitySource({
    scope: journal.scope,
    pals,
    authorize: async (scope, currentSignal) => {
      assert.deepEqual(scope, journal.scope)
      currentSignal.throwIfAborted()
      stats.authorizations++
      return control.allowed
    },
    openJournal: async (scope, currentSignal) => {
      assert.deepEqual(scope, journal.scope)
      currentSignal.throwIfAborted()
      stats.opens++
      return {
        log: { sessionId: scope.sessionId },
        bytes: {
          size: async () => {
            const size = await medium.size()
            stats.sizes++
            onSize?.(stats.sizes)
            return size
          },
          read: async (offset, length) => {
            stats.requests++
            stats.bytes += length
            return medium.read(offset, length)
          },
        },
      }
    },
  })
  return { source, stats }
}
const allowedFactKeys = new Set([
  'id', 'type', 'sessionId', 'turnId', 'seq', 'generation', 'at',
  'activityId', 'activityType', 'status', 'toolUseId', 'checkpointId', 'reviewDecision',
])
const inspectPage = (page, stats) => {
  assert.ok(page.scannedRecords <= maxRecords)
  assert.ok(page.readBytes <= maxReadBytes)
  assert.equal(page.readBytes, stats.bytes)
  assert.ok(Object.isFrozen(page) && Object.isFrozen(page.facts) && Object.isFrozen(page.cursor))
  for (const fact of page.facts) {
    assert.ok(Object.isFrozen(fact))
    for (const key of Object.keys(fact)) assert.ok(allowedFactKeys.has(key), 'Only closed metadata escapes.')
  }
  const view = JSON.stringify(page.facts)
  for (const privateMarker of [
    'SENDER_PRIVATE_', 'EXPLICIT_NATIVE_PAL_', 'REVIEWER_LOCAL_FILE',
    '/home/namzu/', 'uname -s; pwd', 'image/png',
  ]) assert.equal(view.includes(privateMarker), false, 'Original private payload is excluded.')
}

if (mode === '--resume') {
  assert.ok(payloadFile && isAbsolute(payloadFile))
  const saved = JSON.parse(readFileSync(payloadFile, 'utf8'))
  // This exact prior output was saved by the trusted parent host, privately.
  const journal = metadata(saved.file)
  assert.deepEqual(journal.scope, saved.scope)
  const observed = createObserved(journal)
  const page = await observed.source.read(options(saved.cursor))
  inspectPage(page, observed.stats)
  process.stdout.write(JSON.stringify(page))
} else {
  assert.equal(mode, undefined)
  const out = join(snapshot, `pal-activity-${randomUUID()}`)
  assert.equal(existsSync(out), false)
  mkdirSync(out)
  const files = readdirSync(join(home, 'projects'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry) => readdirSync(join(home, 'projects', entry.name), { withFileTypes: true })
      .filter((item) => item.isFile() && !item.isSymbolicLink() && item.name.endsWith('.jsonl'))
      .map((item) => join(home, 'projects', entry.name, item.name)))
  assert.equal(files.length, 2, 'This is the completed two-Pal native messaging fixture.')
  const journals = files.map(metadata)
  const before = await Promise.all(files.map(fileDigest))
  const revisions = journals.map((journal) => join(home, 'pals', journal.scope.palId, 'revisions', `${journal.scope.profileRevision}.json`))
  const profilesBefore = await Promise.all(revisions.map(fileDigest))
  const checks = []
  const summaries = []
  const restart = (journal, cursor, label) => {
    const payload = join(out, `${label}.json`)
    writeFileSync(payload, JSON.stringify({ ...journal, cursor }), { flag: 'wx' })
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), snapshot, home, '--resume', payload], {
      encoding: 'utf8', windowsHide: true, shell: false,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
    return JSON.parse(result.stdout)
  }
  for (const [index, journal] of journals.entries()) {
    const all = []
    let cursor
    let firstCursor
    let secondPage
    let pageCount = 0
    let originalScans = 0
    let complete = false
    // Finite proof guard is a record count, never a real-time race.
    while (!complete && pageCount < 1024) {
      const observed = createObserved(journal)
      const page = await observed.source.read(options(cursor))
      inspectPage(page, observed.stats)
      if (pageCount === 0) firstCursor = page.cursor
      if (pageCount === 1) secondPage = page
      if (!page.complete) assert.ok(page.cursor.after.seq > (cursor?.after.seq ?? 1))
      all.push(...page.facts)
      originalScans += page.scannedRecords
      cursor = page.cursor
      complete = page.complete
      pageCount++
    }
    assert.equal(complete, true)
    assert.ok(pageCount > 1 && all.length > 0)
    assert.equal(new Set(all.map((fact) => fact.id)).size, all.length)
    const reference = await createObserved(journal).source.read({ signal, maxRecords: 256, maxReadBytes: 1024 * 1024 })
    assert.equal(reference.complete, true)
    assert.deepEqual(all, reference.facts)
    assert.equal(originalScans, reference.scannedRecords)
    assert.deepEqual(restart(journal, firstCursor, `after-first-${index}`), secondPage)
    const end = restart(journal, cursor, `after-end-${index}`)
    assert.equal(end.complete, true)
    assert.deepEqual(end.facts, [])
    assert.deepEqual(end.cursor, cursor)
    summaries.push({ pages: pageCount, facts: all.length, scannedRecords: originalScans, stableIds: true, restartCursorUnchanged: true })
  }
  checks.push('both real original native journals are read in bounded pages with stable, unique fact IDs')
  checks.push('concatenated page facts equal a separately verified original-journal pass')
  checks.push('new native processes resume trusted privately stored cursors and preserve unchanged tail cursors')
  checks.push('closed metadata excludes original private prompts, peer bodies, tool arguments/results, commands and PNG payloads')
  const revoked = createObserved(journals[0], { allowed: false })
  await assert.rejects(revoked.source.read(options()), sdk.PalActivityAccessDeniedError)
  assert.equal(revoked.stats.opens, 0)
  assert.equal(revoked.stats.requests, 0)
  checks.push('current denied host observation consent returns no page and performs no journal access')
  const control = { allowed: true }
  const duringRead = createObserved(journals[0], control, (count) => { if (count === 2) control.allowed = false })
  await assert.rejects(duringRead.source.read(options()), sdk.PalActivityAccessDeniedError)
  assert.ok(duringRead.stats.requests > 0)
  checks.push('consent revoked at the actual final size-read boundary suppresses the entire pending page')
  const foreign = createObserved(journals[1])
  const cursor = (await createObserved(journals[0]).source.read(options())).cursor
  await assert.rejects(foreign.source.read(options(cursor)), sdk.PalActivityIntegrityError)
  assert.equal(foreign.stats.opens, 0)
  checks.push('a cursor belonging to the other Pal is refused before its journal is opened')
  assert.deepEqual(await Promise.all(files.map(fileDigest)), before)
  assert.deepEqual(await Promise.all(revisions.map(fileDigest)), profilesBefore)
  checks.push('all observed original journal and pinned profile bytes remain unchanged; no writer, model or computer is started')
  const sourceFiles = [
    'index.js', 'public-runtime.js', 'pals/store.js',
    'pals/activity/source.js', 'pals/activity/projection.js', 'pals/activity/types.js',
    'store/session-log/disk.js', 'store/session-log/chain.js',
    'session/log-hash.js', 'types/session/records.js',
  ]
  const receipt = {
    passed: true, platform: process.platform, node: process.version,
    callerWorkingDirectoryKind: process.cwd().startsWith('\\\\wsl.') ? 'WSL UNC' : 'native Windows',
    maxRecordsPerPage: maxRecords, maxRequestedBytesPerPage: maxReadBytes,
    journals: summaries,
    checks,
    sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await fileDigest(join(sdkDist, file))]))),
    harnessSha256: await fileDigest(fileURLToPath(import.meta.url)),
    limitations: [
      'Built local native SDK consumer; not an npm registry installation.',
      'Observation is read-only over completed original journals; no concurrent writer is exercised.',
      'The required host observation consent port is an explicit fixture callback; this is not a CLI/desktop activity subscription proof.',
      'Only verified prior cursor outputs privately saved by the host are resumed; raw renderer/model cursors are not accepted.',
      'This proof does not establish authenticity of the previously consumed prefix by rescanning it.',
    ],
  }
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' })
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
}
