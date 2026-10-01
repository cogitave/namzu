// Bundle this entry for native Windows Node with the preparation script.
// Real Windows files/shells; no model, service, installation or user-config changes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildJob, confirmJob, previewLines } from '../../packages/cli/src/schedule/build.js'
import { schedulePaths } from '../../packages/cli/src/schedule/paths.js'
import { compileJobPolicy } from '../../packages/cli/src/schedule/policy.js'
import { confirmationHolds, createJob, readJob, updateJob } from '../../packages/cli/src/schedule/store/jobs.js'
import { resumeInvocation } from '../../packages/cli/src/resume-invocation.js'
import { resumeCommand } from '../../packages/cli/src/schedule/resume-command.js'
import { buildScheduleTools } from '../../packages/sdk/src/tools/schedules/schedule-tool.js'

assert.equal(process.platform, 'win32', 'This proof must execute in native Windows Node')
const root = mkdtempSync(join(tmpdir(), 'namzu-native-schedule-'))
const osHome = join(root, 'isolated-user')
const home = join(osHome, '.namzu-proof')
const project = join(osHome, "project's space [literal]")
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.NAMZU_HOME = home
const paths = schedulePaths(home)
const now = new Date('2026-10-01T12:00:00Z')
const request = {
  name: 'native-schedule', prompt: 'Report only; no provider is invoked by this proof.',
  when: '0 10 * * *', tz: 'Europe/Istanbul', folder: project,
  permissions: { preset: 'read-only', unmatched: 'deny' },
  model: 'zen/space-bunny-free', createdBy: { surface: 'cli' },
}
const build = (budget, config = {}) => buildJob({ ...request, ...(budget === undefined ? {} : { budget }) }, { paths, config, now, osHome })
const unlimited = build()
assert.equal(unlimited.budget.tokenBudget, 0)
assert.equal(unlimited.budget.maxIterations, 50)
assert.equal(unlimited.budget.timeoutMs, 1800000)
assert.equal(build(undefined, { limits: { tokenBudget: 75000 } }).budget.tokenBudget, 75000)
assert.equal(build({ tokenBudget: 0 }, { limits: { tokenBudget: 75000 } }).budget.tokenBudget, 0)
assert.equal(build({ tokenBudget: 25000 }).budget.tokenBudget, 25000)
for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => build({ tokenBudget: value }), /token budget/)
}
const saved = createJob(paths, confirmJob(unlimited, 'cli-tty', now, { paths }))
const loaded = readJob(paths, saved.id)
assert.equal(loaded.budget.tokenBudget, 0)
assert.equal(confirmationHolds(loaded), true)
assert.equal(JSON.parse(readFileSync(paths.job(saved.id), 'utf8')).budget.tokenBudget, 0)
const finite = updateJob(paths, saved.id, saved.revision, job => ({ ...job, budget: { ...job.budget, tokenBudget: 75000 } }))
assert.equal(confirmationHolds(finite), false)
const reconfirmed = updateJob(paths, finite.id, finite.revision, job => confirmJob(job, 'cli-tty', now, { paths }))
assert.equal(confirmationHolds(reconfirmed), true)
assert.equal(readJob(paths, saved.id).budget.tokenBudget, 75000)
const policy = compileJobPolicy(unlimited.permissions, { layers: [], namzuHome: home, folder: unlimited.folder })
const lines = previewLines(unlimited, policy, now).join('\n')
assert.match(lines, /no token limit/)
assert.match(lines, /no daily token limit/)
assert.doesNotMatch(lines, /0 tokens|Warning.*tokens/)

