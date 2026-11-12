import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCheck } from './check.js'
import { bundledFactsReader, checkHostAnswer, kernelFromInitialize } from './facts.js'
import { nodeFs } from './fs.js'
import {
	FEED,
	type FakeFeed,
	type Harness,
	buildArchive,
	kernelFiles,
	makeFeed,
	makeHarness,
	manifestObject,
	signPair,
} from './kernel-test-support.js'
import { startWithFallback } from './manager.js'
import { pairPaths } from './state.js'

const open: Harness[] = []
afterEach(async () => {
	await Promise.all(open.splice(0).map((h) => h.dispose()))
})
async function harness(options: Parameters<typeof makeHarness>[0] = {}) {
	const h = await makeHarness(options)
	open.push(h)
	return h
}

function publish(
	h: Harness,
	feed: FakeFeed,
	commandLine: string,
	sequence: number,
	engine = '62.14.0',
) {
	const built = buildArchive(commandLine, kernelFiles(commandLine, engine))
	const pair = signPair(
		manifestObject({ commandLine, engine, sequence, bundles: { 'win32-x64': built.bundle } }),
		h.key,
	)
	feed.files.set('kernel-latest.json', pair.manifest)
	feed.files.set('kernel-latest.json.sig', pair.signature)
	feed.files.set(built.file, built.gz)
}

/** Installs and promotes one version, as a run of the app over a few days would. */
async function activate(h: Harness, feed: FakeFeed, commandLine: string, sequence: number) {
	publish(h, feed, commandLine, sequence)
	await runCheck({
		manager: h.manager,
		feedBase: FEED,
		channel: 'latest',
		fetch: feed.fetch,
		now: h.clock.now,
		selfCheck: async () => undefined,
	})
	return h.manager.resolve()
}

const bundledEntry = (h: Harness) => join(h.root, 'bundled', 'dist', 'bin.js')
const entryOf = (h: Harness, version: string) =>
	join(h.kernelRoot, 'versions', version, 'dist', 'bin.js')
const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

