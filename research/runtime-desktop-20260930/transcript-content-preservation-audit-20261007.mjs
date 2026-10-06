/**
 * Filesystem-only audit of the transcript activation's intentional phase changes.
 * Usage: node <script> <private Development directory> <captured Namzu home>
 * Reads existing receipts, payloads and strict journals. It never connects to an
 * application, invokes a provider, changes user state or rewrites old evidence.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DiskSessionLog,
  foldSessionMessages,
  readSessionLog,
  selectAssistantText,
} from '../../packages/sdk/dist/index.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
assert.equal(process.argv.length, 4, 'Supply the two private input directories.')
const privateRoot = await realpath(path.resolve(process.argv[2]))
const stateRoot = await realpath(path.resolve(process.argv[3]))
const output = path.join(repo, 'research/runtime-desktop-20260930/artifacts/transcript-content-native-preservation-20261007.json')
const pins = {
  activation: ['transcript-apply-native-20261007-v1.json', 'fafa4c7af5be725866a7c9fa19e82698fd99cef6345b78a93c4bb3198350954e'],
  observer: ['transcript-current-window-private-20261007-v1.json', 'e8279162dc9d74f644a1185e99027ef7dce70161df4f3a908a6009f56c998626'],
  journals: ['transcript-journal-observation-private-20261007-v1.json', '245ff672cd644222289044b8f01c732919f8ce4c0e2022ba30e55ab72e8dbcf6'],
}
const expectedChanged = ['commands/desktop-host.js', 'integrations/harness/claude-protocol.js', 'integrations/sessions/store.js'].sort()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = value => sha(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
const fromWindows = value => {
  assert(typeof value === 'string' && /^[A-Z]:\\/i.test(value), 'Expected a recorded Windows path.')
  return `/mnt/${value[0].toLowerCase()}/${value.slice(3).replaceAll('\\', '/')}`
}
const toWindows = value => {
  assert(/^\/mnt\/[a-z]\//.test(value), 'Expected a mounted Windows path.')
  return `${value[5].toUpperCase()}:\\${value.slice(7).replaceAll('/', '\\')}`
}
function confined(root, file) {
  const rel = path.relative(root, file)
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'A private input escaped its captured root.')
}
async function privateJson(name) {
  assert(name === path.basename(name), 'A receipt input must be a basename.')
  const file = await realpath(path.join(privateRoot, name))
  confined(privateRoot, file)
  assert((await lstat(file)).isFile(), 'A receipt input is not a regular file.')
  const bytes = await readFile(file)
  return { value: JSON.parse(bytes.toString('utf8')), sha256: sha(bytes) }
}
async function manifest(directory) {
  const rows = []
  async function visit(relative) {
    for (const item of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, item.name)
      let stat
      try {
        stat = await lstat(path.join(directory, file))
      } catch (error) {
        const diagnostic = new Error('A shipping payload entry could not be inspected.', { cause: error })
        diagnostic.code = error.code
        diagnostic.shippingFile = file
        throw diagnostic
      }
      assert(!stat.isSymbolicLink(), 'A shipping payload unexpectedly contains a link.')
      if (stat.isDirectory()) await visit(file)
      else {
        assert(stat.isFile(), 'A shipping payload contains a nonregular entry.')
        rows.push({ file: file.replaceAll(path.sep, '/'), hash: sha(await readFile(path.join(directory, file))) })
      }
    }
  }
  await visit('')
  return rows.sort((a, b) => a.file.localeCompare(b.file))
}
function ordinaryHistory(messages, storedAssistantPhase) {
  const shown = messages.flatMap(message => {
    if (message.role === 'assistant') {
      if (message.content === null && message.toolCalls?.length) return []
      const phase = storedAssistantPhase(message)
      return [{ durableMessage: message, role: message.role, content: message.content, ...(phase ? { phase } : {}) }]
    }
    return message.role === 'user' && (!message.source ||
      (message.source.type === 'runtime-context' && message.source.kind === 'steering'))
      ? [{ durableMessage: message, role: message.role, content: message.content }] : []
  })
  let remaining = 200_000
  let partial = false
  const rows = []
  const selectedMessages = []
  for (const message of shown.slice(-200).reverse()) {
    if (remaining <= 0) break
    const content = typeof message.content === 'string' ? message.content : '[Media message]'
    const value = content.slice(0, Math.min(32_000, remaining))
    partial ||= value.length < content.length
    remaining -= value.length
    rows.unshift({ role: message.role, text: value, ...(message.phase ? { phase: message.phase } : {}) })
    selectedMessages.unshift(message.durableMessage)
  }
  return { messages: rows, selectedMessages, partial: partial || rows.length < shown.length || remaining <= 0 }
}
const audit = {
  schema: 'namzu.transcript-content.native-preservation.v1', at: new Date().toISOString(),
  passed: false, readOnly: true, originalReceiptsRelabelled: false,
  effects: { nativeConnections: 0, appApiCalls: 0, processActions: 0, modelRequests: 0,
    computerActions: 0, packageInstalls: 0, userStateWrites: 0, originalReceiptWrites: 0 },
}
try {
  audit.phase = 'pinned-private-inputs'
  const receipts = {}
  audit.provenance = {}
  for (const [kind, [name, pinned]] of Object.entries(pins)) {
    const input = await privateJson(name)
    assert.equal(input.sha256, pinned, 'A pinned private receipt changed.')
    receipts[kind] = input.value
    audit.provenance[kind] = { receiptSha256: pinned }
  }
  const { activation, observer, journals } = receipts
  assert.equal(activation.passed, false)
  assert.equal(activation.phase, 'verify')
  assert.equal(activation.error?.name, 'AssertionError')
  assert(activation.error.message.startsWith('Protected sessions changed across activation'), 'Unexpected strict rejection.')
  assert.equal(activation.cliModuleCopies, 3)
  for (const field of ['packageInstalls', 'sdkCopies', 'modelRequests', 'computerActions']) assert.equal(activation[field], 0)
  assert.equal(observer.passed, true)
  for (const field of ['modelRequests', 'computerActions', 'nativeMutations']) assert.equal(observer[field], 0)
  assert.equal(journals.observedDesktopPid, observer.pid)
  const beforeInput = await privateJson(activation.privateSnapshot)
  const afterInput = await privateJson(activation.privateSnapshot.replace('before', 'after'))
  const currentInput = await privateJson(observer.privateSnapshot)
  assert.equal(currentInput.sha256, observer.snapshotSha256)
  assert.equal(currentInput.sha256, afterInput.sha256, 'The separate observed state differs from the apply-after snapshot.')
  const before = beforeInput.value
  const after = afterInput.value
  const guardFile = path.join(repo, 'research/runtime-desktop-20260930/transcript-content-desktop-activation-native-20261007.cjs')
  const guardBytes = await readFile(guardFile)
  assert.equal(sha(guardBytes), 'f85cd8f55dd95cd76ffdbfc166d15410d383470f7c6fd3296cfb8dee4693e56d')
  const guard = guardBytes.toString('utf8')
  const semanticStart = guard.indexOf('function semantic(state) {')
  const semanticEnd = guard.indexOf('\n(async () => {', semanticStart)
  assert(semanticStart > 0 && semanticEnd > semanticStart)
  const semanticSource = guard.slice(semanticStart, semanticEnd)
  // Only these pinned pure functions are evaluated; the native helper is never imported or executed.
  const { semantic, digests } = new Function('hash', `${semanticSource}\nreturn {semantic, digests};`)(hash)
  assert.deepEqual(digests(before), activation.before)
  assert.deepEqual(digests(after), activation.after)
  assert.deepEqual(digests(currentInput.value), activation.after)
  const beforeProtected = semantic(before)
  const afterProtected = semantic(after)
  const unchangedDomains = Object.keys(beforeProtected).filter(name => name !== 'sessions')
  for (const domain of unchangedDomains) assert.deepEqual(beforeProtected[domain], afterProtected[domain])
  assert.equal(before.sessions.length, 5)
  assert.equal(after.sessions.length, 5)
  assert.equal(before.sessions.reduce((sum, session) => sum + session.messages.length, 0), 22)
  assert.equal(journals.sessionCount, 5)
  assert.equal(journals.emptyUnstartedSessions.length, 1)
  assert.equal(journals.files.length, 4)

  audit.phase = 'installed-and-source-payloads'
  const configBytes = await readFile(path.join(privateRoot, 'launch.json'))
  assert.equal(sha(configBytes), activation.launchConfigSha256)
  const config = JSON.parse(configBytes.toString('utf8'))
  const appRoot = fromWindows(config.app)
  const cliRoot = path.dirname(fromWindows(config.cli))
  const runtimeRoot = path.join(privateRoot, 'runtime')
  const graphBytes = await readFile(path.join(runtimeRoot, 'manifest.json'))
  assert.equal(sha(graphBytes), activation.packageGraphManifestSha256)
  const graph = JSON.parse(graphBytes.toString('utf8'))
  const sdkPackages = graph.packages.filter(item => item.name === '@namzu/sdk')
  assert.equal(sdkPackages.length, 1)
  const sdkRoot = path.join(runtimeRoot, sdkPackages[0].relative)
  const sdkDist = path.join(sdkRoot, 'dist')
  assert.equal(await realpath(path.join(runtimeRoot, graph.cli)), await realpath(fromWindows(config.cli)))
  for (const [file, expected] of [
    [path.join(appRoot, 'package.json'), activation.desktopPackageSha256],
    [path.join(path.dirname(cliRoot), 'package.json'), activation.cliPackageSha256],
    [path.join(sdkRoot, 'package.json'), activation.sdkPackageSha256],
  ]) assert.equal(sha(await readFile(file)), expected)
  const [desktopSource, desktopNative, cliNative, sdkNative] = await Promise.all([
    manifest(path.join(repo, 'packages/desktop/dist')), manifest(path.join(appRoot, 'dist')),
    manifest(cliRoot), manifest(sdkDist),
  ])
  assert.equal(desktopSource.length, 634)
  assert.equal(hash(desktopSource), activation.sourceManifestSha256)
  assert.deepEqual(desktopSource, desktopNative)
  assert.equal(hash(sdkNative), activation.sdkManifestBeforeSha256, 'The installed SDK changed.')
  assert.equal(activation.cliReviewedModules.length, 7)
  assert.equal(activation.sdkReviewedModules.length, 1)
  const changed = activation.cliReviewedModules.filter(item => item.beforeSha256 !== item.afterSha256)
  assert.deepEqual(changed.map(item => item.file).sort(), expectedChanged)
  assert(activation.sdkReviewedModules.every(item => item.beforeSha256 === item.afterSha256))
  for (const [kind, rows, directory] of [['cli', activation.cliReviewedModules, cliRoot], ['sdk', activation.sdkReviewedModules, sdkDist]]) {
    for (const item of rows) {
      assert.equal(sha(await readFile(path.join(directory, item.file))), item.afterSha256)
      if (kind === 'cli') assert.equal(sha(await readFile(path.join(repo, 'packages/cli/dist', item.file))), item.afterSha256)
    }
  }
  const beforeHashes = new Map(changed.map(item => [item.file, item.beforeSha256]))
  const cliBefore = cliNative.map(item => beforeHashes.has(item.file) ? { ...item, hash: beforeHashes.get(item.file) } : item)
  assert.equal(hash(cliBefore), activation.cliManifestBeforeSha256, 'An unreviewed CLI payload changed.')
  for (const [file, field] of [
    ['commands/desktop-host.js', 'cliHistoryBackup'],
    ['integrations/harness/claude-protocol.js', 'cliClaudeInterruptedTranscriptBackup'],
    ['integrations/sessions/store.js', 'cliVerifiedPalScopeBackup'],
  ]) {
    assert.equal(activation[field], path.basename(activation[field]), 'A recorded module backup must remain a private basename.')
    const backup = await realpath(path.join(privateRoot, activation[field]))
    confined(privateRoot, backup)
    assert.equal(sha(await readFile(backup)), beforeHashes.get(file), 'A captured module backup differs.')
  }
  let links = 0
  let sdkUsers = 0
  const sdkRoots = new Set()
  const packages = []
  for (const item of graph.packages) {
    const directory = path.join(runtimeRoot, item.relative)
    const packageBytes = await readFile(path.join(directory, 'package.json'))
    const metadata = JSON.parse(packageBytes.toString('utf8'))
    assert.equal(metadata.name, item.name)
    assert.equal(metadata.version, item.version)
    const rows = []
    for (const [name, relative] of Object.entries(item.links ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const actual = await realpath(path.join(directory, 'node_modules', name))
      assert.equal(actual, await realpath(path.join(runtimeRoot, relative)))
      const bytes = await readFile(path.join(actual, 'package.json'))
      assert.equal(JSON.parse(bytes.toString('utf8')).name, name)
      links++
      if (name === '@namzu/sdk') { sdkUsers++; sdkRoots.add(actual) }
      rows.push({ name, directory: toWindows(actual), packageSha256: sha(bytes) })
    }
    packages.push({ directory: toWindows(await realpath(directory)), name: metadata.name, packageSha256: sha(packageBytes), links: rows })
  }
  assert.equal(links, 225)
  assert.equal(sdkUsers, 11)
  assert.equal(sdkRoots.size, 1)
  assert.equal([...sdkRoots][0], await realpath(sdkRoot))
  const packageGraph = { packages, links, sdkUsers, singleSdkRoot: true }
  assert.equal(hash(packageGraph), activation.packageGraphSha256)
  async function dependencyGraph(directory) {
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    const rows = []
    for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
      const file = await realpath(path.join(directory, 'node_modules', name, 'package.json'))
      rows.push({ name, requested: pkg.dependencies[name], packagePath: toWindows(file), packageSha256: sha(await readFile(file)) })
    }
    return rows
  }
  assert.equal(hash(await dependencyGraph(path.dirname(cliRoot))), activation.cliDependencyGraphSha256)
  assert.equal(hash(await dependencyGraph(sdkRoot)), activation.sdkDependencyGraphSha256)
  const hostBytes = await readFile(path.join(repo, 'packages/cli/dist/commands/desktop-host.js'))
  const hostSource = hostBytes.toString('utf8')
  const phaseStart = hostSource.indexOf('function storedAssistantPhase(message) {')
  const phaseEnd = hostSource.indexOf('/** Only a durable completion', phaseStart)
  assert(phaseStart > 0 && phaseEnd > phaseStart)
  const phaseFunctionSource = hostSource.slice(phaseStart, phaseEnd)
  const storedAssistantPhase = new Function('selectAssistantText', `${phaseFunctionSource}\nreturn storedAssistantPhase;`)(selectAssistantText)
  for (const token of ['let remaining = 200_000;', 'shown.slice(-200).reverse()', 'Math.min(32_000, remaining)',
    'const phase = storedAssistantPhase(message);', "message.source.kind === 'steering'"]) assert(hostSource.includes(token))
  for (const file of ['store/session-log/fold.js', 'store/session-log/chain.js', 'types/message/index.js']) {
    assert.equal(sha(await readFile(path.join(sdkDist, file))), sha(await readFile(path.join(repo, 'packages/sdk/dist', file))))
  }
  audit.payload = {
    desktopFiles: desktopSource.length, allDesktopSourceBytesMatch: true,
    sourceManifestSha256: hash(desktopSource), cliManifestBeforeSha256: hash(cliBefore),
    cliManifestAfterSha256: hash(cliNative), sdkManifestSha256: hash(sdkNative), sdkUnchanged: true,
    changedCliModules: changed.map(item => ({ file: item.file, beforeSha256: item.beforeSha256, afterSha256: item.afterSha256 })),
    onlyThreeReviewedCliModulesChanged: true, allReviewedCliModulesMatchBuild: true,
    packageGraphManifestSha256: sha(graphBytes), packageGraphSha256: hash(packageGraph),
    dependencyLinks: links, sdkUsers, singleSdkRoot: true,
  }

  audit.phase = 'strict-journals-and-proved-phase-projection'
  const projectFiles = []
  async function findLogs(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name)
      assert(!item.isSymbolicLink(), 'A captured project journal tree unexpectedly contains a link.')
      if (item.isDirectory()) await findLogs(file)
      else if (item.isFile() && item.name.endsWith('.jsonl')) projectFiles.push(file)
    }
  }
  await findLogs(path.join(stateRoot, 'projects'))
  const observedFiles = new Map()
  for (const item of journals.files) {
    // This journal observation was captured from WSL, unlike the native launch receipt.
    assert(typeof item.file === 'string' && (item.file.startsWith('/mnt/') || /^[A-Z]:\\/i.test(item.file)))
    const file = await realpath(item.file.startsWith('/mnt/') ? item.file : fromWindows(item.file))
    confined(stateRoot, file)
    assert((await lstat(file)).isFile())
    assert(!observedFiles.has(file))
    observedFiles.set(file, item.sha256)
  }
  const expectedProtected = structuredClone(beforeProtected)
  const phaseProofs = []
  const journalProofs = []
  let missing = 0
  let visibleTotal = 0
  let currentBodyBytes = 0
  for (const [index, session] of after.sessions.entries()) {
    const prior = before.sessions[index]
    assert.equal(session.id, prior.id)
    assert.equal(session.projectId, prior.projectId)
    assert(before.projects.find(project => project.id === session.projectId))
    const candidates = projectFiles.filter(file => path.basename(file) === `${session.id}.jsonl`)
    assert(candidates.length <= 1, 'A selected session has ambiguous journal ownership.')
    if (!candidates.length) {
      missing++
      assert.equal(index, 0)
      assert.equal(session.messages.length, 0)
      assert.equal(session.jobs.length, 0)
      assert.deepEqual(prior, session)
      journalProofs.push({ sessionOrdinal: index + 1, physicallyAbsent: true, visibleMessages: 0, noJournalCreated: true })
      continue
    }
    const file = await realpath(candidates[0])
    confined(stateRoot, file)
    assert((await lstat(file)).isFile())
    assert(observedFiles.has(file), 'The journal is outside the recorded post-activation observation.')
    const bytes = await readFile(file)
    assert.equal(sha(bytes), observedFiles.get(file), 'A journal changed since the post-only observation.')
    const read = await readSessionLog(file, { mode: 'strict', sessionId: session.id })
    assert.equal(read.intact, true)
    assert.equal(read.tornBytes, 0)
    assert.equal(read.head.bytes, bytes.length)
    const records = read.entries.map(entry => entry.record)
    const first = records[0]
    assert.equal(first.type, 'session_started')
    assert.equal(first.sessionId, session.id)
    const project = after.projects.find(item => item.id === session.projectId)
    assert(!project.palId, 'This bounded audit is for the captured ordinary transcript histories.')
    assert.equal(first.cwd, project.path, 'The journal is not in the selected project.')
    const log = new DiskSessionLog({ file, sessionId: session.id, sessionDir: file.slice(0, -'.jsonl'.length) })
    const messages = await foldSessionMessages(records, { readSpill: ref => log.readSpill(ref) })
    const projected = ordinaryHistory(messages, storedAssistantPhase)
    assert.deepEqual(projected.messages, session.messages, 'The observed history differs from the strict ordinary projection.')
    assert.equal(projected.partial, session.partial)
    assert.equal(sha(await readFile(file)), sha(bytes), 'The journal changed during this read-only audit.')
    const expectedRawMessages = structuredClone(prior.messages)
    for (const [messageIndex, current] of session.messages.entries()) {
      const old = prior.messages[messageIndex]
      assert(old, 'A displayed message was added.')
      if (old.phase === current.phase) continue
      assert.equal(index, 3, 'An unexpected session phase changed.')
      assert.equal(old.phase, undefined)
      assert.equal(current.role, 'assistant')
      assert(['commentary', 'final_answer'].includes(current.phase))
      // Bind by the actual ordered/capped projection, never by text equality:
      // two different commentary messages may legitimately contain identical text.
      const selected = projected.selectedMessages[messageIndex]
      assert.equal(selected?.role, 'assistant')
      assert.equal(storedAssistantPhase(selected), current.phase)
      assert(Array.isArray(selected.textParts) && selected.textParts.length > 0)
      assert.equal(selectAssistantText(selected.textParts), selected.content)
      assert.equal(selected.content, current.text, 'A displayed text was truncated or changed.')
      expectedRawMessages[messageIndex].phase = current.phase
      expectedProtected.sessions[index].messages[messageIndex].phase = current.phase
      phaseProofs.push({ sessionOrdinal: index + 1, messageOrdinal: messageIndex + 1, role: 'assistant',
        phase: current.phase, orderedDurableProjectionMatches: true,
        selectedTextPartsMatchExactly: true, bodyUnchanged: true })
    }
    assert.deepEqual(expectedRawMessages, session.messages, 'A displayed message body changed beyond a proved phase.')
    visibleTotal += session.messages.length
    currentBodyBytes += session.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text, 'utf8'), 0)
    journalProofs.push({ sessionOrdinal: index + 1, strictChainVerified: true, tornBytes: 0,
      records: records.length, foldedMessages: messages.length, displayedMessages: session.messages.length,
      selectedOwnerMatches: true, projectedHistoryMatches: true, sha256: sha(bytes), bytes: bytes.length,
      observationBoundary: 'post-activation only' })
  }
  assert.equal(missing, 1)
  assert.equal(visibleTotal, 22)
  assert.equal(phaseProofs.length, 4)
  assert.equal(phaseProofs.filter(item => item.phase === 'commentary').length, 2)
  assert.equal(phaseProofs.filter(item => item.phase === 'final_answer').length, 2)
  assert.deepEqual(expectedProtected, afterProtected, 'A protected field changed beyond the proved phases.')
  // Thread.revision is an in-memory event ordering counter excluded by the original guard.
  // Refuse every other raw session field difference, rather than normalizing arbitrary state.
  const expectedRawSessions = structuredClone(before.sessions)
  for (const item of phaseProofs) {
    const index = item.sessionOrdinal - 1
    const row = item.messageOrdinal - 1
    expectedRawSessions[index].messages[row].phase = item.phase
    expectedRawSessions[index].thread.messages[row].phase = item.phase
  }
  assert(Number.isSafeInteger(before.sessions[2].thread.revision) && Number.isSafeInteger(after.sessions[2].thread.revision))
  assert.notEqual(before.sessions[2].thread.revision, after.sessions[2].thread.revision)
  expectedRawSessions[2].thread.revision = after.sessions[2].thread.revision
  assert.deepEqual(expectedRawSessions, after.sessions, 'An unexpected raw session projection field changed.')
  audit.content = {
    sessions: after.sessions.length, displayedMessages: visibleTotal, displayedBodyBytes: currentBodyBytes,
    allRolesTextsAndMessageBodiesPreserved: true, provedPhaseAdditions: phaseProofs,
    strictJournals: journalProofs, strictChainsVerified: 4, physicallyAbsentEmptySlots: 1,
    projectionCaps: { messages: 200, totalCharacters: 200_000, perMessageCharacters: 32_000 },
    nonprotectedProjectionDifference: { sessionOrdinal: 3, field: 'thread.revision',
      classification: 'In-memory event ordering counter; excluded by the unchanged original semantic guard.',
      source: 'packages/desktop/src/shared/projection.ts:applyEvent' },
    journalHashesMatchRecordedPostObservation: true,
    journalBytesUnchangedAcrossActivationClaimed: false,
  }
  audit.protectedState = { unchangedDomains, beforeDigests: activation.before, afterDigests: activation.after,
    currentObservedDigests: digests(currentInput.value), exactCurrentObservedStateMatchesApplyAfter: true,
    beforeSnapshotSha256: beforeInput.sha256, afterSnapshotSha256: afterInput.sha256,
    currentSnapshotSha256: currentInput.sha256, onlySourceProvedPhaseDifference: true }
  audit.phase = 'recorded-native-window-observation'
  assert(Number.isSafeInteger(observer.pid) && observer.pid > 0)
  assert.equal(observer.process.pid, observer.pid)
  assert.equal(observer.process.executable.toLowerCase(), config.electron.toLowerCase())
  assert(typeof observer.process.title === 'string' && observer.process.title.length > 0)
  assert(Number.isFinite(Number(observer.process.window)) && Number(observer.process.window) !== 0)
  assert.equal(Number((await readFile(path.join(privateRoot, 'desktop.pid'), 'utf8')).trim()), observer.pid)
  audit.windowObservation = { liveWindowObserved: true, observedAt: observer.at,
    capturedPidMatchesPostJournalObservationAndSavedDesktopPid: true, exactExecutable: true,
    visibleWindowHandleRecorded: true, source: 'Separate root-owned Windows CIM observation; this audit does not query processes.' }
  audit.originalStrictActivation = { passed: false, phase: activation.phase, originalReceiptPreserved: true,
    classification: 'The exact sessions guard rejected four newly restored assistant phase fields. Each addition is separately proved from strict durable textParts; the original false result remains false.' }
  audit.verifier = { file: 'research/runtime-desktop-20260930/transcript-content-preservation-audit-20261007.mjs',
    sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    guardSemanticSourceSha256: sha(semanticSource), guardSha256: sha(guardBytes),
    hostPhaseFunctionSha256: sha(phaseFunctionSource),
    sdkFoldSha256: sha(await readFile(path.join(repo, 'packages/sdk/dist/store/session-log/fold.js'))),
    sdkChainSha256: sha(await readFile(path.join(repo, 'packages/sdk/dist/store/session-log/chain.js'))),
    sdkTextSelectionSha256: sha(await readFile(path.join(repo, 'packages/sdk/dist/types/message/index.js'))) }
  audit.phase = 'complete'
  audit.passed = true
} catch (error) {
  // Assertion messages may contain private actual/expected values; never publish them.
  const line = String(error?.stack ?? '').match(/transcript-content-preservation-audit-20261007\.mjs:(\d+):/)
  audit.failure = { name: error?.name ?? 'Error', stage: audit.phase,
    ...(line ? { verifierLine: Number(line[1]) } : {}),
    ...(typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? { code: error.code } : {}),
    ...(typeof error?.shippingFile === 'string' ? { shippingFile: error.shippingFile } : {}) }
}
const publicBytes = `${JSON.stringify(audit, null, 2)}\n`
assert(!/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i.test(publicBytes), 'Public evidence contains a private identifier.')
assert(!/\/mnt\/|[A-Z]:\\|Users\/|AppData|\.namzu\/projects/i.test(publicBytes), 'Public evidence contains a private path.')
await writeFile(output, publicBytes, { flag: 'wx', mode: 0o644 })
console.log(JSON.stringify({ passed: audit.passed, phase: audit.phase, artifactSha256: sha(publicBytes),
  sessions: audit.content?.sessions, messages: audit.content?.displayedMessages,
  strictChains: audit.content?.strictChainsVerified, provedPhaseAdditions: audit.content?.provedPhaseAdditions.length,
  desktopFiles: audit.payload?.desktopFiles, originalStrictActivationPassed: audit.originalStrictActivation?.passed,
  effects: audit.effects, ...(audit.failure ? { failure: audit.failure } : {}) }))
if (!audit.passed) process.exitCode = 1
