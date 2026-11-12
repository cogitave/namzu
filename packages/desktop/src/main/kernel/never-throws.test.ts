import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCheck } from './check.js'
import { type KernelFs, nodeFs } from './fs.js'
import {
	FEED,
	type Harness,
	buildArchive,
	kernelFiles,
	makeFeed,
	makeHarness,
	manifestObject,
	signPair,
} from './kernel-test-support.js'
import { startWithFallback } from './manager.js'

/**
 * A start of a host, a terminal tab or a short command never fails because of the engine folder.
 * Whatever goes wrong while the engine is chosen (a file operation that fails with any code, a state
 * file of any shape, a folder that is gone, an exception in a check) ends in the engine inside the
 * installer, and says one line in the log. Nothing here reads the clock or waits for anything.
 */

const open: Harness[] = []
afterEach(async () => {
	await Promise.all(open.splice(0).map((h) => h.dispose()))
})

const CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EIO', 'ENOSPC'] as const
const OPERATIONS = [
	'readFile',
	'writeFile',
	'appendFile',
	'openWrite',
	'rename',
	'rm',
	'mkdir',
	'readdir',
	'stat',
	'openRead',
] as const satisfies readonly (keyof KernelFs)[]
type Operation = (typeof OPERATIONS)[number]
/** The operations that only look: when they fail, an engine cannot be shown to be what it says. */
const READS: readonly Operation[] = ['readFile', 'readdir', 'stat', 'openRead']

function failure(code: string): Error {
	return Object.assign(new Error(`${code}: injected failure`), { code })
}

/** A file system on which one operation fails, every time, with one error code, once armed. */
function throwingFs(real: KernelFs, plan: { operation: Operation; code: string }) {
	const state = { armed: false, hits: 0 }
	const trip = (operation: Operation): void => {
		if (!state.armed || operation !== plan.operation) return
		state.hits++
		throw failure(plan.code)
	}
	const fs: KernelFs = {
		readFile: async (path) => {
			trip('readFile')
			return real.readFile(path)
		},
		writeFile: async (path, data) => {
			trip('writeFile')
			await real.writeFile(path, data)
		},
		appendFile: async (path, data) => {
			trip('appendFile')
			await real.appendFile(path, data)
		},
		openWrite: async (path) => {
			trip('openWrite')
			return real.openWrite(path)
		},
		rename: async (from, to) => {
			trip('rename')
			await real.rename(from, to)
		},
		rm: async (path) => {
			trip('rm')
			await real.rm(path)
		},
		mkdir: async (path, options) => {
			trip('mkdir')
			await real.mkdir(path, options)
		},
		readdir: async (path) => {
			trip('readdir')
			return real.readdir(path)
		},
		stat: async (path) => {
			trip('stat')
			return real.stat(path)
		},
		openRead: (path) => {
			trip('openRead')
			return real.openRead(path)
		},
	}
	return { fs, state }
}

const MANAGED = '51.3.0'

/** An engine fetched, verified and promoted to `current`, as a normal run leaves it. */
async function withManagedEngine(): Promise<Harness> {
	const h = await makeHarness()
	open.push(h)
	const files = kernelFiles(MANAGED, '62.14.0')
	const built = buildArchive(MANAGED, files)
	const pair = signPair(
		manifestObject({
			commandLine: MANAGED,
			engine: '62.14.0',
			bundles: { 'win32-x64': built.bundle },
		}),
		h.key,
	)
	const feed = makeFeed({
		'kernel-latest.json': pair.manifest,
		'kernel-latest.json.sig': pair.signature,
		[built.file]: built.gz,
	})
	const result = await runCheck({
		manager: h.manager,
		feedBase: FEED,
		channel: 'latest',
		fetch: feed.fetch,
		now: h.clock.now,
		selfCheck: async () => undefined,
	})
	expect(result).toMatchObject({ kind: 'ready' })
	expect(await h.manager.resolve()).toMatchObject({ source: 'managed', version: MANAGED })
	return h
}

/** What a host start does with the engine code: resolve, spawn (stubbed), count the start. */
async function startHost(h: Harness, manager = h.manager) {
	const { kernel, release } = await startWithFallback(manager, async () => undefined)
	const token = await manager.hostStarted(kernel)
	release()
	await manager.hostExited(token, { unexpected: false })
	return kernel
}

describe('a file operation that fails, with any error code, never fails a start', () => {
	for (const operation of OPERATIONS) {
		for (const code of CODES) {
			it(`${operation} failing with ${code}: a healthy engine start, and a damaged engine start`, async () => {
				// 1. A healthy managed engine, and the start path of a new run with the operation failing.
				const healthy = await withManagedEngine()
				const faulty = throwingFs(nodeFs, { operation, code })
				faulty.state.armed = true
				const next = await healthy.restart(faulty.fs)
				const kernel = await startHost(healthy, next.manager)
				const leased = await next.manager.resolve({ hold: true })
				leased.release?.()
				if (READS.includes(operation)) {
					// It cannot be shown to be what it says, so this start goes on without it.
					expect(kernel.source, 'a start that cannot read the engine uses the bundled one').toBe(
						'bundled',
					)
					expect(leased.source).toBe('bundled')
					expect(faulty.state.hits).toBeGreaterThan(0)
				} else {
					// Nothing to write for a healthy engine: it stays in use, and the start did not fail.
					expect(['managed', 'bundled']).toContain(kernel.source)
				}
				faulty.state.armed = false

				// 2. A damaged managed engine: giving it up needs writes, and the start still ends bundled.
				const damaged = await withManagedEngine()
				await writeFile(
					join(damaged.kernelRoot, 'versions', MANAGED, 'dist', 'bin.js'),
					'// changed\n',
				)
				const failing = throwingFs(nodeFs, { operation, code })
				failing.state.armed = true
				const restarted = await damaged.restart(failing.fs)
				const entry = await startHost(damaged, restarted.manager)
				expect(entry.source, 'a damaged engine is never started').toBe('bundled')
				expect(entry.entry).toBe(join(damaged.root, 'bundled', 'dist', 'bin.js'))
				expect(damaged.logs.length, 'it says so in the log').toBeGreaterThan(0)
			})
		}
	}
})

