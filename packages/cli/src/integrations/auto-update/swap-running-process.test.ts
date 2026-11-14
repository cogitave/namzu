/**
 * Can the install folder of a running process be replaced while it keeps working? This test was the
 * spike that decided the design of `swap.ts`, and now holds it to it.
 *
 * The CLI is a tree of hash-named chunk files that a process reads from its install folder the
 * first time it needs them. The candidate: build the new tree in a side folder on the same
 * filesystem, copy over every chunk of the live tree that the new tree lacks, then swap by renaming
 * the live folder aside and the new folder into its place.
 *
 * A real Node child is started from the fixture tree and driven by messages (it imports one chunk
 * per message and answers), so every assertion follows an event, never a clock. The npm part uses a
 * scratch prefix and tarballs packed here; nothing touches the registry or a real prefix.
 */

import { execFileSync, fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { carryChunks, swapFolders } from './swap.js'

const posixOnly = process.platform === 'win32' ? describe.skip : describe

let work: string
const children: ChildProcess[] = []

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), 'namzu-swap-spike-'))
})
afterAll(() => {
	for (const child of children) child.kill('SIGKILL')
	rmSync(work, { recursive: true, force: true })
})

const BIN = `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (process.argv[2] === '--version') {
	console.log(version)
} else if (process.argv[2] === '--broken') {
	process.exit(3)
} else if (process.send) {
	process.on('message', async (message) => {
		try {
			const mod = await import(new URL('./chunks/' + message.chunk, import.meta.url).href)
			process.send({ ok: true, value: mod.default })
		} catch (error) {
			process.send({ ok: false, code: error.code })
		}
	})
	process.send({ ready: version })
}
`

function writeTree(root: string, version: string, chunks: Record<string, string>): void {
	mkdirSync(join(root, 'dist', 'chunks'), { recursive: true })
	mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({
			name: '@namzu/cli',
			version,
			type: 'module',
			bin: { namzu: './dist/bin.js' },
			files: ['dist', 'node_modules'],
			bundledDependencies: ['dep'],
			dependencies: { dep: '1.0.0' },
		}),
	)
	writeFileSync(join(root, 'dist', 'bin.js'), BIN)
	writeFileSync(
		join(root, 'node_modules', 'dep', 'package.json'),
		JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.js' }),
	)
	writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), `export default 'dep@${version}'\n`)
	for (const [name, value] of Object.entries(chunks)) {
		writeFileSync(join(root, 'dist', 'chunks', name), `export default ${JSON.stringify(value)}\n`)
	}
}

class Driven {
	readonly child: ChildProcess
	private constructor(child: ChildProcess) {
		this.child = child
	}
	static async start(root: string): Promise<Driven> {
		const child = fork(join(root, 'dist', 'bin.js'), [], {
			stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
		})
		children.push(child)
		const driven = new Driven(child)
		await driven.next()
		return driven
	}
	private next(): Promise<{ ok?: boolean; value?: string; code?: string }> {
		return new Promise((resolve, reject) => {
			this.child.once('message', resolve)
			this.child.once('exit', () => reject(new Error('child exited')))
		})
	}
	/** Ask the child to import one chunk; resolves with what it answered. */
	async load(chunk: string): Promise<{ ok?: boolean; value?: string; code?: string }> {
		const answer = this.next()
		this.child.send({ chunk })
		return answer
	}
	stop(): void {
		this.child.kill('SIGKILL')
	}
}

function versionOf(root: string): string {
	return execFileSync(process.execPath, [join(root, 'dist', 'bin.js'), '--version'], {
		encoding: 'utf8',
	}).trim()
}

/** The swap the updater uses: carry the live chunks the new tree lacks, then trade the folders. */
async function swap(
	live: string,
	next: string,
	aside: string,
	check: (root: string) => boolean,
): Promise<'swapped' | 'rolled-back'> {
	await carryChunks(live, next)
	return swapFolders({ live, next, aside, check: async (root) => check(root) })
}

