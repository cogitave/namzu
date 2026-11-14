/**
 * The in-session install (`swap: true`): the new version is built beside the live folder, the live
 * chunks are carried into it, and the folders trade places. The installer is a fake that writes the
 * package where npm would put it; nothing here reaches a registry or a real prefix.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	type ApplyDeps,
	type InstallerRequest,
	applyUpdate,
	scopeOf,
	sharedStateHome,
} from './apply.js'
import type { InstallKind } from './install-kind.js'
import { readInstalledVersion } from './installed-version.js'
import { readInProgress } from './state.js'
import { CARRIED_FILE, stagedPackage } from './swap.js'

let dir: string
let home: string
let prefix: string
let root: string

function writePackage(at: string, version: string, chunks: string[]): void {
	mkdirSync(join(at, 'dist', 'chunks'), { recursive: true })
	writeFileSync(join(at, 'package.json'), JSON.stringify({ name: '@namzu/cli', version }))
	for (const name of chunks) writeFileSync(join(at, 'dist', 'chunks', name), `${name}@${version}`)
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-apply-swap-'))
	home = join(dir, 'home')
	prefix = join(dir, 'prefix')
	root = join(prefix, 'lib', 'node_modules', '@namzu', 'cli')
	writePackage(root, '1.0.0', ['old-AAAAAAAA.js', 'shared-BBBBBBBB.js'])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const install: Extract<InstallKind, { kind: 'npm-global' }> = {
	kind: 'npm-global',
	get root() {
		return root
	},
	get prefix() {
		return prefix
	},
	owned: false,
	writable: true,
}

/** Where npm puts the package of a `--prefix <stage>` install. */
function stageOf(request: InstallerRequest): string {
	return request.args[request.args.indexOf('--prefix') + 1] as string
}

function deps(over: Partial<ApplyDeps> = {}): ApplyDeps {
	return {
		home,
		install,
		currentVersion: '1.0.0',
		platform: 'linux',
		swap: true,
		installedVersion: readInstalledVersion,
		smokeTest: async (at, version) => readInstalledVersion(at) === version,
		runInstaller: async (request) => {
			writePackage(stagedPackage(stageOf(request)), '2.0.0', [
				'shared-BBBBBBBB.js',
				'new-CCCCCCCC.js',
			])
			return 0
		},
		fetchTarball: async (_release, file) => {
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, 'checked tarball')
		},
		pid: 4242,
		isAlive: () => true,
		// A second window is running from this install: a swap must not wait for it.
		mayProceed: () => false,
		...over,
	}
}

const release = { version: '2.0.0', integrity: 'sha512-AAAA' }
const chunks = () => readdirSync(join(root, 'dist', 'chunks')).sort()
const leftovers = () =>
	[...readdirSync(dirname(root)), ...readdirSync(prefix)].filter(
		(n) => n.startsWith('.cli-') || n.startsWith('.namzu-stage-'),
	)

describe('installing by swapping the folder', () => {
	it('installs while other windows run, keeps their chunks, and leaves nothing beside the install', async () => {
		const requests: InstallerRequest[] = []
		const result = await applyUpdate(
			deps({
				runInstaller: async (request) => {
					requests.push(request)
					writePackage(stagedPackage(stageOf(request)), '2.0.0', [
						'shared-BBBBBBBB.js',
						'new-CCCCCCCC.js',
					])
					return 0
				},
			}),
			release,
		)
		expect(result).toEqual({ status: 'installed', from: '1.0.0', to: '2.0.0' })
		// The package manager never saw the live prefix: it installed into a side prefix.
		expect(requests).toHaveLength(1)
		expect(stageOf(requests[0] as InstallerRequest)).not.toBe(prefix)
		expect(stageOf(requests[0] as InstallerRequest).startsWith(prefix)).toBe(true)
		expect(readInstalledVersion(root)).toBe('2.0.0')
		expect(chunks()).toEqual(['new-CCCCCCCC.js', 'old-AAAAAAAA.js', 'shared-BBBBBBBB.js'])
		// The one chunk both trees have is the new tree's; the carried one is recorded.
		expect(readFileSync(join(root, 'dist', 'chunks', 'shared-BBBBBBBB.js'), 'utf8')).toBe(
			'shared-BBBBBBBB.js@2.0.0',
		)
		expect(JSON.parse(readFileSync(join(root, CARRIED_FILE), 'utf8'))).toEqual({
			files: ['old-AAAAAAAA.js'],
		})
		expect(leftovers()).toEqual([])
		expect(readInProgress(sharedStateHome(install), scopeOf(install, 'linux'))).toBeFalsy()
	})

	it('carries what an earlier swap carried, so a window left open across two updates keeps its files', async () => {
		await applyUpdate(deps(), release)
		const second = deps({
			currentVersion: '1.0.0',
			runInstaller: async (request) => {
				writePackage(stagedPackage(stageOf(request)), '3.0.0', ['newer-DDDDDDDD.js'])
				return 0
			},
		})
		const result = await applyUpdate(second, { version: '3.0.0', integrity: 'sha512-AAAA' })
		expect(result).toMatchObject({ status: 'installed', to: '3.0.0' })
		expect(chunks()).toEqual([
			'new-CCCCCCCC.js',
			'newer-DDDDDDDD.js',
			'old-AAAAAAAA.js',
			'shared-BBBBBBBB.js',
		])
	})

	it('changes nothing when the new folder does not answer, and says the previous version is in place', async () => {
		const result = await applyUpdate(deps({ smokeTest: async () => false }), release)
		expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(chunks()).toEqual(['old-AAAAAAAA.js', 'shared-BBBBBBBB.js'])
		expect(leftovers()).toEqual([])
	})

	it('puts the old folder back when the check after the swap fails', async () => {
		let asked = 0
		const smoke = vi.fn(async (_at: string, _version: string, depth?: string) => {
			asked++
			// First the staged copy (session depth) passes; the one in place (version depth) does not.
			return depth === 'session'
		})
		const result = await applyUpdate(deps({ smokeTest: smoke }), release)
		expect(asked).toBe(2)
		expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(chunks()).toEqual(['old-AAAAAAAA.js', 'shared-BBBBBBBB.js'])
		expect(existsSync(join(root, CARRIED_FILE))).toBe(false)
		expect(leftovers()).toEqual([])
	})

	it('reports an installer that failed without touching the live folder', async () => {
		const result = await applyUpdate(
			deps({
				runInstaller: async (request) => {
					request.onOutput('npm error code ENOSPC')
					return 1
				},
			}),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', code: 'disk_full', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
		expect(leftovers()).toEqual([])
	})

	it('refuses an installer that produced a different version than asked', async () => {
		const result = await applyUpdate(
			deps({
				runInstaller: async (request) => {
					writePackage(stagedPackage(stageOf(request)), '9.9.9', ['x-EEEEEEEE.js'])
					return 0
				},
			}),
			release,
		)
		expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
		expect(readInstalledVersion(root)).toBe('1.0.0')
	})

	it('without swap, still waits for the other windows (the older way is unchanged)', async () => {
		const run = vi.fn(async () => 0)
		const result = await applyUpdate(deps({ swap: false, runInstaller: run }), release)
		expect(result).toEqual({ status: 'locked' })
		expect(run).not.toHaveBeenCalled()
	})
})