describe('choosing the engine', () => {
	it('uses the bundled one when nothing is managed', async () => {
		const h = await harness()
		expect(await h.manager.resolve()).toEqual({ entry: bundledEntry(h), source: 'bundled' })
	})

	it('names the developer override and nothing else when one is set', async () => {
		const h = await harness({ override: '/dev/cli/dist/bin.js' })
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		expect(await h.manager.resolve()).toEqual({ entry: '/dev/cli/dist/bin.js', source: 'override' })
	})

	it('uses the bundled one with the setting off, even when a managed one is stored, and does not promote', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		await runCheck({
			manager: h.manager,
			feedBase: FEED,
			channel: 'latest',
			fetch: feed.fetch,
			now: h.clock.now,
			selfCheck: async () => undefined,
		})
		h.flags.enabled = false
		expect((await h.manager.resolve()).source).toBe('bundled')
		expect(h.store.snapshot().pending).toBe('51.3.0')
	})

	it('uses the bundled one when no key is compiled in', async () => {
		const h = await harness({ keys: [] })
		expect((await h.manager.resolve()).source).toBe('bundled')
	})

	it('promotes pending to current at a spawn and keeps the one before', async () => {
		const h = await harness()
		const feed = makeFeed()
		const first = await activate(h, feed, '51.3.0', 1)
		expect(first).toMatchObject({
			source: 'managed',
			version: '51.3.0',
			engine: '62.14.0',
			entry: entryOf(h, '51.3.0'),
		})
		expect(first.updatedAt).toBe(h.clock.value)
		h.clock.value += 86_400_000
		const second = await activate(h, feed, '51.4.0', 2)
		expect(second).toMatchObject({ version: '51.4.0' })
		expect(h.store.snapshot()).toMatchObject({
			current: '51.4.0',
			previous: '51.3.0',
			pending: undefined,
		})
		// resolving again changes nothing
		expect(await h.manager.resolve()).toEqual(second)
	})

	it('keeps two versions and removes everything else, bad ones included', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		await activate(h, feed, '51.5.0', 3)
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual(
			[
				'51.4.0',
				'51.4.0.manifest.json',
				'51.4.0.manifest.json.sig',
				'51.5.0',
				'51.5.0.manifest.json',
				'51.5.0.manifest.json.sig',
			].sort(),
		)
	})

	it('goes back to previous, then bundled, when the quick check fails, and gives the failed one up for good', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		await writeFile(entryOf(h, '51.4.0'), '// tampered\n')
		const back = await h.manager.resolve()
		expect(back).toMatchObject({ source: 'managed', version: '51.3.0' })
		expect(back.wentBack?.[0]?.version).toBe('51.4.0')
		expect(back.wentBack?.[0]?.reason).toMatch(/dist\/bin\.js/u)
		expect(h.store.snapshot().bad['51.4.0']).toBeDefined()
		expect(await exists(join(h.kernelRoot, 'versions', '51.4.0'))).toBe(false)
		await writeFile(entryOf(h, '51.3.0'), '// tampered too\n')
		expect(await h.manager.resolve()).toMatchObject({
			source: 'bundled',
			wentBack: [{ version: '51.3.0' }],
		})
		const emptied = h.store.snapshot()
		expect([emptied.current, emptied.previous]).toEqual([undefined, undefined])
	})

	const damage: [string, (h: Harness, v: string) => Promise<void>][] = [
		[
			'a changed package.json',
			(h, v) => writeFile(join(h.kernelRoot, 'versions', v, 'package.json'), '{}'),
		],
		[
			'a changed kernel.json',
			(h, v) => writeFile(join(h.kernelRoot, 'versions', v, 'kernel.json'), '{}'),
		],
		[
			'a changed native file',
			(h, v) =>
				writeFile(join(h.kernelRoot, 'versions', v, 'node_modules', 'pty', 'pty.node'), 'x'),
		],
		[
			'a changed files.json',
			(h, v) =>
				writeFile(join(h.kernelRoot, 'versions', v, 'files.json'), '{"schema":1,"files":[]}\n'),
		],
		[
			'a stored manifest that was altered',
			(h, v) => writeFile(pairPaths(h.store.paths, v).manifest, '{}'),
		],
		[
			'a stored signature from another key',
			async (h, v) => {
				const other = (await import('./kernel-test-support.js')).makeKey()
				const pair = signPair(
					JSON.parse((await nodeFs.readFile(pairPaths(h.store.paths, v).manifest)).toString()),
					other,
				)
				await writeFile(pairPaths(h.store.paths, v).signature, pair.signature)
			},
		],
		[
			'a missing entry file',
			(h, v) => nodeFs.rm(join(h.kernelRoot, 'versions', v, 'dist', 'bin.js')),
		],
	]
	for (const [label, change] of damage)
		it(`gives up an engine with ${label}`, async () => {
			const h = await harness()
			await activate(h, makeFeed(), '51.3.0', 1)
			await change(h, '51.3.0')
			expect(await h.manager.resolve()).toMatchObject({ source: 'bundled' })
			expect(h.store.snapshot().bad['51.3.0']).toBeDefined()
		})

	it('gives up an engine that is not newer than the bundled one (the app was updated past it)', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		const newer = await harness({
			bundled: { commandLine: '51.9.0', engine: '62.20.0', dataEpoch: 1 },
			key: h.key,
		})
		void newer
		// the same folder, now run by an app whose bundled engine is newer
		const next = await h.restart()
		const manager = new (await import('./manager.js')).KernelManager({
			...next.manager.options,
			bundledFacts: async () => ({ commandLine: '51.9.0', engine: '62.20.0', dataEpoch: 1 }),
		})
		expect(await manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(next.store.snapshot().bad['51.3.0']?.reason).toMatch(/not newer/u)
	})

	it('gives up an engine below the floor, with another data epoch, or another contract', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await h.store.update((s) => {
			s.minimumKernel = '51.4.0'
		})
		expect(await h.manager.resolve()).toMatchObject({
			source: 'bundled',
			wentBack: [{ reason: expect.stringMatching(/lowest/u) }],
		})

		const h2 = await harness()
		await activate(h2, makeFeed(), '51.3.0', 1)
		const other = new (await import('./manager.js')).KernelManager({
			...h2.manager.options,
			bundledFacts: async () => ({ ...(await h2.manager.options.bundledFacts())!, dataEpoch: 2 }),
		})
		expect(await other.resolve()).toMatchObject({
			source: 'bundled',
			wentBack: [{ reason: expect.stringMatching(/data format/u) }],
		})

		const h3 = await harness()
		await activate(h3, makeFeed(), '51.3.0', 1)
		const narrow = new (await import('./manager.js')).KernelManager({
			...h3.manager.options,
			contractRange: [2, 3],
		})
		expect(await narrow.resolve()).toMatchObject({
			source: 'bundled',
			wentBack: [{ reason: expect.stringMatching(/another version of this app/u) }],
		})
	})

	it('gives up an engine built for another computer', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		const other = new (await import('./manager.js')).KernelManager({
			...h.manager.options,
			arch: 'arm64',
		})
		expect(await other.resolve()).toMatchObject({ source: 'bundled' })
	})
})

