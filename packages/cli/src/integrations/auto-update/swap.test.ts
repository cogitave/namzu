import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { InstallKind } from './install-kind.js'
import { registerRunning } from './running.js'
import { CARRIED_FILE, canSwapInstall, carryChunks, pruneAfterSwap, swapFolders } from './swap.js'

let dir: string
let prefix: string
let root: string

function tree(at: string, version: string, chunks: Record<string, string>): void {
	mkdirSync(join(at, 'dist', 'chunks'), { recursive: true })
	writeFileSync(join(at, 'package.json'), JSON.stringify({ name: '@namzu/cli', version }))
	for (const [name, text] of Object.entries(chunks)) {
		writeFileSync(join(at, 'dist', 'chunks', name), text)
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-swap-'))
	prefix = join(dir, 'prefix')
	root = join(prefix, 'lib', 'node_modules', '@namzu', 'cli')
	tree(root, '2.0.0', { 'a-AAAAAAAA.js': 'a', 'b-BBBBBBBB.js': 'b' })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const npm = (over: Partial<Extract<InstallKind, { kind: 'npm-global' }>> = {}): InstallKind => ({
	kind: 'npm-global',
	root,
	prefix,
	owned: false,
	writable: true,
	...over,
})

describe('which installs can be swapped under a running window', () => {
	it('accepts a writable npm prefix whose chunks are content-hashed', () => {
		expect(canSwapInstall(npm(), 'linux')).toBe(true)
		expect(canSwapInstall(npm({ owned: true }), 'darwin')).toBe(true)
	})

	it('keeps the older way on Windows, where a running program holds its files', () => {
		expect(canSwapInstall(npm(), 'win32')).toBe(false)
	})

	it('keeps the older way for a prefix Namzu may not write', () => {
		expect(canSwapInstall(npm({ writable: false }), 'linux')).toBe(false)
	})

	it('keeps the older way for every other layout', () => {
		expect(canSwapInstall({ kind: 'unknown', root }, 'linux')).toBe(false)
		expect(
			canSwapInstall({ kind: 'pnpm-global', root, globalDir: prefix, writable: true }, 'linux'),
		).toBe(false)
	})

	it('keeps the older way when a chunk name carries no content hash, since it could collide', () => {
		writeFileSync(join(root, 'dist', 'chunks', 'plain.js'), 'x')
		expect(canSwapInstall(npm(), 'linux')).toBe(false)
	})

	it('keeps the older way when there are no chunks to carry', () => {
		rmSync(join(root, 'dist', 'chunks'), { recursive: true })
		expect(canSwapInstall(npm(), 'linux')).toBe(false)
	})
})

describe('carrying chunks into the new folder', () => {
	it('carries only what the new folder lacks and records it', async () => {
		const next = join(dir, 'next')
		tree(next, '3.0.0', { 'b-BBBBBBBB.js': 'b', 'c-CCCCCCCC.js': 'c' })
		expect(await carryChunks(root, next)).toEqual(['a-AAAAAAAA.js'])
		expect(readFileSync(join(next, 'dist', 'chunks', 'a-AAAAAAAA.js'), 'utf8')).toBe('a')
		expect(JSON.parse(readFileSync(join(next, CARRIED_FILE), 'utf8'))).toEqual({
			files: ['a-AAAAAAAA.js'],
			hosts: [],
		})
	})

	it('keeps the live parsing child script under its version, and the ones carried before', async () => {
		writeFileSync(join(root, 'dist', 'analysis-host.js'), 'host-2')
		writeFileSync(join(root, 'dist', 'analysis-host.1.0.0.js'), 'host-1')
		writeFileSync(
			join(root, CARRIED_FILE),
			JSON.stringify({ files: [], hosts: ['analysis-host.1.0.0.js'] }),
		)
		const next = join(dir, 'next')
		tree(next, '3.0.0', {})
		writeFileSync(join(next, 'dist', 'analysis-host.js'), 'host-3')
		await carryChunks(root, next)
		expect(readFileSync(join(next, 'dist', 'analysis-host.2.0.0.js'), 'utf8')).toBe('host-2')
		expect(readFileSync(join(next, 'dist', 'analysis-host.1.0.0.js'), 'utf8')).toBe('host-1')
		expect(readFileSync(join(next, 'dist', 'analysis-host.js'), 'utf8')).toBe('host-3')
	})
})

describe('trading the folders', () => {
	it('puts the new folder in place of the live one', async () => {
		const next = join(dir, 'next')
		const aside = join(dir, 'aside')
		tree(next, '3.0.0', {})
		const seen: string[] = []
		const outcome = await swapFolders({
			live: root,
			next,
			aside,
			check: async (live) => {
				seen.push(readFileSync(join(live, 'package.json'), 'utf8'))
				return true
			},
		})
		expect(outcome).toBe('swapped')
		expect(seen[0]).toContain('3.0.0')
		expect(existsSync(next)).toBe(false)
		expect(readFileSync(join(aside, 'package.json'), 'utf8')).toContain('2.0.0')
	})

	it('trades back when the check says no or throws', async () => {
		for (const check of [async () => false, async () => Promise.reject(new Error('boom'))]) {
			const next = join(dir, 'next')
			tree(next, '3.0.0', {})
			const outcome = await swapFolders({ live: root, next, aside: join(dir, 'aside'), check })
			expect(outcome).toBe('rolled-back')
			expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('2.0.0')
			expect(existsSync(join(dir, 'aside'))).toBe(false)
			rmSync(next, { recursive: true, force: true })
		}
	})

	it('puts the live folder back when the new one cannot be moved in', async () => {
		await expect(
			swapFolders({
				live: root,
				next: join(dir, 'missing'),
				aside: join(dir, 'aside'),
				check: async () => true,
			}),
		).rejects.toThrow()
		expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('2.0.0')
	})
})

describe('cleaning up after a swap', () => {
	const install = () => npm() as Extract<InstallKind, { kind: 'npm-global' }>

	function carried(): void {
		writeFileSync(join(root, 'dist', 'chunks', 'old-DDDDDDDD.js'), 'old')
		writeFileSync(join(root, CARRIED_FILE), JSON.stringify({ files: ['old-DDDDDDDD.js'] }))
	}

	it('keeps the carried chunks while a window of an older version runs', async () => {
		carried()
		const stop = registerRunning(install(), { pid: 777, version: '1.0.0' })
		await pruneAfterSwap(install(), { onDisk: '2.0.0', isAlive: () => true })
		expect(existsSync(join(root, 'dist', 'chunks', 'old-DDDDDDDD.js'))).toBe(true)
		stop()
	})

	it('removes them once every window runs the version on disk', async () => {
		carried()
		const stop = registerRunning(install(), { pid: 778, version: '2.0.0' })
		await pruneAfterSwap(install(), { onDisk: '2.0.0', isAlive: () => true })
		expect(existsSync(join(root, 'dist', 'chunks', 'old-DDDDDDDD.js'))).toBe(false)
		expect(existsSync(join(root, CARRIED_FILE))).toBe(false)
		expect(existsSync(join(root, 'dist', 'chunks', 'a-AAAAAAAA.js'))).toBe(true)
		stop()
	})

	it('removes a carried parsing child script with the chunks, never the live one', async () => {
		writeFileSync(join(root, 'dist', 'analysis-host.js'), 'live')
		writeFileSync(join(root, 'dist', 'analysis-host.1.0.0.js'), 'old')
		writeFileSync(
			join(root, CARRIED_FILE),
			JSON.stringify({ files: [], hosts: ['analysis-host.1.0.0.js'] }),
		)
		await pruneAfterSwap(install(), { onDisk: '2.0.0', isAlive: () => true })
		expect(existsSync(join(root, 'dist', 'analysis-host.1.0.0.js'))).toBe(false)
		expect(existsSync(join(root, 'dist', 'analysis-host.js'))).toBe(true)
	})

	it('removes the folders of a swap whose process is gone, and only those', async () => {
		mkdirSync(join(root, '..', '.cli-next-1111'))
		mkdirSync(join(root, '..', '.cli-aside-2222'))
		mkdirSync(join(prefix, '.namzu-stage-3333'))
		await pruneAfterSwap(install(), { onDisk: '2.0.0', isAlive: (pid) => pid === 2222 })
		expect(existsSync(join(root, '..', '.cli-next-1111'))).toBe(false)
		expect(existsSync(join(root, '..', '.cli-aside-2222'))).toBe(true)
		expect(existsSync(join(prefix, '.namzu-stage-3333'))).toBe(false)
	})
})