posixOnly('swapping the install folder under a running process', () => {
	it('keeps the process importing old and new chunks, over 20 trials, and a fresh start runs the new version', async () => {
		for (let trial = 0; trial < 20; trial++) {
			const dir = join(work, `plain-${trial}`)
			const live = join(dir, 'cli')
			const next = join(dir, 'cli.next')
			const aside = join(dir, 'cli.replaced')
			writeTree(live, '1.0.0', { 'seen-AAAA.js': 'seen', [`late-${trial}-BBBB.js`]: 'late-old' })
			writeTree(next, '1.1.0', { 'seen-CCCC.js': 'seen2', [`fresh-${trial}-DDDD.js`]: 'fresh-new' })
			const session = await Driven.start(live)
			expect(await session.load('seen-AAAA.js')).toEqual({ ok: true, value: 'seen' })

			expect(await swap(live, next, aside, (root) => versionOf(root) === '1.1.0')).toBe('swapped')

			// Imported before: cached, still answered. Never imported before: read from the carried file.
			expect(await session.load('seen-AAAA.js')).toEqual({ ok: true, value: 'seen' })
			expect(await session.load(`late-${trial}-BBBB.js`)).toEqual({ ok: true, value: 'late-old' })
			// A chunk only the new tree has.
			expect(await session.load(`fresh-${trial}-DDDD.js`)).toEqual({ ok: true, value: 'fresh-new' })
			expect(versionOf(live)).toBe('1.1.0')
			session.stop()
		}
	})

	it('without carrying, the same swap takes a not-yet-imported chunk away (the failure this guards)', async () => {
		const dir = join(work, 'uncarried')
		const live = join(dir, 'cli')
		const next = join(dir, 'cli.next')
		writeTree(live, '1.0.0', { 'late-EEEE.js': 'late-old' })
		writeTree(next, '1.1.0', {})
		const session = await Driven.start(live)
		renameSync(live, join(dir, 'cli.replaced'))
		renameSync(next, live)
		expect(await session.load('late-EEEE.js')).toEqual({ ok: false, code: 'ERR_MODULE_NOT_FOUND' })
		session.stop()
	})

	it('puts the old folder back when the check on the new one fails, and the process never notices', async () => {
		const dir = join(work, 'rollback')
		const live = join(dir, 'cli')
		const next = join(dir, 'cli.next')
		const aside = join(dir, 'cli.replaced')
		writeTree(live, '1.0.0', { 'late-FFFF.js': 'late-old' })
		writeTree(next, '1.1.0', {})
		const session = await Driven.start(live)
		expect(await swap(live, next, aside, () => false)).toBe('rolled-back')
		expect(versionOf(live)).toBe('1.0.0')
		expect(await session.load('late-FFFF.js')).toEqual({ ok: true, value: 'late-old' })
		session.stop()
	})
})

/** Pack a fixture version with the real npm into a tarball, offline, in a scratch cache. */
function pack(version: string, chunks: Record<string, string>): string {
	const src = join(work, `pkg-${version}`)
	writeTree(src, version, chunks)
	const out = join(work, `tar-${version}`)
	mkdirSync(out, { recursive: true })
	execFileSync(
		'npm',
		[
			'pack',
			'--offline',
			'--silent',
			'--pack-destination',
			out,
			'--cache',
			join(work, 'npm-cache'),
		],
		{
			cwd: src,
			env: npmEnv(),
		},
	)
	return join(out, readdirSync(out)[0] as string)
}

function npmEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: work,
		npm_config_userconfig: join(work, 'npmrc'),
		npm_config_update_notifier: 'false',
	}
}

function npmGlobalInstall(prefix: string, tarball: string): void {
	execFileSync(
		'npm',
		[
			'install',
			'--global',
			'--prefix',
			prefix,
			'--offline',
			'--no-fund',
			'--no-audit',
			'--cache',
			join(work, 'npm-cache'),
			tarball,
		],
		{ env: npmEnv(), stdio: 'ignore' },
	)
}

posixOnly('the two layouts the updater installs into, with the real npm', () => {
	it.each([
		['a global npm prefix', 'global'],
		["the installer's own prefix", '.namzu'],
	])(
		'%s: install aside, carry, swap, and the running process keeps going',
		async (_name, folder) => {
			const prefix = join(work, 'npm', folder)
			const old = pack('1.0.0', { 'seen-AAAA.js': 'seen', 'late-BBBB.js': 'late-old' })
			const fresh = pack('1.1.0', { 'seen-CCCC.js': 'seen2', 'new-DDDD.js': 'new' })
			mkdirSync(prefix, { recursive: true })
			npmGlobalInstall(prefix, old)
			const live = join(prefix, 'lib', 'node_modules', '@namzu', 'cli')
			expect(versionOf(live)).toBe('1.0.0')
			const session = await Driven.start(live)
			expect(await session.load('seen-AAAA.js')).toEqual({ ok: true, value: 'seen' })

			// The new version goes into a side prefix inside the live one (same filesystem), then its package folder is moved next to the live one.
			const side = join(prefix, '.stage-1')
			npmGlobalInstall(side, fresh)
			const next = join(prefix, 'lib', 'node_modules', '@namzu', '.cli-next')
			renameSync(join(side, 'lib', 'node_modules', '@namzu', 'cli'), next)
			rmSync(side, { recursive: true, force: true })

			expect(
				await swap(live, next, `${live}.replaced`, (root) => versionOf(root) === '1.1.0'),
			).toBe('swapped')

			expect(await session.load('late-BBBB.js')).toEqual({ ok: true, value: 'late-old' })
			expect(await session.load('new-DDDD.js')).toEqual({ ok: true, value: 'new' })
			// The launcher npm wrote still points at the same path and now runs the new version.
			expect(
				execFileSync(join(prefix, 'bin', 'namzu'), ['--version'], { encoding: 'utf8' }).trim(),
			).toBe('1.1.0')
			// npm's own view of the prefix is the new version, not a stale record.
			const listed = JSON.parse(
				execFileSync('npm', ['ls', '--global', '--prefix', prefix, '--json', '--depth=0'], {
					env: npmEnv(),
					encoding: 'utf8',
				}),
			) as { dependencies?: Record<string, { version?: string }> }
			expect(listed.dependencies?.['@namzu/cli']?.version).toBe('1.1.0')
			expect(readFileSync(join(live, 'package.json'), 'utf8')).toContain('1.1.0')
			session.stop()
		},
		120_000,
	)
})