describe('going back at a spawn', () => {
	it('marks a managed engine bad when the host fails, starts once more on what resolves next, and says so', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		const tried: string[] = []
		const outcome = await startWithFallback(h.manager, async (kernel) => {
			tried.push(kernel.version ?? 'bundled')
			if (kernel.version === '51.4.0') throw new Error('lacks namzu/tasks')
			return 'host'
		})
		expect(tried).toEqual(['51.4.0', '51.3.0'])
		expect(outcome).toMatchObject({ value: 'host', retried: true, kernel: { version: '51.3.0' } })
		expect(outcome.kernel.wentBack?.[0]?.version).toBe('51.4.0')
		expect(h.store.snapshot().bad['51.4.0']?.reason).toMatch(/lacks namzu\/tasks/u)
	})

	it('goes back at most through the previous engine to the bundled one, which ends the chain', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		const tried: string[] = []
		await expect(
			startWithFallback(h.manager, async (kernel) => {
				tried.push(kernel.version ?? 'bundled')
				throw new Error('nope')
			}),
		).rejects.toThrow('nope')
		expect(tried).toEqual(['51.4.0', '51.3.0', 'bundled'])
		expect(h.store.snapshot().bad['51.3.0']).toBeDefined()
	})

	it('does not retry or mark anything when the bundled engine fails', async () => {
		const h = await harness()
		let attempts = 0
		await expect(
			startWithFallback(h.manager, async () => {
				attempts++
				throw new Error('x')
			}),
		).rejects.toThrow('x')
		expect(attempts).toBe(1)
	})

	it('does not mark an engine for a failure the caller says is not the engine’s', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await expect(
			startWithFallback(
				h.manager,
				async () => {
					throw new Error('folder is gone')
				},
				{ isKernelFault: () => false },
			),
		).rejects.toThrow('folder is gone')
		expect(h.store.snapshot().current).toBe('51.3.0')
	})
})

describe('hosts that die early', () => {
	it('gives an engine up after two early exits within its first three starts', async () => {
		const h = await harness()
		const resolved = await activate(h, makeFeed(), '51.3.0', 1)
		const one = await h.manager.hostStarted(resolved)
		h.clock.value += 4000
		expect(await h.manager.hostExited(one, { unexpected: true })).toBe(false)
		const two = await h.manager.hostStarted(resolved)
		h.clock.value += 9000
		expect(await h.manager.hostExited(two, { unexpected: true })).toBe(true)
		expect(h.store.snapshot().bad['51.3.0']?.reason).toMatch(/early/u)
		expect((await h.manager.resolve()).source).toBe('bundled')
	})

	it('does not count a long run, a close the app asked for, or an exit counted twice', async () => {
		const h = await harness()
		const resolved = await activate(h, makeFeed(), '51.3.0', 1)
		const a = await h.manager.hostStarted(resolved)
		h.clock.value += 10_000
		await h.manager.hostExited(a, { unexpected: true })
		const b = await h.manager.hostStarted(resolved)
		h.clock.value += 1000
		await h.manager.hostExited(b, { unexpected: false })
		const c = await h.manager.hostStarted(resolved)
		h.clock.value += 1000
		await h.manager.hostExited(c, { unexpected: true })
		await h.manager.hostExited(c, { unexpected: true })
		expect(h.store.snapshot().earlyExits['51.3.0']).toBe(1)
		expect(h.store.snapshot().bad['51.3.0']).toBeUndefined()
	})

	it('ignores early exits of a fourth start and later', async () => {
		const h = await harness()
		const resolved = await activate(h, makeFeed(), '51.3.0', 1)
		for (let index = 0; index < 3; index++) {
			const token = await h.manager.hostStarted(resolved)
			h.clock.value += 20_000
			await h.manager.hostExited(token, { unexpected: true })
		}
		for (let index = 0; index < 3; index++) {
			const token = await h.manager.hostStarted(resolved)
			h.clock.value += 1000
			await h.manager.hostExited(token, { unexpected: true })
		}
		expect(h.store.snapshot().bad['51.3.0']).toBeUndefined()
	})
})

