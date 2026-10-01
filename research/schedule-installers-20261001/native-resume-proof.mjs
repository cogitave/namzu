// Run with node --import tsx research/schedule-installers-20261001/native-resume-proof.mjs.
// Calls a process-local PowerShell function, never an installed Namzu command.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resumeCommand } from '../../packages/cli/src/schedule/resume-command.js'

const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows'
const executable = process.platform === 'win32'
  ? join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
if (!existsSync(executable)) throw new Error('Native Windows PowerShell 5.1 is required for this proof')

const extra = "C:\\extra dir's [literal] $(throw 'expanded')"
const sessionId = "literal-session-$(throw 'expanded')"
const command = resumeCommand({
  folder: { path: windowsRoot, canonical: windowsRoot },
  permissions: { additionalDirectories: [extra] },
}, sessionId, 'win32')
const missing = `C:\\namzu-resume-proof-missing-${randomUUID()}`
const refusedCommand = resumeCommand({
  folder: { path: missing, canonical: missing },
  permissions: {},
}, 'must-not-run', 'win32')

const script = `
$ErrorActionPreference = 'Stop'
function namzu.cmd {
  [pscustomobject]@{ cwd=(Get-Location).Path; arguments=@($args) } | ConvertTo-Json -Compress
}
${command}
function namzu.cmd { throw 'Resume ran after a failed directory change' }
$ErrorActionPreference = 'Continue'
${refusedCommand} 2>$null
Write-Output 'directory-guard-complete'
`
const result = spawnSync(executable, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted',
  '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
], {
  cwd: process.platform === 'win32' ? windowsRoot : '/mnt/c',
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000, // A real native subprocess; assertions use its output, never elapsed speed.
})
assert.equal(result.error, undefined, result.error?.message)
assert.equal(result.status, 0, result.stderr)
const lines = result.stdout.trim().split(/\r?\n/)
const receipt = JSON.parse(lines[0])
assert.equal(receipt.cwd.toLowerCase(), windowsRoot.toLowerCase())
assert.deepEqual(receipt.arguments, ['--add-dir', extra, 'resume', sessionId])
assert.deepEqual(lines.slice(1), ['directory-guard-complete'])
assert.doesNotMatch(result.stderr, /Resume ran|expanded/)
process.stdout.write(`${JSON.stringify({
  platform: 'Windows PowerShell 5.1',
  installedNamzuInvoked: false,
  literalArguments: true,
  guardedDirectoryChange: true,
  status: result.status,
}, null, 2)}\n`)
