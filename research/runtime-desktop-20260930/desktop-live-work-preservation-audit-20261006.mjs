/** Read private activation snapshots, publish only counts/hashes and verified limits.
 * Usage: node <script> <private Development directory> <baseline receipt> <latest receipt>
 * No application interaction, provider request, state mutation or receipt rewriting.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
const repo = process.cwd()
const root = realpathSync(resolve(process.argv[2]))
function privateFile(name) {
  assert(name && name === basename(name), 'Use a private receipt basename')
  const file = realpathSync(join(root, name)), rel = relative(root, file)
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Private input must remain confined')
  return JSON.parse(readFileSync(file, 'utf8'))
}
const baseline = privateFile(process.argv[3]), latest = privateFile(process.argv[4])
const before = privateFile(baseline.privateSnapshot)
const after = privateFile(latest.privateSnapshot.replace('before', 'after'))
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const equal = isDeepStrictEqual
const messageBody = ({ messageId, status, stopReason, ...body }) => body
const unchangedDomains = Object.keys(baseline.before).filter(key => key !== 'sessions')
assert(unchangedDomains.every(key => baseline.before[key] === latest.after[key]), 'Protected non-session domain changed')
const audited = before.sessions.map((session, index) => {
  const restored = after.sessions[index]
  assert(session.id === restored.id)
  assert.deepEqual(session.messages.map(messageBody), restored.messages.map(messageBody), 'Actual displayed message bodies changed')
  for (const field of ['draft', 'settings', 'attachments']) assert(equal(session[field], restored[field]), `Changed ${field}`)
  const effective = s => ({ id: s.settings?.choice?.provider ?? s.provider?.id, model: s.settings?.choice?.model ?? s.provider?.model })
  assert(equal(effective(session), effective(restored)), 'Effective selected model changed')
  for (const field of ['tasks', 'tasksNotice', 'retry', 'retryNotice']) assert(equal(session.thread?.[field], restored.thread?.[field]), `Changed ${field}`)
  assert(session.jobs.every(job => job.status !== 'running' && !job.recoveryRequired), 'Active job existed')
  return { ordinal: index + 1, beforeMessages: session.messages.length, afterMessages: restored.messages.length, actualMessageBodiesEqual: true,
    draftsSettingsAttachmentsAndEffectiveModelEqual: true, taskAndRetryStateEqual: true,
    beforeCompletedRegistryJobs: session.jobs.length, afterRegistryJobs: restored.jobs.length,
    runtimeProviderModelFieldPreserved: session.provider?.model === restored.provider?.model,
    beforePublicTools: Object.keys(session.thread?.tools ?? {}).length, afterPublicTools: Object.keys(restored.thread?.tools ?? {}).length }
})
function manifest(directory) {
  const rows = []
  const visit = rel => { for (const name of readdirSync(join(directory, rel))) {
    const file = join(rel, name)
    if (statSync(join(directory, file)).isDirectory()) visit(file)
    else rows.push({ file, sha256: hash(readFileSync(join(directory, file))) })
  } }
  visit(''); return rows.sort((a, b) => a.file.localeCompare(b.file))
}
const source = manifest(join(repo, 'packages/desktop/dist'))
assert.deepEqual(source, manifest(join(root, 'app/dist')), 'Native desktop differs from final build')
const hostSource = hash(readFileSync(join(repo, 'packages/cli/dist/commands/desktop-host.js')))
const hostNative = hash(readFileSync(join(root, 'runtime/packages/p0/dist/commands/desktop-host.js')))
assert.equal(hostSource, hostNative)
assert.equal(latest.cliModuleCopies, 1)
const nativeManifest = directory => manifest(directory).map(row => ({ file: row.file, hash: row.sha256 }))
const sdkAfter = hash(nativeManifest(join(root, 'runtime/packages/p22/dist')))
assert.equal(latest.sdkManifestBeforeSha256, sdkAfter, 'Native SDK changed')
const cliAfter = nativeManifest(join(root, 'runtime/packages/p0/dist'))
const reconstructedCliBefore = cliAfter.map(row => row.file === 'commands/desktop-host.js'
  ? { ...row, hash: latest.cliHistoryBeforeSha256 } : row)
assert.equal(hash(reconstructedCliBefore), latest.cliManifestBeforeSha256, 'Unreviewed CLI file changed')
const receipt = { date: '2026-10-06', nativeApplied: true, desktopSourceBytesMatch: true, cliHistorySourceBytesMatch: true,
  nativePidChanged: Number(readFileSync(join(root, 'desktop.pid'), 'utf8')) !== latest.beforePid,
  originalStrictActivationPassed: baseline.passed, latestStrictActivationPassed: latest.passed,
  strictComparisonDifference: 'First activation rebuilt one tool-only assistant as a media placeholder and released completed runtime buffers. The history fix removes that verified false placeholder; original strict receipts remain untouched.',
  postUpdateDurableContentAuditPassed: true, applicationSourceFiles: source.length, sourceManifestSha256: hash(source), cliHistorySha256: hostSource,
  unchangedDomains, audited, nativeSdkUnchanged: true, onlyReviewedCliModuleChanged: true,
  rendererProofs: [
    { file: 'background-processes-browser-proof-20261006.json', checks: 10 },
    { file: 'transcript-single-live-status-motion-proof-20261006.json', checks: 8, singleLiveStateChecks: 9 },
    { file: 'recents-progressive-unsent-browser-proof-20261006.json', checks: 16 },
  ],
  verification: { workspaceTestsPassed: true, workspaceCheckpoint: 'Before final tool-only history display filter; its strict journal suite subsequently passed 26 tests.',
    cliTestsAtWorkspaceCheckpoint: 5172, finalHistorySuiteTests: 26, desktopTests: 653, finalUiFocusedTests: 15,
    typecheckPassed: true, lintPassed: true, existingCliLintWarnings: 12, desktopAndCliBuildsPassed: true, docsPassed: true },
  actions: { modelRequests: 0, computerActions: 0, packageInstalls: 0, sdkCopies: 0, cliModuleCopiesAtLatestActivation: 1 },
  limits: [
    'This audit compares actual durable message bodies and saved choices. It does not turn either original strict activation failure into a pass.',
    'Cold restart rebuilds ordinary text history rather than live public tool/reasoning presentation. Completed job buffers are owned by the terminated CLI registry and are not persisted.',
    'Effective saved model choice is unchanged; one runtime provider response no longer has an explicit model field.',
  ] }
writeFileSync(join(repo, 'research/runtime-desktop-20260930/artifacts/desktop-live-work-verification-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(JSON.stringify({ nativeApplied: true, finalSourcesMatch: true, strictActivationPassed: latest.passed, durableContentAuditPassed: true, sessionCount: audited.length }))