describe('use this app’s own engine', () => {
	it('gives up the current, previous and pending engines and takes effect at the next spawn', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		publish(h, feed, '51.5.0', 3)
		await runCheck({
			manager: h.manager,
			feedBase: FEED,
			channel: 'latest',
			fetch: feed.fetch,
			now: h.clock.now,
			selfCheck: async () => undefined,
		})
		await h.manager.useOwnEngine()
		const own = h.store.snapshot()
		expect([own.current, own.previous, own.pending]).toEqual([undefined, undefined, undefined])
		expect((await h.manager.resolve()).source).toBe('bundled')
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual([])
	})

	it('still lets a newer engine arrive later', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await h.manager.useOwnEngine()
		expect(await activate(h, feed, '51.6.0', 9)).toMatchObject({ version: '51.6.0' })
	})
})

describe('the first reason for giving a version up stays', () => {
	it('is not replaced by a later symptom of the same give-up', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		expect(await h.manager.markBad('51.3.0', 'withdrawn')).toBe(true)
		await h.manager.markBad('51.3.0', 'dist/chunks/chunk-1.js vanished')
		expect(h.store.snapshot().bad['51.3.0']?.reason).toBe('withdrawn')
	})
})

describe('deleting', () => {
	it('never removes the folder a live host was started from', async () => {
		const h = await harness()
		const feed = makeFeed()
		const first = await activate(h, feed, '51.3.0', 1)
		const token = await h.manager.hostStarted(first)
		await activate(h, feed, '51.4.0', 2)
		await activate(h, feed, '51.5.0', 3)
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0'))).toBe(true)
		expect(await exists(join(h.kernelRoot, 'versions', '51.4.0'))).toBe(true)
		await h.manager.hostExited(token, { unexpected: false })
		await h.manager.cleanup()
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0'))).toBe(false)
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0.manifest.json'))).toBe(false)
	})

	it('never removes the folder a tab or a short command runs from, and does not count it as a start', async () => {
		const h = await harness()
		const feed = makeFeed()
		const first = await activate(h, feed, '51.3.0', 1)
		const release = h.manager.hold(first)
		expect(h.store.snapshot().starts).toEqual({})
		await activate(h, feed, '51.4.0', 2)
		await activate(h, feed, '51.5.0', 3)
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0'))).toBe(true)
		release()
		release()
		expect(h.manager.inUse().size).toBe(0)
		await h.manager.cleanup()
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0'))).toBe(false)
	})

	it('holds nothing for the bundled engine', async () => {
		const h = await harness()
		const release = h.manager.hold(await h.manager.resolve())
		expect(h.manager.inUse().size).toBe(0)
		release()
	})

	it('leaves a delete that fails for the next start and does not stop the others', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		await mkdir(join(h.kernelRoot, 'versions', '9.9.9'))
		await mkdir(join(h.kernelRoot, 'versions', '9.9.8'))
		let refused = true
		const stubborn = {
			...nodeFs,
			rm: async (path: string) => {
				if (refused && path.endsWith('9.9.9'))
					throw Object.assign(new Error('busy'), { code: 'EBUSY' })
				await nodeFs.rm(path)
			},
		}
		const next = await h.restart(stubborn)
		await next.manager.cleanup()
		expect(await readdir(join(h.kernelRoot, 'versions'))).toContain('9.9.9')
		expect(await readdir(join(h.kernelRoot, 'versions'))).not.toContain('9.9.8')
		refused = false
		const later = await h.restart()
		await later.manager.cleanup()
		expect(await readdir(join(h.kernelRoot, 'versions'))).not.toContain('9.9.9')
		void next
	})

	it('removes the leftovers of an interrupted install at the next start', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await mkdir(join(h.kernelRoot, 'tmp', '51.4.0'), { recursive: true })
		await writeFile(join(h.kernelRoot, 'tmp', 'namzu-kernel-51.4.0-win32-x64.tar.gz'), 'partial')
		await writeFile(join(h.kernelRoot, 'versions', '51.4.0.manifest.json.tmp'), 'half')
		await mkdir(join(h.kernelRoot, 'versions', '51.4.0'))
		const next = await h.restart()
		await next.manager.cleanup()
		expect(await readdir(join(h.kernelRoot, 'tmp'))).toEqual([])
		expect((await readdir(join(h.kernelRoot, 'versions'))).sort()).toEqual([
			'51.3.0',
			'51.3.0.manifest.json',
			'51.3.0.manifest.json.sig',
		])
	})
})

