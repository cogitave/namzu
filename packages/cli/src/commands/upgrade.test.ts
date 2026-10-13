import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { Formatter } from '../output/index.js'
import {
	type NpmUpgradeRequest,
	type UpgradeCommandDeps,
	createUpgradeCommand,
	npmGlobalPrefixFor,
	removeOwnPowerShellShim,
} from './upgrade.js'

function harness(overrides: Partial<UpgradeCommandDeps> = {}) {
	const printed: unknown[] = []
	const errors: unknown[] = []
	const info: string[] = []
	const formatter: Formatter = {
		name: 'text',
		print: (value) => printed.push(value),
		error: (value) => errors.push(value),
		info: (value) => info.push(value),
	}
	const requests: NpmUpgradeRequest[] = []
	const deps: UpgradeCommandDeps = {
		currentVersion: '14.2.1',
		packageRoot: '/opt/namzu/lib/node_modules/@namzu/cli',
		platform: 'linux',
		latestVersion: async () => '14.3.0',
		runNpm: async (request) => {
			requests.push(request)
			return 0
		},
		installedVersion: () => '14.3.0',
		...overrides,
	}
	const command = createUpgradeCommand(deps)
	const invoke = (rawArgs: readonly string[] = []) =>
		command.handler({ ctx: { config: {}, formatter }, rawArgs })
	return { invoke, requests, printed, errors, info }
}

describe('npm global installation ownership', () => {
	it('derives Unix and Windows prefixes from the executing package root', () => {
		expect(npmGlobalPrefixFor('/home/a/.namzu/lib/node_modules/@namzu/cli', 'linux')).toBe(
			'/home/a/.namzu',
		)
		expect(
			npmGlobalPrefixFor('C:\\Users\\A\\AppData\\Roaming\\npm\\node_modules\\@namzu\\cli', 'win32'),
		).toBe('C:\\Users\\A\\AppData\\Roaming\\npm')
	})

	it('does not mistake a checkout or another package-manager layout for npm global', () => {
		expect(npmGlobalPrefixFor('/work/namzu/packages/cli', 'linux')).toBeNull()
		expect(
			npmGlobalPrefixFor('/home/a/.local/share/pnpm/global/5/node_modules/@namzu/cli', 'linux'),
		).toBeNull()
	})
})

describe('namzu upgrade', () => {
	it('checks without spawning and names the command that can apply the update', async () => {
		const h = harness()
		expect(await h.invoke(['--check'])).toBe(0)
		expect(h.requests).toEqual([])
		expect(h.printed).toEqual([
			expect.objectContaining({
				current: '14.2.1',
				latest: '14.3.0',
				upToDate: false,
				text: expect.stringContaining('namzu upgrade'),
			}),
		])
	})

	it('pins npm to the active prefix and exact registry version, then reads that root back', async () => {
		const readback = vi.fn(() => '14.3.0')
		const h = harness({ installedVersion: readback })

		expect(await h.invoke()).toBe(0)
		expect(h.requests).toEqual([
			{
				executable: 'npm',
				prefix: '/opt/namzu',
				args: [
					'install',
					'--global',
					'--prefix',
					'/opt/namzu',
					'--no-fund',
					'--no-audit',
					'--registry',
					'https://registry.npmjs.org',
					'@namzu/cli@14.3.0',
				],
			},
		])
		expect(readback).toHaveBeenCalledWith('/opt/namzu/lib/node_modules/@namzu/cli')
		expect(h.printed).toEqual([
			expect.objectContaining({
				previous: '14.2.1',
				current: '14.3.0',
				updated: true,
			}),
		])
	})

	it('refuses an unrecognized active layout without spawning into an ambient prefix', async () => {
		const runNpm = vi.fn(async () => 0)
		const h = harness({ packageRoot: '/work/namzu/packages/cli', runNpm })
		expect(await h.invoke()).toBe(69)
		expect(runNpm).not.toHaveBeenCalled()
		expect(h.errors).toEqual([
			expect.objectContaining({
				message: expect.stringContaining('not running from a recognized'),
			}),
		])
	})

	it('does not claim success when npm exits zero but the active root stays old', async () => {
		const h = harness({ installedVersion: () => '14.2.1' })
		expect(await h.invoke()).toBe(1)
		expect(h.errors).toEqual([
			expect.objectContaining({
				message: expect.stringContaining('still reports 14.2.1'),
			}),
		])
		expect(h.printed).toEqual([])
	})

	it('does not spawn when the active version is already current', async () => {
		const runNpm = vi.fn(async () => 0)
		const h = harness({ latestVersion: async () => '14.2.1', runNpm })
		expect(await h.invoke()).toBe(0)
		expect(runNpm).not.toHaveBeenCalled()
		expect(h.printed).toEqual([expect.objectContaining({ upToDate: true })])
	})

	it('refuses unknown arguments before checking the registry', async () => {
		const latestVersion = vi.fn(async () => '14.3.0')
		const h = harness({ latestVersion })
		expect(await h.invoke(['--force'])).toBe(64)
		expect(latestVersion).not.toHaveBeenCalled()
	})
})

