/**
 * The update path against a real package manager and a registry that is a
 * local HTTP server: nothing here reaches the public registry or installs
 * anything outside a temporary folder. The package manager is a real
 * subprocess, so these tests wait on it directly (and carry a longer test
 * timeout for that) instead of racing a clock.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { runNpmUpgrade } from '../npm-global.js'
import { fetchNamzuRelease } from '../updates.js'
import {
	type ApplyDeps,
	applyUpdate,
	npmInstallArgs,
	scopeOf,
	smokeTestInstalled,
} from './apply.js'
import { classifyInstall } from './install-kind.js'
import { readInstalledVersion } from './installed-version.js'
import { previousDir, readLastResult } from './state.js'
import { type UpdaterEvent, createUpdater } from './updater.js'

const TIMEOUT = 120_000

interface Fixture {
	readonly version: string
	readonly tarball: Buffer
	readonly integrity: string
}

let work: string
let server: Server
let registry: string
const fixtures = new Map<string, Fixture>()
/** Version -> the digest the registry claims for it, when it should lie. */
const lies = new Map<string, string>()
const tags: Record<string, string> = { latest: '2.0.0', stable: '1.5.0' }

function npmEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: join(work, 'home'),
		USERPROFILE: join(work, 'home'),
		npm_config_cache: join(work, 'npm-cache'),
		npm_config_userconfig: join(work, 'npmrc'),
		npm_config_globalconfig: join(work, 'global-npmrc'),
		npm_config_update_notifier: 'false',
		npm_config_fund: 'false',
		npm_config_audit: 'false',
		// A wrong checksum is retried with a long back-off by default; the test wants the first answer.
		npm_config_fetch_retries: '0',
	}
}

function buildFixture(version: string): Fixture {
	const src = join(work, 'src', version)
	mkdirSync(join(src, 'dist'), { recursive: true })
	writeFileSync(
		join(src, 'package.json'),
		JSON.stringify({
			name: '@namzu/cli',
			version,
			bin: { namzu: 'dist/bin.js' },
			files: ['dist'],
		}),
	)
	writeFileSync(
		join(src, 'dist', 'bin.js'),
		`#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? '${version}' : 'run')\n`,
	)
	const out = join(work, 'packed')
	mkdirSync(out, { recursive: true })
	const name = execFileSync(
		'npm',
		['pack', '--pack-destination', out, '--silent', '--ignore-scripts'],
		{ cwd: src, env: npmEnv(), encoding: 'utf8' },
	).trim()
	const tarball = readFileSync(join(out, name))
	return {
		version,
		tarball,
		integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
	}
}

function manifest(version: string) {
	const fixture = fixtures.get(version)
	if (!fixture) return undefined
	return {
		name: '@namzu/cli',
		version,
		bin: { namzu: 'dist/bin.js' },
		dist: {
			tarball: `${registry}/tarballs/${version}.tgz`,
			integrity: lies.get(version) ?? fixture.integrity,
			shasum: createHash('sha1').update(fixture.tarball).digest('hex'),
		},
	}
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'namzu-stub-registry-'))
	mkdirSync(join(work, 'home'), { recursive: true })
	writeFileSync(join(work, 'npmrc'), '')
	writeFileSync(join(work, 'global-npmrc'), '')
	for (const version of ['1.0.0', '1.5.0', '2.0.0']) fixtures.set(version, buildFixture(version))
	server = createServer((req, res) => {
		const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
		const send = (status: number, body: string | Buffer, type = 'application/json') => {
			res.writeHead(status, { 'content-type': type })
			res.end(body)
		}
		const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(path)
		if (tarball?.[1]) {
			const fixture = fixtures.get(tarball[1])
			return fixture ? send(200, fixture.tarball, 'application/octet-stream') : send(404, '{}')
		}
		const one = /^\/@namzu\/cli\/(.+)$/.exec(path)
		if (one?.[1]) {
			const version = tags[one[1]] ?? one[1]
			const body = manifest(version)
			return body ? send(200, JSON.stringify(body)) : send(404, '{"error":"not found"}')
		}
		if (path === '/@namzu/cli') {
			const versions: Record<string, unknown> = {}
			for (const version of fixtures.keys()) versions[version] = manifest(version)
			return send(200, JSON.stringify({ name: '@namzu/cli', 'dist-tags': tags, versions }))
		}
		return send(404, '{}')
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, TIMEOUT)

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()))
	rmSync(work, { recursive: true, force: true })
})

let prefix: string
let home: string
let root: string

async function installVersion(version: string): Promise<void> {
	const code = await runNpmUpgrade({
		executable: 'npm',
		args: npmInstallArgs(prefix, version, registry),
		prefix,
		onOutput: () => undefined,
		background: true,
	})
	expect(code).toBe(0)
}

function applyDeps(over: Partial<ApplyDeps> = {}): ApplyDeps {
	const install = classifyInstall({ packageRoot: root, platform: process.platform })
	if (install.kind !== 'npm-global') throw new Error(`unexpected layout ${install.kind}`)
	return {
		home,
		install,
		currentVersion: '1.0.0',
		platform: process.platform,
		registry,
		installedVersion: readInstalledVersion,
		smokeTest: smokeTestInstalled,
		runInstaller: (request) =>
			runNpmUpgrade({
				executable: request.executable,
				args: request.args,
				prefix: request.cwd,
				onOutput: request.onOutput,
				background: true,
			}),
		...over,
	}
}