describe('an exception while choosing never fails a start, and says one line', () => {
	const throwing = (what: string) => () => {
		throw new Error(`${what} exploded at /home/someone/secret/place`)
	}
	it('the bundled facts reader throws', async () => {
		const h = await makeHarness()
		open.push(h)
		const { KernelManager } = await import('./manager.js')
		const manager = new KernelManager({
			...h.manager.options,
			bundledFacts: async () => {
				throw new Error('facts exploded')
			},
		})
		const before = h.logs.length
		const kernel = await startHost(h, manager)
		expect(kernel).toMatchObject({ source: 'bundled' })
		const lines = h.logs.slice(before).filter((line) => line.event === 'resolve-failed')
		expect(lines).toHaveLength(1)
	})
	it('the setting, the override and the bundled facts values are odd', async () => {
		const h = await makeHarness()
		open.push(h)
		const { KernelManager } = await import('./manager.js')
		for (const options of [
			{ enabled: throwing('enabled') },
			{ override: throwing('override') },
			{ bundledFacts: async () => ({ commandLine: 'not a version', engine: 'x', dataEpoch: 1 }) },
			{ bundledFacts: async () => ({ commandLine: 51, engine: 62, dataEpoch: '1' }) as never },
		]) {
			const manager = new KernelManager({ ...h.manager.options, ...options })
			expect((await startHost(h, manager)).source).toBe('bundled')
		}
		const lines = h.logs.filter((line) => line.event === 'resolve-failed')
		// The line names no path of the person's computer.
		for (const line of lines) expect(JSON.stringify(line)).not.toContain('/home/someone')
	})
	it('a managed engine whose check throws is not started, and the log says so once per start', async () => {
		const h = await withManagedEngine()
		const manager = new (await import('./manager.js')).KernelManager({
			...h.manager.options,
			// the facts the quick check compares against are not even a version
			bundledFacts: async () => ({ commandLine: undefined as never, engine: 'x', dataEpoch: 1 }),
		})
		expect((await startHost(h, manager)).source).toBe('bundled')
		expect(
			h.logs.some((line) => line.event === 'quick-check-unreadable' || line.event === 'marked-bad'),
		).toBe(true)
	})
})

describe('a state file of any shape, or a folder that is gone, starts the bundled engine', () => {
	const SHAPES: [string, string | Buffer][] = [
		['empty', ''],
		['not JSON', '{"schema":1,'],
		['null', 'null'],
		['a number', '42'],
		['a string', '"51.3.0"'],
		['an array', '[1,2,3]'],
		['an empty object', '{}'],
		['another schema', '{"schema":2,"current":"51.3.0"}'],
		['current is an object', '{"schema":1,"current":{"a":1}}'],
		['current is a path', '{"schema":1,"current":"../../../etc"}'],
		[
			'current is a version that is not on disk',
			'{"schema":1,"current":"99.9.9","previous":"98.0.0"}',
		],
		['bad is an array', '{"schema":1,"bad":[1,2],"current":"51.3.0"}'],
		['bad has null entries', '{"schema":1,"bad":{"51.3.0":null},"current":"51.3.0"}'],
		['starts is a list', '{"schema":1,"current":"51.3.0","starts":[1],"earlyExits":"x"}'],
		[
			'numbers out of range',
			'{"schema":1,"current":"51.3.0","lastSequence":-1,"highestIssuedAt":1e999,"updatedAt":"x"}',
		],
		['a huge string', `{"schema":1,"current":"51.3.0","minimumKernel":"${'9'.repeat(100_000)}"}`],
		['binary', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80])],
		['a byte order mark', `﻿{"schema":1}`],
	]
	for (const [label, content] of SHAPES) {
		it(`state.json that is ${label}`, async () => {
			const h = await withManagedEngine()
			await writeFile(join(h.kernelRoot, 'state.json'), content)
			const restarted = await h.restart()
			const kernel = await startHost(h, restarted.manager)
			// An engine the state does not name, or that fails its check, is never started; what the state
			// names and the disk proves may be. Never a failed start either way.
			expect(['bundled', 'managed']).toContain(kernel.source)
			if (kernel.source === 'managed') expect(kernel.version).toBe(MANAGED)
		})
	}
	it('state.json that is a folder, a missing folder and a missing versions folder', async () => {
		const h = await withManagedEngine()
		await rm(join(h.kernelRoot, 'state.json'), { force: true })
		await mkdir(join(h.kernelRoot, 'state.json'))
		expect((await startHost(h, (await h.restart()).manager)).source).toBe('bundled')

		const g = await withManagedEngine()
		await rm(join(g.kernelRoot, 'versions'), { recursive: true, force: true })
		expect((await startHost(g, (await g.restart()).manager)).source).toBe('bundled')

		const f = await withManagedEngine()
		await rm(f.kernelRoot, { recursive: true, force: true })
		expect((await startHost(f, (await f.restart()).manager)).source).toBe('bundled')
		// and the folders are made again for the next run
		expect(await readdir(join(f.kernelRoot, 'versions'))).toEqual([])
	})
})