describe('state on disk', () => {
	it('starts clean from a missing, empty, damaged or foreign state file', async () => {
		for (const text of [undefined, '', '{', '[]', '{"schema":2,"current":"51.3.0"}', 'null']) {
			const h = await harness()
			if (text !== undefined) await writeFile(join(h.kernelRoot, 'state.json'), text)
			const next = await h.restart()
			expect(next.store.snapshot().current).toBeUndefined()
			expect(next.store.snapshot()).toMatchObject({ bad: {}, lastSequence: 0 })
			expect((await next.manager.resolve()).source).toBe('bundled')
		}
	})

	it('keeps only what is valid: a version that is not a version, a path-like one, a bad one in a slot', async () => {
		const h = await harness()
		await writeFile(
			join(h.kernelRoot, 'state.json'),
			JSON.stringify({
				schema: 1,
				current: '../../etc',
				previous: '51.3.0',
				pending: '51.3.0',
				bad: { '51.2.0': { reason: 'r', at: 5 }, '../x': { reason: 'r', at: 5 } },
				lastSequence: -4,
				earlyExits: { x: 1 },
			}),
		)
		const next = await h.restart()
		const state = next.store.snapshot()
		expect(state.current).toBeUndefined()
		expect(state.pending).toBeUndefined()
		expect(state).toMatchObject({
			previous: '51.3.0',
			lastSequence: 0,
			bad: { '51.2.0': { reason: 'r', at: 5 } },
		})
	})

	it('survives a failed write: the old file stays, memory moves on, and the next write catches the disk up', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		const before = (await nodeFs.readFile(join(h.kernelRoot, 'state.json'))).toString()
		let failing = true
		const broken = {
			...nodeFs,
			rename: async (from: string, to: string) => {
				if (failing && to.endsWith('state.json')) throw new Error('disk full')
				await nodeFs.rename(from, to)
			},
		}
		const next = await h.restart(broken)
		expect(await next.store.markBad('51.3.0', 'testing')).toBe(false)
		expect((await nodeFs.readFile(join(h.kernelRoot, 'state.json'))).toString()).toBe(before)
		expect(await exists(join(h.kernelRoot, 'state.json.tmp'))).toBe(false)
		expect(next.store.persisted).toBe(false)
		expect(await next.store.cleanup()).toEqual([])
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0'))).toBe(true)
		failing = false
		expect(
			await next.store.update((s) => {
				s.lastSequence = 7
			}),
		).toBe(true)
		expect(
			JSON.parse((await nodeFs.readFile(join(h.kernelRoot, 'state.json'))).toString()).bad[
				'51.3.0'
			],
		).toBeDefined()
	})
})

