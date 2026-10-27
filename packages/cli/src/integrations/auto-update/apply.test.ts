import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	type ApplyDeps,
	type InstallerRequest,
	applyUpdate,
	classifyInstallerFailure,
	manualUpdateCommand,
	npmInstallArgs,
	pnpmInstallArgs,
	repairInterruptedUpdate,
} from './apply.js'
import type { InstallKind } from './install-kind.js'
import { readInstalledVersion } from './installed-version.js'
import { acquireUpdateLock, previousDir, readInProgress, readLastResult } from './state.js'

let dir: string
let home: string
let prefix: string
let root: string

function writePackage(at: string, version: string, extra = ''): void {
	mkdirSync(at, { recursive: true })
	writeFileSync(join(at, 'package.json'), JSON.stringify({ name: '@namzu/cli', version }))
	writeFileSync(join(at, 'marker.txt'), `${version}${extra}`)
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-apply-'))
	home = join(dir, 'home')
	prefix = join(dir, 'prefix')
	root = join(prefix, 'lib', 'node_modules', '@namzu', 'cli')
	writePackage(root, '1.0.0')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const npm = (
	over: Partial<Extract<InstallKind, { kind: 'npm-global' }>> = {},
): Extract<InstallKind, { kind: 'npm-global' }> => ({
	kind: 'npm-global',
	root,
	prefix,
	owned: false,
	writable: true,
	...over,
})

function deps(over: Partial<ApplyDeps> = {}, install: ApplyDeps['install'] = npm()): ApplyDeps {
	return {
		home,
		install,
		currentVersion: '1.0.0',
		platform: 'linux',
		installedVersion: readInstalledVersion,
		smokeTest: async (at, version) => readInstalledVersion(at) === version,
		runInstaller: async () => {
			writePackage(root, '2.0.0')
			return 0
		},
		pid: 4242,
		isAlive: () => true,
		...over,
	}
}

const release = { version: '2.0.0', integrity: 'sha512-AAAA' }

describe('applying an update to an npm global installation', () => {
	it('installs the exact version, keeps the old copy and records nothing the caller must undo', async () => {
		const requests: InstallerRequest[] = []
		const result = await applyUpdate(
			deps({
				runInstaller: async (request) => {
					requests.push(request)
					writePackage(root, '2.0.0')
					return 0
				},
			}),
			release,
		)
		expect(result).toEqual({ status: 'installed', from: '1.0.0', to: '2.0.0' })
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({ executable: 'npm', cwd: prefix })
		expect(requests[0]?.args).toEqual(npmInstallArgs(prefix, '2.0.0'))
		expect(readInstalledVersion(root)).toBe('2.0.0')
		expect(readFileSync(join(previousDir(home, '1.0.0'), 'marker.txt'), 'utf8')).toBe('1.0.0')
		expect(existsSync(join(home, 'updates', 'update.lock'))).toBe(false)
	})

	it('uses npm.cmd on Windows and removes the PowerShell shim only after a verified update', async () => {
		const removed: string[] = []
		const requests: InstallerRequest[] = []
		const base = deps({
			platform: 'win32',
			removePowerShellShim: (p) => void removed.push(p),
			runInstaller: async (request) => {
				requests.push(request)
				writePackage(root, '2.0.0')
				return 0
			},
		})
		await applyUpdate(base, release)
		expect(requests[0]?.executable).toBe('npm.cmd')
		expect(removed).toEqual([prefix])
	})

	it('refuses a version the registry gave no checksum for, and installs nothing', async () => {
		const run = vi.fn(async () => 0)
		const result = await applyUpdate(deps({ runInstaller: run }), { version: '2.0.0' })
		expect(result).toMatchObject({ status: 'failed', code: 'unverifiable', restored: true })
		expect(run).not.toHaveBeenCalled()
	})

	it('does not try when the folder is not writable', async () => {
		const run = vi.fn(async () => 0)
		const result = await applyUpdate(deps({ runInstaller: run }, npm({ writable: false })), release)
		expect(result).toMatchObject({ status: 'failed', code: 'no_permission' })
		expect(run).not.toHaveBeenCalled()
	})

	it('does nothing when another process already put this version on disk', async () => {
		writePackage(root, '2.0.0')
		const run = vi.fn(async () => 0)
		expect(await applyUpdate(deps({ runInstaller: run }), release)).toEqual({
			status: 'already',
			to: '2.0.0',
		})
		expect(run).not.toHaveBeenCalled()
	})

	it('backs off while another process holds the lock', async () => {
		const held = acquireUpdateLock({ home, pid: 77, isAlive: () => true })
		const run = vi.fn(async () => 0)
		expect(await applyUpdate(deps({ runInstaller: run }), release)).toEqual({ status: 'locked' })
		expect(run).not.toHaveBeenCalled()
		held?.release()
		expect((await applyUpdate(deps(), release)).status).toBe('installed')
	})

	it('puts the old version back when the installer fails half way', async () => {
		const result = await applyUpdate(
			deps({
				runInstaller: async (request) => {
					rmSync(join(root, 'package.json'))
					request.onOutput(
						'npm error code EINTEGRITY\nnpm error sha512-x integrity checksum failed',
					)
					return 1
				},
			}),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', code: 'integrity', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(readFileSync(join(root, 'marker.txt'), 'utf8')).toBe('1.0.0')
	})

	it('leaves an untouched old version alone when the installer fails before changing anything', async () => {
		const smoke = vi.fn(async () => true)
		const result = await applyUpdate(
			deps({
				smokeTest: smoke,
				runInstaller: async (request) => {
					request.onOutput('EACCES: permission denied')
					return 1
				},
			}),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', code: 'no_permission', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
	})

	it('restores when the installer exits zero but the folder still reports another version', async () => {
		const result = await applyUpdate(
			deps({
				runInstaller: async () => {
					writePackage(root, '1.5.0')
					return 0
				},
			}),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
	})

	it('restores when the new copy does not start', async () => {
		const result = await applyUpdate(deps({ smokeTest: async () => false }), release)
		expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(readFileSync(join(root, 'marker.txt'), 'utf8')).toBe('1.0.0')
	})

	it('says so when the old version could not be put back', async () => {
		const result = await applyUpdate(
			deps({
				smokeTest: async () => {
					rmSync(previousDir(home, '1.0.0'), { recursive: true, force: true })
					return false
				},
			}),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', restored: false })
		expect(result.status === 'failed' && result.detail).toContain('could not be put back')
	})

	it('does not install at all when a copy of the current version cannot be kept', async () => {
		mkdirSync(home, { recursive: true })
		writeFileSync(join(home, 'updates'), 'a file where the folder must go')
		const run = vi.fn(async () => 0)
		const result = await applyUpdate(deps({ runInstaller: run }), release)
		expect(result.status).toBe('failed')
		expect(run).not.toHaveBeenCalled()
	})

	it('keeps only the two newest previous copies', async () => {
		for (const version of ['0.8.0', '0.9.0']) {
			mkdirSync(previousDir(home, version), { recursive: true })
		}
		await applyUpdate(deps(), release)
		const kept = ['0.8.0', '0.9.0', '1.0.0'].filter((v) => existsSync(previousDir(home, v)))
		expect(kept).toHaveLength(2)
		expect(kept).toContain('1.0.0')
	})
})

describe('applying an update to a pnpm global installation', () => {
	const globalDir = () => join(dir, 'pnpm', 'global', '5')
	const active = () => join(globalDir(), 'node_modules', '@namzu', 'cli')
	const pnpm = (): Extract<InstallKind, { kind: 'pnpm-global' }> => ({
		kind: 'pnpm-global',
		root: join(globalDir(), '.pnpm', '@namzu+cli@1.0.0', 'node_modules', '@namzu', 'cli'),
		globalDir: globalDir(),
		writable: true,
	})

	it('reads the version from the link pnpm repoints, not the old store folder', async () => {
		writePackage(active(), '1.0.0')
		const requests: InstallerRequest[] = []
		const result = await applyUpdate(
			deps(
				{
					runInstaller: async (request) => {
						requests.push(request)
						writePackage(active(), '2.0.0')
						return 0
					},
				},
				pnpm(),
			),
			release,
		)
		expect(result).toEqual({ status: 'installed', from: '1.0.0', to: '2.0.0' })
		expect(requests[0]).toMatchObject({ executable: 'pnpm', cwd: globalDir() })
		expect(requests[0]?.args).toEqual(pnpmInstallArgs('2.0.0'))
	})

	it('installs the previous version again when the new one does not start', async () => {
		writePackage(active(), '1.0.0')
		const requests: InstallerRequest[] = []
		const result = await applyUpdate(
			deps(
				{
					smokeTest: async () => false,
					runInstaller: async (request) => {
						requests.push(request)
						writePackage(active(), request.args.at(-1)?.endsWith('@2.0.0') ? '2.0.0' : '1.0.0')
						return 0
					},
				},
				pnpm(),
			),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
		expect(requests.map((r) => r.args.at(-1))).toEqual(['@namzu/cli@2.0.0', '@namzu/cli@1.0.0'])
	})
})

describe('what a person is told to run', () => {
	it('is the shared upgrade command where Namzu can write, and the exact manager command where it cannot', () => {
		expect(manualUpdateCommand(npm(), '2.0.0', 'linux')).toBe('namzu upgrade')
		expect(manualUpdateCommand(npm({ writable: false, prefix: '/usr' }), '2.0.0', 'linux')).toBe(
			'sudo npm install --global --prefix /usr @namzu/cli@2.0.0',
		)
		expect(
			manualUpdateCommand(
				npm({ writable: false, prefix: 'C:\\Program Files\\nodejs' }),
				'2.0.0',
				'win32',
			),
		).toBe('npm install --global --prefix "C:\\Program Files\\nodejs" @namzu/cli@2.0.0')
		expect(
			manualUpdateCommand(
				{ kind: 'pnpm-global', root: '/x', globalDir: '/g', writable: false },
				'2.0.0',
				'linux',
			),
		).toBe('pnpm add --global @namzu/cli@2.0.0')
		expect(manualUpdateCommand({ kind: 'unknown', root: '/x' }, '2.0.0', 'linux')).toBeNull()
	})

	it('names the cause from what the installer printed', () => {
		expect(classifyInstallerFailure('npm error code EACCES')).toBe('no_permission')
		expect(classifyInstallerFailure('EBUSY: resource busy or locked')).toBe('in_use')
		expect(classifyInstallerFailure('npm error code EINTEGRITY')).toBe('integrity')
		expect(classifyInstallerFailure('npm error code ENOTFOUND')).toBe('network')
		expect(classifyInstallerFailure('ENOSPC: no space left on device')).toBe('disk_full')
		expect(classifyInstallerFailure('something else')).toBe('install_failed')
	})

	it('reads nothing from a record that was never written', () => {
		expect(readLastResult(home)).toBeUndefined()
	})
})

describe('repairing an update that was interrupted', () => {
	const DEAD = 99_999_999

	/** The start check a later process runs: the half-written copy does not answer. */
	const repairDeps = (pid: number) =>
		deps({ pid, smokeTest: async (at) => !existsSync(join(at, 'partial.txt')) }) as never

	async function interrupt(): Promise<void> {
		await expect(
			applyUpdate(
				deps({
					pid: DEAD,
					runInstaller: async () => {
						// The new files are half there, then the process dies before any check.
						writePackage(root, '2.0.0')
						writeFileSync(join(root, 'partial.txt'), 'x')
						return 0
					},
					smokeTest: async () => {
						throw new Error('killed')
					},
				}),
				release,
			),
		).rejects.toThrow('killed')
	}

	it('leaves a marker naming the version and the kept copy while an update is under way', async () => {
		await interrupt()
		expect(readInProgress(home)).toMatchObject({ pid: DEAD, from: '1.0.0', to: '2.0.0' })
	})

	it('puts the kept copy back on the next start when the installed one does not answer', async () => {
		await interrupt()
		const result = await repairInterruptedUpdate(repairDeps(5151))
		expect(result).toEqual({ status: 'restored', from: '1.0.0', to: '2.0.0' })
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(existsSync(join(root, 'partial.txt'))).toBe(false)
		expect(readInProgress(home)).toBeUndefined()
		expect(existsSync(join(home, 'updates', 'update.lock'))).toBe(false)
	})

	it('accepts the new version when the interrupted install actually finished and answers', async () => {
		await expect(
			applyUpdate(
				deps({
					pid: DEAD,
					runInstaller: async () => {
						writePackage(root, '2.0.0')
						return 0
					},
					smokeTest: async () => {
						throw new Error('killed')
					},
				}),
				release,
			),
		).rejects.toThrow('killed')
		const result = await repairInterruptedUpdate(repairDeps(5151))
		expect(result).toEqual({ status: 'completed', from: '1.0.0', to: '2.0.0' })
		expect(readInProgress(home)).toBeUndefined()
	})

	it('does not touch anything while the process that started the update still runs', async () => {
		await interrupt()
		const marker = readInProgress(home)
		expect(marker).toBeDefined()
		// A live process is simulated by this test's parent.
		writeFileSync(
			join(home, 'updates', 'in-progress.json'),
			JSON.stringify({ ...marker, pid: process.ppid }),
		)
		expect(await repairInterruptedUpdate(repairDeps(5151))).toEqual({ status: 'busy' })
	})

	it('reports nothing to do when no update was interrupted', async () => {
		expect(await repairInterruptedUpdate(deps() as never)).toEqual({ status: 'none' })
	})

	it('clears the marker after a normal update', async () => {
		await applyUpdate(deps(), release)
		expect(readInProgress(home)).toBeUndefined()
	})

	it('leaves the package in place if the swap back cannot finish', async () => {
		await interrupt()
		const marker = readInProgress(home)
		rmSync(marker?.backup as string, { recursive: true, force: true })
		const result = await repairInterruptedUpdate(repairDeps(5151))
		expect(result.status).toBe('unrepaired')
		expect(readInProgress(home)).toBeDefined()
	})
})

describe('what the installer is told to do', () => {
	it('lets the package run its own install steps, as the installer script does', () => {
		expect(npmInstallArgs(prefix, '2.0.0')).not.toContain('--ignore-scripts')
		expect(pnpmInstallArgs('2.0.0')).not.toContain('--ignore-scripts')
	})

	it('records the installer process so a later start leaves a running install alone', async () => {
		let seen: unknown
		await applyUpdate(
			deps({
				runInstaller: async (request) => {
					request.onSpawn?.(777)
					seen = readInProgress(home)
					writePackage(root, '2.0.0')
					return 0
				},
			}),
			release,
		)
		expect(seen).toMatchObject({ installerPid: 777, from: '1.0.0', to: '2.0.0' })
	})
})

describe('trusting an in-progress marker', () => {
	const DEAD = 99_999_999
	const marker = (over: Record<string, unknown>) => {
		mkdirSync(join(home, 'updates'), { recursive: true })
		writeFileSync(
			join(home, 'updates', 'in-progress.json'),
			JSON.stringify({ pid: DEAD, from: '1.0.0', to: '2.0.0', at: Date.now(), ...over }),
		)
	}
	const repairDeps = () => deps({ pid: 5151, smokeTest: async () => true }) as never

	it('waits while the installer it names still runs', async () => {
		marker({ installerPid: process.ppid })
		expect(await repairInterruptedUpdate(repairDeps())).toEqual({ status: 'busy' })
	})

	it('treats an old marker as dead even when its process id is in use again', async () => {
		marker({ pid: process.ppid, at: Date.now() - 16 * 60_000 })
		const result = await repairInterruptedUpdate(repairDeps())
		expect(result.status).toBe('unchanged')
		expect(readInProgress(home)).toBeUndefined()
	})

	it('says nothing changed when the update never reached the folder', async () => {
		marker({})
		expect(await repairInterruptedUpdate(repairDeps())).toEqual({
			status: 'unchanged',
			from: '1.0.0',
			to: '2.0.0',
		})
	})

	it('ignores a marker whose versions are not versions', () => {
		marker({ from: '../../etc' })
		expect(readInProgress(home)).toBeUndefined()
	})

	it('never restores from a folder outside the kept copies', async () => {
		const outside = join(dir, 'elsewhere')
		writePackage(outside, '1.0.0')
		marker({ backup: outside })
		const result = await repairInterruptedUpdate(
			deps({ pid: 5151, smokeTest: async () => false }) as never,
		)
		expect(result.status).toBe('unrepaired')
		expect(existsSync(join(root, 'marker.txt'))).toBe(true)
		expect(readFileSync(join(root, 'marker.txt'), 'utf8')).toBe('1.0.0')
	})
})
