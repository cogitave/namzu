import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { DownloadError } from '../integrations/auto-update/download.js'
import { acquireUpdateLock, installScope, previousDir } from '../integrations/auto-update/state.js'
import type { Formatter } from '../output/index.js'
import {
	type NpmUpgradeRequest,
	type UpgradeCommandDeps,
	createUpgradeCommand,
	npmGlobalPrefixFor,
	removeOwnPowerShellShim,
} from './upgrade.js'

/** What the registry says about a version: its digest and where the tarball is. */
const release = (version: string) => ({
	version,
	integrity: 'sha512-AAAA',
	tarball: `https://registry.npmjs.org/@namzu/cli/-/cli-${version}.tgz`,
})

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
	const tarballs: string[] = []
	const deps: UpgradeCommandDeps = {
		currentVersion: '14.2.1',
		packageRoot: '/opt/namzu/lib/node_modules/@namzu/cli',
		platform: 'linux',
		latestRelease: async () => release('14.3.0'),
		fetchTarball: async (_release, file) => {
			tarballs.push(file)
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, 'checked tarball')
		},
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
	return { invoke, requests, printed, errors, info, tarballs }
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

	it('installs the tarball it checked into the active prefix, then reads that root back', async () => {
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
					'--@namzu:registry=https://registry.npmjs.org',
					h.tarballs[0],
				],
			},
		])
		expect(h.tarballs).toHaveLength(1)
		expect(existsSync(h.tarballs[0] ?? '')).toBe(false)
		expect(readback).toHaveBeenCalledWith('/opt/namzu/lib/node_modules/@namzu/cli')
		expect(h.printed).toEqual([
			expect.objectContaining({
				previous: '14.2.1',
				current: '14.3.0',
				updated: true,
			}),
		])
	})

	it('installs nothing when the download does not match the registry’s checksum', async () => {
		const runNpm = vi.fn(async () => 0)
		const h = harness({
			runNpm,
			fetchTarball: async () => {
				throw new DownloadError('integrity', 'mismatch')
			},
		})
		expect(await h.invoke()).toBe(1)
		expect(runNpm).not.toHaveBeenCalled()
		expect(h.errors).toEqual([
			expect.objectContaining({
				message:
					'The download did not match its checksum, so it was not installed. Nothing was changed.',
			}),
		])
	})

	it('installs nothing when the registry gave no checksum to check against', async () => {
		const runNpm = vi.fn(async () => 0)
		const h = harness({
			runNpm,
			latestRelease: async () => ({ version: '14.3.0' }),
			fetchTarball: undefined,
		})
		expect(await h.invoke()).toBe(1)
		expect(runNpm).not.toHaveBeenCalled()
		expect(h.errors).toEqual([
			expect.objectContaining({ message: expect.stringContaining('did not give a checksum') }),
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
		const h = harness({ latestRelease: async () => release('14.2.1'), runNpm })
		expect(await h.invoke()).toBe(0)
		expect(runNpm).not.toHaveBeenCalled()
		expect(h.printed).toEqual([expect.objectContaining({ upToDate: true })])
	})

	it('refuses unknown arguments before checking the registry', async () => {
		const latestRelease = vi.fn(async () => release('14.3.0'))
		const h = harness({ latestRelease })
		expect(await h.invoke(['--force'])).toBe(64)
		expect(latestRelease).not.toHaveBeenCalled()
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

describe('namzu upgrade keeps a working Namzu', () => {
	function layout() {
		const base = mkdtempSync(join(tmpdir(), 'namzu-upgrade-safety-'))
		const root = join(base, 'prefix', 'lib', 'node_modules', '@namzu', 'cli')
		const home = join(base, 'home')
		mkdirSync(root, { recursive: true })
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: '@namzu/cli', version: '14.2.1' }),
		)
		writeFileSync(join(root, 'marker.txt'), 'old')
		return { base, root, home, prefix: join(base, 'prefix') }
	}
	const install = (root: string, version: string) => {
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@namzu/cli', version }))
		writeFileSync(join(root, 'marker.txt'), 'new')
	}

	it('puts the previous version back when the new one does not start', async () => {
		const l = layout()
		try {
			const h = harness({
				packageRoot: l.root,
				runNpm: async () => {
					install(l.root, '14.3.0')
					return 0
				},
				installedVersion: (root) =>
					(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
						.version,
				safety: { home: l.home, smokeTest: async () => false },
			})
			expect(await h.invoke()).toBe(1)
			expect(h.errors).toEqual([
				expect.objectContaining({
					message: expect.stringContaining('previous version was put back'),
				}),
			])
			expect(readFileSync(join(l.root, 'marker.txt'), 'utf8')).toBe('old')
			expect(h.printed).toEqual([])
		} finally {
			rmSync(l.base, { recursive: true, force: true })
		}
	})

	it('puts the previous version back when the installer dies half way', async () => {
		const l = layout()
		try {
			const h = harness({
				packageRoot: l.root,
				runNpm: async () => {
					rmSync(join(l.root, 'package.json'))
					return 1
				},
				safety: { home: l.home, smokeTest: async () => true },
			})
			expect(await h.invoke()).toBe(1)
			expect(readFileSync(join(l.root, 'marker.txt'), 'utf8')).toBe('old')
			expect(existsSync(join(l.root, 'package.json'))).toBe(true)
		} finally {
			rmSync(l.base, { recursive: true, force: true })
		}
	})

	it('keeps the previous version on disk after a good update', async () => {
		const l = layout()
		try {
			const h = harness({
				packageRoot: l.root,
				runNpm: async () => {
					install(l.root, '14.3.0')
					return 0
				},
				safety: { home: l.home, smokeTest: async () => true },
			})
			expect(await h.invoke()).toBe(0)
			expect(
				readFileSync(
					join(previousDir(l.home, '14.2.1', installScope(l.prefix, 'linux')), 'marker.txt'),
					'utf8',
				),
			).toBe('old')
		} finally {
			rmSync(l.base, { recursive: true, force: true })
		}
	})

	it('does not start while another update holds the lock', async () => {
		const l = layout()
		try {
			const held = acquireUpdateLock({
				home: join(l.prefix, '.namzu-update'),
				scope: installScope(l.prefix, 'linux'),
				pid: process.pid,
				isAlive: () => true,
			})
			const runNpm = vi.fn(async () => 0)
			const h = harness({
				packageRoot: l.root,
				runNpm,
				safety: { home: l.home, smokeTest: async () => true },
			})
			expect(await h.invoke()).toBe(1)
			expect(runNpm).not.toHaveBeenCalled()
			expect(h.errors).toEqual([
				expect.objectContaining({
					message: 'Another Namzu update is already running. Try again in a moment.',
				}),
			])
			held?.release()
		} finally {
			rmSync(l.base, { recursive: true, force: true })
		}
	})

	it('updates a pnpm global installation through pnpm and reads the link it repoints', async () => {
		const base = mkdtempSync(join(tmpdir(), 'namzu-upgrade-pnpm-'))
		try {
			const globalDir = join(base, 'pnpm', 'global', '5')
			const storeRoot = join(
				globalDir,
				'.pnpm',
				'@namzu+cli@14.2.1',
				'node_modules',
				'@namzu',
				'cli',
			)
			const linked = join(globalDir, 'node_modules', '@namzu', 'cli')
			const requests: NpmUpgradeRequest[] = []
			const read = vi.fn(() => '14.3.0')
			const h = harness({
				packageRoot: storeRoot,
				installedVersion: read,
				runNpm: async (request) => {
					requests.push(request)
					return 0
				},
			})
			expect(await h.invoke()).toBe(0)
			const pinned = [
				'--registry',
				'https://registry.npmjs.org',
				'--@namzu:registry=https://registry.npmjs.org',
			]
			expect(requests).toEqual([
				{
					executable: 'pnpm',
					prefix: globalDir,
					args: ['add', '--global', ...pinned, h.tarballs[0]],
				},
				// Then the registry's name for the version, so no `file:` entry stays in the manifest.
				{
					executable: 'pnpm',
					prefix: globalDir,
					args: ['add', '--global', '--prefer-offline', ...pinned, '@namzu/cli@14.3.0'],
				},
			])
			expect(read).toHaveBeenCalledWith(linked)
		} finally {
			rmSync(base, { recursive: true, force: true })
		}
	})

	it('puts the old pnpm version back, offline first and checked, when recording the new one fails', async () => {
		const base = mkdtempSync(join(tmpdir(), 'namzu-upgrade-pnpm-'))
		try {
			const globalDir = join(base, 'pnpm', 'global', '5')
			const storeRoot = join(
				globalDir,
				'.pnpm',
				'@namzu+cli@14.2.1',
				'node_modules',
				'@namzu',
				'cli',
			)
			const calls: string[][] = []
			let version = '14.3.0'
			const smokeTest = vi.fn(async () => true)
			const h = harness({
				packageRoot: storeRoot,
				installedVersion: () => version,
				safety: { home: join(base, 'home'), smokeTest },
				runNpm: async (request) => {
					calls.push([...request.args])
					if (request.args.includes('--prefer-offline')) return 1
					if (request.args.includes('--offline')) version = '14.2.1'
					return 0
				},
			})
			expect(await h.invoke()).toBe(1)
			expect(
				calls.map((args) => args.find((a) => a.startsWith('--o') || a.startsWith('--p'))),
			).toEqual([undefined, '--prefer-offline', '--offline'])
			expect(smokeTest).toHaveBeenCalledWith(
				join(globalDir, 'node_modules', '@namzu', 'cli'),
				'14.2.1',
				'version',
			)
			expect(h.errors).toEqual([
				expect.objectContaining({
					message: expect.stringContaining('The previous version was put back.'),
				}),
			])
			expect(existsSync(join(globalDir, '.namzu-update', 'updates'))).toBe(true)
			const markers = (await import('node:fs'))
				.readdirSync(join(globalDir, '.namzu-update', 'updates'))
				.filter((n) => n.startsWith('in-progress'))
			expect(markers).toEqual([])
		} finally {
			rmSync(base, { recursive: true, force: true })
		}
	})

	it('follows the configured channel when it asks the registry', async () => {
		const latestRelease = vi.fn(async () => release('14.3.0'))
		const printed: unknown[] = []
		const command = createUpgradeCommand({
			currentVersion: '14.2.1',
			packageRoot: '/opt/namzu/lib/node_modules/@namzu/cli',
			platform: 'linux',
			latestRelease,
			runNpm: async () => 0,
			installedVersion: () => '14.3.0',
		})
		await command.handler({
			ctx: {
				config: { updates: { channel: 'stable' } },
				formatter: {
					name: 'text',
					print: (v: unknown) => printed.push(v),
					error: () => {},
					info: () => {},
				},
			},
			rawArgs: ['--check'],
		} as never)
		expect(latestRelease).toHaveBeenCalledWith('stable')
	})
	it('says plainly that no stable release exists when the registry has none', async () => {
		const errors: { message: string }[] = []
		const command = createUpgradeCommand({
			currentVersion: '14.2.1',
			packageRoot: '/opt/namzu/lib/node_modules/@namzu/cli',
			platform: 'linux',
			latestRelease: async () => {
				throw new Error('HTTP 404')
			},
			runNpm: async () => 0,
			installedVersion: () => '14.2.1',
		})
		await command.handler({
			ctx: {
				config: { updates: { channel: 'stable' } },
				formatter: {
					name: 'text',
					print: () => {},
					error: (v: { message: string }) => errors.push(v),
					info: () => {},
				},
			},
			rawArgs: ['--check'],
		} as never)
		expect(errors[0]?.message).toMatch(/No stable release has been published yet/)
	})
})