describe('the facts of the bundled engine', () => {
	const asked = { commandLine: '51.1.0', engine: '62.13.0', dataEpoch: 1 }
	it('reads kernel.json beside the bundled copy and does not ask', async () => {
		const h = await harness()
		await mkdir(join(h.root, 'cli'), { recursive: true })
		await writeFile(
			join(h.root, 'cli', 'kernel.json'),
			JSON.stringify({
				schema: 1,
				commandLine: '51.1.0',
				engine: '62.13.0',
				desktopContract: 1,
				dataEpoch: 1,
				platform: 'win32',
				arch: 'x64',
			}),
		)
		let calls = 0
		const read = bundledFactsReader({
			fs: nodeFs,
			cliFolder: join(h.root, 'cli'),
			ask: async () => {
				calls++
				return asked
			},
		})
		expect(await read()).toMatchObject({ commandLine: '51.1.0', dataEpoch: 1 })
		expect(calls).toBe(0)
	})

	it('asks the bundled program once when kernel.json is absent', async () => {
		const h = await harness()
		let calls = 0
		const read = bundledFactsReader({
			fs: nodeFs,
			cliFolder: join(h.root, 'none'),
			ask: async () => {
				calls++
				return asked
			},
		})
		expect(await read()).toMatchObject({ engine: '62.13.0' })
		await read()
		expect(calls).toBe(1)
	})

	it('is unavailable when nothing states them, or when the answer is not usable', async () => {
		const h = await harness()
		expect(
			await bundledFactsReader({ fs: nodeFs, cliFolder: join(h.root, 'none') })(),
		).toBeUndefined()
		expect(
			await bundledFactsReader({
				fs: nodeFs,
				cliFolder: join(h.root, 'none'),
				ask: async () => ({ ...asked, dataEpoch: 0 }),
			})(),
		).toBeUndefined()
		expect(
			await bundledFactsReader({
				fs: nodeFs,
				cliFolder: join(h.root, 'none'),
				ask: async () => {
					throw new Error('x')
				},
			})(),
		).toBeUndefined()
	})

	it('makes managed engines unavailable: no request, bundled runs', async () => {
		const h = await harness({ bundled: undefined })
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		expect(
			await runCheck({
				manager: h.manager,
				feedBase: FEED,
				channel: 'latest',
				fetch: feed.fetch,
				now: h.clock.now,
				selfCheck: async () => undefined,
			}),
		).toEqual({ kind: 'skipped', reason: 'unavailable' })
		expect((await h.manager.resolve()).source).toBe('bundled')
		expect(feed.requests).toEqual([])
	})
})

describe('what a host answers', () => {
	const expected = { commandLine: '51.3.0', engine: '62.14.0', desktopContract: 1, dataEpoch: 1 }
	const good = {
		agentInfo: { name: 'namzu' },
		extensions: ['a', 'b'],
		kernel: { engine: '62.14.0', dataEpoch: 1, commandLine: '51.3.0', desktopContract: 1 },
	}
	const run = (change: (v: any) => void, version = '51.3.0\n') => {
		const value = structuredClone(good)
		change(value)
		return checkHostAnswer({
			expected,
			versionOutput: version,
			initialize: value,
			requiredExtensions: ['a', 'b'],
		})
	}
	it('passes when everything agrees', () => {
		expect(run(() => undefined)).toBeUndefined()
		expect(run(() => undefined, 'namzu 51.3.0')).toBeUndefined()
	})
	it('names the first thing that disagrees', () => {
		expect(run(() => undefined, '51.2.0')).toMatch(/--version/u)
		expect(
			run((v) => {
				v.agentInfo.name = 'other'
			}),
		).toMatch(/another program/u)
		expect(
			run((v) => {
				v.extensions = ['a']
			}),
		).toMatch(/lacks the method b/u)
		expect(
			run((v) => {
				v.kernel = undefined
			}),
		).toMatch(/no kernel facts/u)
		expect(
			run((v) => {
				v.kernel.engine = '62.99.0'
			}),
		).toMatch(/engine/u)
		expect(
			run((v) => {
				v.kernel.dataEpoch = 2
			}),
		).toMatch(/epoch/u)
		expect(
			run((v) => {
				v.kernel.commandLine = '51.3.1'
			}),
		).toMatch(/command line/u)
		expect(
			run((v) => {
				v.kernel.desktopContract = 2
			}),
		).toMatch(/contract/u)
		expect(
			checkHostAnswer({
				expected,
				versionOutput: '51.3.0',
				initialize: undefined,
				requiredExtensions: [],
			}),
		).toMatch(/no answer/u)
	})
	it('reads the kernel object of an answer leniently', () => {
		expect(kernelFromInitialize({ kernel: { engine: '62.14.0', dataEpoch: 1 } })).toEqual({
			engine: '62.14.0',
			dataEpoch: 1,
		})
		expect(kernelFromInitialize({})).toBeUndefined()
		expect(kernelFromInitialize({ kernel: { engine: 'x', dataEpoch: 1 } })).toBeUndefined()
	})
})

describe('an old engine kept by a failed check never blocks the bundled one', () => {
	it('falls back to bundled when the versions folder is unreadable', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await nodeFs.rm(join(h.kernelRoot, 'versions'))
		expect((await h.manager.resolve()).source).toBe('bundled')
	})
})