describe('the PowerShell shim after an upgrade', () => {
	const winRoot = 'C:\\Users\\A\\AppData\\Roaming\\npm\\node_modules\\@namzu\\cli'

	it('is removed from the npm prefix after a verified update on Windows', async () => {
		const removed: string[] = []
		const h = harness({
			platform: 'win32',
			packageRoot: winRoot,
			removePowerShellShim: (prefix) => void removed.push(prefix),
		})
		expect(await h.invoke()).toBe(0)
		expect(removed).toEqual(['C:\\Users\\A\\AppData\\Roaming\\npm'])
	})

	it('is left alone on other platforms and when the update was not verified', async () => {
		const removed: string[] = []
		const remove = (prefix: string) => void removed.push(prefix)
		await harness({ removePowerShellShim: remove }).invoke()
		await harness({
			platform: 'win32',
			packageRoot: winRoot,
			installedVersion: () => '14.2.1',
			removePowerShellShim: remove,
		}).invoke()
		await harness({
			platform: 'win32',
			packageRoot: winRoot,
			runNpm: async () => 1,
			removePowerShellShim: remove,
		}).invoke()
		expect(removed).toEqual([])
	})

	it('does not turn a failing removal into a failed update', async () => {
		const h = harness({
			platform: 'win32',
			packageRoot: winRoot,
			removePowerShellShim: () => {
				throw new Error('EPERM')
			},
		})
		expect(await h.invoke()).toBe(0)
	})

	it('removes only our own namzu.ps1, beside namzu.cmd', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-shim-'))
		try {
			const ours = join(dir, 'ours')
			const theirs = join(dir, 'theirs')
			const lone = join(dir, 'lone')
			for (const d of [ours, theirs, lone]) mkdirSync(d)
			writeFileSync(join(ours, 'namzu.cmd'), '@echo off')
			writeFileSync(
				join(ours, 'namzu.ps1'),
				'& "$basedir/node_modules/@namzu/cli/dist/bin.js" $args',
			)
			writeFileSync(join(theirs, 'namzu.cmd'), '@echo off')
			writeFileSync(join(theirs, 'namzu.ps1'), '# another tool')
			writeFileSync(join(lone, 'namzu.ps1'), '"@namzu/cli"')
			expect(removeOwnPowerShellShim(ours)).toBe(true)
			expect(existsSync(join(ours, 'namzu.ps1'))).toBe(false)
			expect(existsSync(join(ours, 'namzu.cmd'))).toBe(true)
			expect(removeOwnPowerShellShim(theirs)).toBe(false)
			expect(removeOwnPowerShellShim(lone)).toBe(false)
			expect(removeOwnPowerShellShim(join(dir, 'missing'))).toBe(false)
			expect(existsSync(join(theirs, 'namzu.ps1'))).toBe(true)
			expect(existsSync(join(lone, 'namzu.ps1'))).toBe(true)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