const proposals=[]
const tool = buildScheduleTools({
  preview: async draft => {
    proposals.push(draft)
    return {
      name: draft.name, folder: project, outsideSessionRoots: false, prompt: draft.prompt,
      schedule: 'at 10:00 every day (Europe/Istanbul)', nextFireTimes: ['2026-10-02T07:00:00.000Z'],
      rules: ['read: allow'], unmatched: 'deny', execution: 'host', networkAccess: false,
      budget: unlimited.budget, model: 'zen/space-bunny-free', warnings: [],
    }
  },
  confirm: async () => 'create-paused',
  create: async (_draft, preview) => ({ name: preview.name }),
  list: async () => [], find: async () => undefined, confirmAction: async () => false,
  pause: async () => {}, resume: async () => {}, delete: async () => {},
})[0]
const input = tool.inputSchema.parse({ action: 'create', name: 'native-tool', prompt: 'Report only.', when: '0 10 * * *', permissions: request.permissions, budget: { tokenBudget: 0 } })
assert.equal((await tool.execute(input, {})).success, true)
assert.equal(proposals[0].budget.tokenBudget, 0)

// A real npm-shaped .cmd forwards to a harmless fixture in a private prefix.
const prefix = join(root, 'private prefix')
const bin = join(prefix, 'node_modules', '@namzu', 'cli', 'dist', 'bin.js')
mkdirSync(join(prefix, 'node_modules', '@namzu', 'cli', 'dist'), { recursive: true })
writeFileSync(bin, "process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n')\n")
const shim = join(prefix, 'namzu.cmd')
const header = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
  'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
]
writeFileSync(shim, `${header.join('\r\n')}\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@namzu\\cli\\dist\\bin.js" %*\r\n`)
assert.deepEqual(resumeInvocation(bin, `${prefix};${process.env.PATH}`), ['namzu.cmd'])
const environment = { ...process.env, PATH: `${prefix};${process.env.PATH}` }
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const cmd = join(systemRoot, 'System32', 'cmd.exe')
const cmdResult = spawnSync(cmd, ['/d', '/s', '/c', 'namzu.cmd resume native-cmd-session --add-dir "C:\\literal space [brackets]"'], {
  cwd: project, env: environment, encoding: 'utf8', windowsHide: true,
  // CMD consumes one command string; Node's default C-runtime quoting is not CMD quoting.
  windowsVerbatimArguments: true,
})
assert.equal(cmdResult.error, undefined, cmdResult.error?.message)
assert.equal(cmdResult.status, 0, cmdResult.stderr)
const cmdReceipt = JSON.parse(cmdResult.stdout.trim())
assert.deepEqual(cmdReceipt.args, ['resume', 'native-cmd-session', '--add-dir', 'C:\\literal space [brackets]'])
assert.equal(cmdReceipt.cwd, project)

const extra = "C:\\literal dir's [brackets] $(throw 'expanded')"
const sessionId = "literal-session-$(throw 'expanded')"
const command = resumeCommand({ folder: { path: project, canonical: project }, permissions: { additionalDirectories: [extra] } }, sessionId)
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const psResult = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
  cwd: root, env: environment, encoding: 'utf8', windowsHide: true,
})
assert.equal(psResult.error, undefined, psResult.error?.message)
assert.equal(psResult.status, 0, psResult.stderr)
const psReceipt = JSON.parse(psResult.stdout.trim())
assert.equal(psReceipt.cwd, project)
assert.deepEqual(psReceipt.args, ['--add-dir', extra, 'resume', sessionId])

const receipt = {
  platform: process.platform, node: process.version, root,
  scope: 'Bundled production scheduler/tool/resume modules on native Windows; not a packaged CLI or live provider test',
  defaults: unlimited.budget, configuredFinitePreserved: true, explicitZeroOverridesFinite: true,
  invalidBudgetsRefused: true, actualWindowsStoreRoundtrip: true, freshConfirmationRequired: true,
  truthfulUnlimitedPreview: true, sdkToolZeroForwarded: true,
  exactNpmCmdShimRecognized: true, actualCmdArgumentForwarding: true,
  actualPowerShellCmdForwarding: true, literalArgumentsPreserved: true,
  installedNamzuInvoked: false, providerInvoked: false, serviceInstalled: false,
}
writeFileSync(join(root, 'receipt.json'), `${JSON.stringify(receipt,null,2)}\n`)
process.stdout.write(`${JSON.stringify(receipt,null,2)}\n`)
