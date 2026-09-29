import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The CLI Vitest suite guards every PowerShell launch to protect the user's
// desktop. This process-level test runs separately, with only mocked commands
// inside PowerShell and no installation or desktop interaction.
const powerShell =
	process.platform === 'win32'
		? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
		: process.env.WSL_DISTRO_NAME
			? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
			: null
const installer = readFileSync(fileURLToPath(new URL('../../install.ps1', import.meta.url)), 'utf8')
const skip = !powerShell || !existsSync(powerShell) ? 'Windows PowerShell 5.1 is unavailable' : false

function runInstaller(nodeVersion, npmExit = 0) {
	const env = {
		...process.env,
		NAMZU_INSTALLER_TEST_SOURCE: Buffer.from(installer, 'utf8').toString('base64'),
	}
	// WSL forwards only variables named in WSLENV to Windows processes.
	if (process.env.WSL_DISTRO_NAME)
		env.WSLENV = [process.env.WSLENV, 'NAMZU_INSTALLER_TEST_SOURCE'].filter(Boolean).join(':')
	const wrapper = `
function node { '${nodeVersion}' }
function npm.cmd {
    $global:NpmCalls += ,($args -join ' ')
    if ($args[0] -eq 'install') {
        & "$env:SystemRoot\\System32\\cmd.exe" /d /c 'echo npm-warning 1>&2 & exit ${npmExit}'
        return
    }
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'prefix') { 'C:\\mock-npm' }
}
function namzu.cmd {
    $global:LASTEXITCODE = 0
    'test-version'
}
$global:NpmCalls = @()
$env:Path = 'C:\\mock-node;' + $env:Path
Write-Output "policy=$(Get-ExecutionPolicy)"
Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NAMZU_INSTALLER_TEST_SOURCE)))
if ($global:NpmCalls.Count -ne 1 -or $global:NpmCalls[0] -notlike 'install --global*') {
    throw 'Installer did not call npm.cmd once for install'
}
if ($env:Path -notlike 'C:\\mock-node;*') {
    throw 'Installer discarded the process-local Node path'
}
Write-Output 'mock-install-complete'
`
	return spawnSync(powerShell, ['-NoProfile', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')], {
		encoding: 'utf8',
		env,
		timeout: 30_000,
		windowsHide: true,
	})
}

// The timeout bounds a real subprocess; assertions depend on its output,
// never on how quickly it completed.
test('PowerShell installer uses .cmd shims under Restricted policy', { skip }, () => {
	const result = runInstaller('v22.13.0')
	assert.equal(result.error?.message, undefined, `stdout: ${result.stdout}; stderr: ${result.stderr}`)
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /policy=Restricted/)
	assert.match(result.stdout, /test-version installed/)
	assert.match(result.stdout, /mock-install-complete/)
})

test('PowerShell installer rejects a Node 22 release below the CLI minimum', { skip }, () => {
	const result = runInstaller('v22.12.9')
	assert.equal(result.error?.message, undefined, `stdout: ${result.stdout}; stderr: ${result.stderr}`)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stdout, /namzu needs Node 22\.13 or newer/)
	assert.doesNotMatch(result.stdout, /mock-install-complete/)
})

test('PowerShell installer still reports a failed native npm command', { skip }, () => {
	const result = runInstaller('v22.13.0', 42)
	assert.equal(result.error?.message, undefined, `stdout: ${result.stdout}; stderr: ${result.stderr}`)
	assert.equal(result.status, 1, result.stderr)
	assert.match(result.stdout, /npm install failed \(exit 42\)/)
	assert.doesNotMatch(result.stdout, /mock-install-complete/)
})