beforeEach(async () => {
	vi.stubEnv('HOME', join(work, 'home'))
	for (const [key, value] of Object.entries(npmEnv())) {
		if (key.startsWith('npm_config_') && value !== undefined) vi.stubEnv(key, value)
	}
	lies.clear()
	const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
	prefix = join(work, 'prefixes', stamp)
	home = join(work, 'homes', stamp)
	root = join(prefix, 'lib', 'node_modules', '@namzu', 'cli')
	mkdirSync(prefix, { recursive: true })
	await installVersion('1.0.0')
}, TIMEOUT)

describe('the registry answer', () => {
	it('names the version a channel points at and its checksum', async () => {
		const latest = await fetchNamzuRelease({ registry })
		expect(latest).toEqual({ version: '2.0.0', integrity: fixtures.get('2.0.0')?.integrity })
		const stable = await fetchNamzuRelease({ registry, channel: 'stable' })
		expect(stable.version).toBe('1.5.0')
	})
})

describe('updating through a real package manager', () => {
	it(
		'installs the new version, keeps the old one, and the new copy starts',
		async () => {
			const release = await fetchNamzuRelease({ registry })
			const result = await applyUpdate(applyDeps(), release)
			expect(result).toEqual({ status: 'installed', from: '1.0.0', to: '2.0.0' })
			expect(readInstalledVersion(root)).toBe('2.0.0')
			expect(
				readFileSync(
					join(previousDir(home, '1.0.0', scopeOf(applyDeps().install)), 'package.json'),
					'utf8',
				),
			).toContain('"1.0.0"')
		},
		TIMEOUT,
	)

	it(
		'follows the stable channel to its own version',
		async () => {
			const release = await fetchNamzuRelease({ registry, channel: 'stable' })
			expect(await applyUpdate(applyDeps(), release)).toEqual({
				status: 'installed',
				from: '1.0.0',
				to: '1.5.0',
			})
		},
		TIMEOUT,
	)

	it(
		'keeps the working old version when the registry’s checksum does not match the download',
		async () => {
			lies.set('2.0.0', `sha512-${createHash('sha512').update('something else').digest('base64')}`)
			const release = await fetchNamzuRelease({ registry })
			const result = await applyUpdate(applyDeps(), release)
			expect(result).toMatchObject({ status: 'failed', code: 'integrity', restored: true })
			expect(readInstalledVersion(root)).toBe('1.0.0')
			expect(
				execFileSync(process.execPath, [join(root, 'dist', 'bin.js'), '--version'], {
					encoding: 'utf8',
				}).trim(),
			).toBe('1.0.0')
		},
		TIMEOUT,
	)

	it(
		'catches a registry that answers with another version’s files and puts the old one back',
		async () => {
			// Warm the package manager's cache with 1.5.0 so the lying digest finds real, wrong content.
			const scratch = join(work, 'warm', `${Date.now()}`)
			mkdirSync(scratch, { recursive: true })
			await runNpmUpgrade({
				executable: 'npm',
				args: npmInstallArgs(scratch, '1.5.0', registry),
				prefix: scratch,
				onOutput: () => undefined,
				background: true,
			})
			lies.set('2.0.0', fixtures.get('1.5.0')?.integrity ?? '')
			const release = await fetchNamzuRelease({ registry })
			const result = await applyUpdate(applyDeps(), release)
			expect(result).toMatchObject({ status: 'failed', code: 'verify_failed', restored: true })
			expect(readInstalledVersion(root)).toBe('1.0.0')
		},
		TIMEOUT,
	)

	it(
		'does not touch a folder it cannot write to',
		async () => {
			if (process.platform === 'win32' || process.getuid?.() === 0) return
			const scope = join(prefix, 'lib', 'node_modules', '@namzu')
			chmodSync(scope, 0o555)
			try {
				const install = classifyInstall({ packageRoot: root, platform: process.platform })
				expect(install).toMatchObject({ kind: 'npm-global', writable: false })
				const run = vi.fn(async () => 0)
				const result = await applyUpdate(
					applyDeps({ install: install as ApplyDeps['install'], runInstaller: run }),
					{
						version: '2.0.0',
						integrity: fixtures.get('2.0.0')?.integrity,
					},
				)
				expect(result).toMatchObject({ status: 'failed', code: 'no_permission' })
				expect(run).not.toHaveBeenCalled()
			} finally {
				chmodSync(scope, 0o755)
			}
		},
		TIMEOUT,
	)

	it(
		'runs the whole loop once against the stub: look, install, report',
		async () => {
			const events: UpdaterEvent[] = []
			const deps = applyDeps()
			const updater = createUpdater({
				currentVersion: '1.0.0',
				install: deps.install,
				policy: { check: true, install: true, channel: 'latest', decidedBy: 'default' },
				home,
				platform: process.platform,
				fetchRelease: (channel) => fetchNamzuRelease({ registry, channel }),
				applyDeps: deps,
				onEvent: (event) => events.push(event),
			})
			await updater.runCycle()
			expect(events).toEqual([{ type: 'installed', from: '1.0.0', to: '2.0.0' }])
			expect(readLastResult(home)).toMatchObject({ outcome: 'installed', to: '2.0.0' })
		},
		TIMEOUT,
	)

	it(
		'lets two processes race: one installs, the other waits and then finds it done',
		async () => {
			const release = await fetchNamzuRelease({ registry })
			const [a, b] = await Promise.all([
				applyUpdate(applyDeps({ pid: process.pid + 100_000 }), release),
				applyUpdate(applyDeps({ pid: process.pid + 100_001, isAlive: () => true }), release),
			])
			const statuses = [a.status, b.status].sort()
			expect(statuses).toContain('installed')
			expect(statuses.filter((s) => s === 'installed')).toHaveLength(1)
			expect(['locked', 'already']).toContain(statuses.find((s) => s !== 'installed'))
			expect(readInstalledVersion(root)).toBe('2.0.0')
		},
		TIMEOUT,
	)
})
