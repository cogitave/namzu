// Bundle as Node ESM and execute with native Windows Node against a new built
// consumer snapshot. Only private Pal metadata and owned ACP processes are used.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Operator } from '../../packages/desktop/src/main/operator.ts'

assert.equal(process.platform, 'win32')
const [snapshot] = process.argv.slice(2)
assert.ok(snapshot && basename(snapshot).startsWith('namzu-native-consumer-') && basename(snapshot).includes('appearance'))
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const sdkPackage = manifest.packages.find((item) => item.name === '@namzu/sdk')
assert.ok(sdkPackage)
const sdk = await import(pathToFileURL(join(snapshot, sdkPackage.relative, 'dist/index.js')).href)
const cliPackage = manifest.packages.find((item) => item.name === '@namzu/cli')
assert.ok(cliPackage)
const { EXIT_USAGE } = await import(pathToFileURL(join(snapshot, cliPackage.relative, 'dist/exit-codes.js')).href)
const cli = join(snapshot, manifest.cli)
const home = join(snapshot, `pal-appearance-${randomUUID()}`)
assert.equal(existsSync(home), false)
mkdirSync(home)
const env = {
  ...process.env,
  NAMZU_HOME: home,
  NAMZU_MODEL_CATALOGUE_REFRESH: '0',
  NAMZU_CUA_DRIVER: 'off',
}
const runCli = (args, status = 0) => {
  const result = spawnSync(process.execPath, [cli, 'pal', ...args, '--json'], {
    env, encoding: 'utf8', windowsHide: true, shell: false,
  })
  assert.equal(result.status, status, result.stderr)
  assert.equal(result.signal, null)
  return status === 0 ? JSON.parse(result.stdout) : result
}
const checks = []
const initial = { character: 'spark', color: 'violet' }
const revised = { character: 'sprout', color: 'blue' }
const pal = runCli(['create', 'Native appearance', '--appearance', 'spark/violet'])
assert.deepEqual(pal.appearance, initial)
assert.equal(pal.revision, 1)
const revision1 = join(home, 'pals', pal.id, 'revisions', '1.json')
const bytes1 = readFileSync(revision1, 'utf8')
const changed = runCli(['update', pal.id, '--revision', '1', '--appearance', 'sprout/blue'])
assert.deepEqual(changed.appearance, revised)
assert.equal(changed.revision, 2)
assert.deepEqual(runCli(['show', pal.id]).appearance, revised)
assert.equal(readFileSync(revision1, 'utf8'), bytes1)
checks.push('native CLI creates spark/violet, updates sprout/blue and reads the saved choice in a fresh process')

const storeOptions = {
  root: join(home, 'pals'),
  workspaceRoot: join(dirname(home), `${basename(home)}-workspaces`, 'pals'),
}
const store = new sdk.DiskPalStore(storeOptions)
assert.deepEqual(store.getRevision(pal.id, 1).appearance, initial)
assert.deepEqual(store.get(pal.id).appearance, revised)
assert.deepEqual(new sdk.DiskPalStore(storeOptions).get(pal.id).appearance, revised)
checks.push('native SDK restart reads the current appearance and unchanged immutable original revision')

const count = runCli(['list']).length
for (const choice of ['pixel', 'unknown/green', 'pixel/red', 'pixel/green/extra']) {
  runCli(['create', 'Invalid appearance', '--appearance', choice], EXIT_USAGE)
  assert.equal(runCli(['list']).length, count)
}
runCli(['update', pal.id, '--revision', '1', '--appearance', 'pixel/green'], EXIT_USAGE)
assert.equal(runCli(['show', pal.id]).revision, 2)
assert.deepEqual(readdirSync(join(home, 'pals', pal.id, 'revisions')).sort(), ['1.json', '2.json'])
checks.push('invalid appearance flags create no Pal; a stale native CLI edit publishes no revision')

const makeOwner = () => new Operator({
  program: process.execPath,
  args: [cli, 'acp', '--desktop'],
  env,
}, () => {}, join(home, 'desktop-registry'))
let owner = makeOwner()
let desktopPal
try {
  assert.deepEqual((await owner.listPals()).find((item) => item.id === pal.id).appearance, revised)
  desktopPal = await owner.createPal({
    name: 'Native desktop appearance',
    appearance: { character: 'pixel', color: 'amber' },
  })
  assert.deepEqual(desktopPal.appearance, { character: 'pixel', color: 'amber' })
  const original = readFileSync(join(home, 'pals', desktopPal.id, 'revisions', '1.json'), 'utf8')
  const edited = await owner.updatePal(desktopPal.id, 1, {
    appearance: { character: 'spark', color: 'rose' },
  })
  assert.deepEqual(edited.appearance, { character: 'spark', color: 'rose' })
  assert.deepEqual((await owner.listPals()).find((item) => item.id === desktopPal.id).appearance, edited.appearance)
  assert.equal(readFileSync(join(home, 'pals', desktopPal.id, 'revisions', '1.json'), 'utf8'), original)
  await assert.rejects(owner.updatePal(desktopPal.id, 2, {
    appearance: { character: 'spark', color: 'red' },
  }), /appearance/i)
  assert.equal(store.get(desktopPal.id).revision, 2)
  checks.push('production desktop Operator and native CLI ACP create/update/list forward the saved appearance unchanged')
  checks.push('invalid ACP appearance is rejected by the shared SDK store without a revision')
} finally {
  await owner.close()
}
owner = makeOwner()
try {
  const list = await owner.listPals()
  assert.deepEqual(list.find((item) => item.id === desktopPal.id).appearance, { character: 'spark', color: 'rose' })
  assert.deepEqual(store.getRevision(desktopPal.id, 1).appearance, { character: 'pixel', color: 'amber' })
  const legacy = await owner.createPal({ name: 'Legacy appearance omitted' })
  assert.equal(Object.hasOwn(legacy, 'appearance'), false)
  assert.equal(Object.hasOwn(store.get(legacy.id), 'appearance'), false)
  checks.push('new Operator/native ACP process reloads choices; older records keep appearance absent without an SDK default')
} finally {
  await owner.close()
}
checks.push('both owned Operator/native ACP connections confirm shutdown')
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const inspection = spawnSync(powershell, [
  '-NoProfile', '-NonInteractive', '-Command',
  `$prefix='${snapshot.replaceAll("'", "''")}'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains($prefix) -and $_.CommandLine.Contains('--desktop') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`,
], { encoding: 'utf8', windowsHide: true, shell: false })
assert.equal(inspection.status, 0, inspection.stderr)
assert.equal(inspection.stdout.trim(), '', 'An owned native ACP process remains after confirmed close.')
checks.push('read-only native process inventory finds no fixture ACP process after shutdown')
const receipt = {
  passed: true,
  platform: process.platform,
  node: process.version,
  callerWorkingDirectoryKind: process.cwd().startsWith('\\\\wsl.') ? 'WSL UNC' : 'native Windows',
  checks,
  limitations: [
    'Built local consumer snapshot, not an npm registry install.',
    'Metadata/production Operator/ACP proof only; Electron renderer animation is a separate UI verification.',
    'No model inference, guest startup, engine installation or external messages were performed.',
  ],
}
writeFileSync(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
