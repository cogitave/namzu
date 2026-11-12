import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCheck } from './check.js'
import { type KernelFs, nodeFs } from './fs.js'
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

/**
 * The repairs after the two reviews of the engine delivery: each test here fails without its
 * repair. Archives and signed pairs come from the builders of kernel-test-support.
 */

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
	options: { minimumKernel?: string; bundleFile?: string } = {},
) {
	const built = buildArchive(commandLine, kernelFiles(commandLine, '62.14.0'))
	const file = options.bundleFile ?? built.file
	const pair = signPair(
		manifestObject({
			commandLine,
			engine: '62.14.0',
			sequence,
			...(options.minimumKernel ? { minimumKernel: options.minimumKernel } : {}),
			bundles: { 'win32-x64': { ...built.bundle, file } },
		}),
		h.key,
	)
	feed.files.set('kernel-latest.json', pair.manifest)
	feed.files.set('kernel-latest.json.sig', pair.signature)
	feed.files.set(file, built.gz)
}

const check = (h: Harness, feed: FakeFeed, extra: Partial<Parameters<typeof runCheck>[0]> = {}) =>
	runCheck({
		manager: h.manager,
		feedBase: FEED,
		channel: 'latest',
		fetch: feed.fetch,
		now: h.clock.now,
		selfCheck: async () => undefined,
		...extra,
	})

/** Installs and promotes one version, as a run of the app over a few days would. */
async function activate(h: Harness, feed: FakeFeed, commandLine: string, sequence: number) {
	publish(h, feed, commandLine, sequence)
	await check(h, feed)
	return h.manager.resolve()
}

const folderOf = (h: Harness, version: string) => join(h.kernelRoot, 'versions', version)
const exists = async (path: string) => (await stat(path).catch(() => undefined)) !== undefined

/** A file system whose reads of one path fail with an I/O error a number of times. */
function busyFs(path: string, times: number): KernelFs {
	let left = times
	return {
		...nodeFs,
		openRead: (target) => {
			if (target.endsWith(path) && left > 0) {
				left--
				throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${target}'`), {
					code: 'EBUSY',
				})
			}
			return nodeFs.openRead(target)
		},
	}
}

describe('the quick check hashes the whole folder once per run', () => {
	it('refuses an engine whose other files were swapped', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await writeFile(join(folderOf(h, '51.3.0'), 'dist', 'chunk-one.js'), 'export const one = 2\n')
		const next = await h.restart()
		expect(await next.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(next.store.snapshot().bad['51.3.0']?.reason).toMatch(/chunk-one\.js does not match/u)
	})

	it('refuses an engine with a file the list does not name', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await writeFile(join(folderOf(h, '51.3.0'), 'node_modules', 'pty', 'extra.dll'), 'MZ')
		const next = await h.restart()
		expect(await next.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(next.store.snapshot().bad['51.3.0']?.reason).toMatch(/extra\.dll is not listed/u)
	})
})

describe('the signed pairs on disk outlast the state file', () => {
	it('a lost state file does not let an older signed answer back in', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 9)
		await rm(h.store.paths.state)
		const next = await h.restart()
		expect(next.store.snapshot().lastSequence).toBe(0)
		publish(h, feed, '51.2.0', 5)
		const result = await check(h, feed, { manager: next.manager })
		expect(result).toMatchObject({ kind: 'failed', stage: 'replay' })
	})

	it('the floor a stored pair states holds when the state file forgets it', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		publish(h, feed, '51.4.0', 2, { minimumKernel: '51.4.0' })
		await check(h, feed)
		await h.manager.resolve()
		// The state file is edited: no floor, and the older engine is the current one again.
		await h.store.update((state) => {
			state.minimumKernel = undefined
			state.current = '51.3.0'
			state.previous = undefined
			state.pending = undefined
		})
		expect(await h.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(h.store.snapshot().bad['51.3.0']?.reason).toMatch(/below the lowest/u)
	})
})

describe('going back at a spawn ends in a working start', () => {
	it('goes on to the bundled engine in the same open when the fetched ones both fail', async () => {
		const h = await harness()
		const feed = makeFeed()
		await activate(h, feed, '51.3.0', 1)
		await activate(h, feed, '51.4.0', 2)
		const tried: string[] = []
		const outcome = await startWithFallback(h.manager, async (kernel) => {
			tried.push(kernel.version ?? 'bundled')
			if (kernel.source === 'managed') throw new Error('boom')
			return 'host'
		})
		expect(tried).toEqual(['51.4.0', '51.3.0', 'bundled'])
		expect(outcome).toMatchObject({ value: 'host', retried: true, kernel: { source: 'bundled' } })
		expect(outcome.kernel.wentBack?.map((entry) => entry.version)).toEqual(['51.3.0', '51.4.0'])
		// The folders of the given-up engines are removed at once, not at the next start.
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual([])
	})

	it('keeps the folder of the engine a host is starting from, even when the person gives it up meanwhile', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		let during = false
		let after = false
		const outcome = await startWithFallback(h.manager, async (kernel) => {
			await h.manager.useOwnEngine()
			during = await exists(folderOf(h, kernel.version ?? ''))
			return 'host'
		})
		expect(during).toBe(true)
		outcome.release()
		await h.manager.cleanup()
		after = await exists(folderOf(h, '51.3.0'))
		expect(after).toBe(false)
	})

	it('holds a resolved engine only when asked, and the hold ends with release', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		const held = await h.manager.resolve({ hold: true })
		expect([...h.manager.inUse()]).toEqual(['51.3.0'])
		held.release?.()
		expect([...h.manager.inUse()]).toEqual([])
		const plain = await h.manager.resolve()
		expect(plain.release).toBeUndefined()
		expect([...h.manager.inUse()]).toEqual([])
	})
})

describe('a check and the person’s choices', () => {
	it('"use this app’s own engine" during a check is not undone by the check', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		const result = await check(h, feed, {
			selfCheck: async () => {
				await h.manager.useOwnEngine()
				return undefined
			},
		})
		expect(result).toMatchObject({ kind: 'failed', stage: 'install' })
		expect(h.store.snapshot().pending).toBeUndefined()
		expect(h.store.snapshot().bad['51.3.0']?.reason).toMatch(/chose this app/u)
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual([])
	})

	it('turning the setting off during a check leaves nothing pending', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		const result = await check(h, feed, {
			selfCheck: async () => {
				h.flags.enabled = false
				return undefined
			},
		})
		expect(result).toMatchObject({ kind: 'failed', stage: 'install' })
		expect(h.store.snapshot().pending).toBeUndefined()
		expect(h.store.snapshot().bad['51.3.0']).toBeUndefined()
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual([])
	})

	it('a check that is told to stop leaves nothing pending', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		const controller = new AbortController()
		const result = await check(h, feed, {
			signal: controller.signal,
			selfCheck: async () => {
				controller.abort()
				return undefined
			},
		})
		expect(result).toMatchObject({ kind: 'failed', stage: 'install' })
		expect(h.store.snapshot().pending).toBeUndefined()
	})

	it('a self-check that ran out of time says nothing against the engine', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		const result = await check(h, feed, {
			selfCheck: async () => 'initialize did not answer in time',
		})
		expect(result).toMatchObject({ kind: 'failed', stage: 'self-check' })
		expect(h.store.snapshot().bad['51.3.0']).toBeUndefined()
		// A later check tries again and this time it works.
		expect(await check(h, feed)).toMatchObject({ kind: 'ready', version: '51.3.0' })
	})

	it('names the archive and its folder by fixed names, not by what the signed file says', async () => {
		const h = await harness()
		const feed = makeFeed()
		// The file is named like the version: it used to be the same path as the unpacked folder.
		publish(h, feed, '51.3.0', 1, { bundleFile: '51.3.0' })
		expect(await check(h, feed)).toMatchObject({ kind: 'ready', version: '51.3.0' })
	})

	it('keeps raw error text, with the person’s folders, out of the stored problem', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, '51.3.0', 1)
		await check(h, feed, {
			selfCheck: async () => {
				throw new Error(`failed to open C:\\Users\\Some One\\AppData\\x and ${h.root}/versions/a`)
			},
		})
		const problem = h.store.snapshot().lastCheck?.problem ?? ''
		expect(problem).not.toContain('Some One')
		expect(problem).not.toContain(h.root)
	})
})

describe('a read that fails for a moment is not a verdict', () => {
	it('is tried once more, and the engine stays', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		const next = await h.restart(busyFs('dist/bin.js', 1))
		expect(await next.manager.resolve()).toMatchObject({ source: 'managed', version: '51.3.0' })
		expect(next.store.snapshot().bad['51.3.0']).toBeUndefined()
	})

	it('runs the bundled engine for that start only when it stays unreadable', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		const next = await h.restart(busyFs('dist/bin.js', 2))
		expect(await next.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(next.store.snapshot().bad['51.3.0']).toBeUndefined()
		expect(next.store.snapshot().current).toBe('51.3.0')
		// The next start finds it healthy and uses it again.
		expect(await next.manager.resolve()).toMatchObject({ source: 'managed', version: '51.3.0' })
	})

	it('gives the reason without the paths of the person’s computer', async () => {
		const h = await harness()
		await activate(h, makeFeed(), '51.3.0', 1)
		await rm(pairPaths(h.store.paths, '51.3.0').signature)
		const next = await h.restart()
		await next.manager.resolve()
		const reason = next.store.snapshot().bad['51.3.0']?.reason ?? ''
		expect(reason).toMatch(/^unreadable \(ENOENT\)$/u)
	})
})

describe('what the quick check compares', () => {
	/** Puts a folder and its signed pair on disk as if an install had made them, then makes it current. */
	async function plant(
		h: Harness,
		version: string,
		options: {
			facts?: { platform?: string }
			manifestFor?: string
			files?: Record<string, string>
		} = {},
	) {
		const files = options.files ?? kernelFiles(version, '62.14.0', {})
		if (options.facts?.platform)
			files['kernel.json'] = JSON.stringify({
				...JSON.parse(files['kernel.json'] as string),
				platform: options.facts.platform,
			})
		const built = buildArchive(version, files)
		const manifestVersion = options.manifestFor ?? version
		const pair = signPair(
			manifestObject({
				commandLine: manifestVersion,
				engine: '62.14.0',
				bundles: { 'win32-x64': built.bundle },
			}),
			h.key,
		)
		const folder = folderOf(h, version)
		for (const [path, data] of [
			...Object.entries(files),
			['files.json', built.filesJson],
		] as const) {
			const target = join(folder, ...path.split('/'))
			await mkdir(join(target, '..'), { recursive: true })
			await writeFile(target, data)
		}
		const paths = pairPaths(h.store.paths, version)
		await writeFile(paths.manifest, pair.manifest)
		await writeFile(paths.signature, pair.signature)
		await h.store.update((state) => {
			state.current = version
		})
	}

	it('gives up an engine built for another computer', async () => {
		const h = await harness()
		await plant(h, '51.3.0', { facts: { platform: 'linux' } })
		expect(await h.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(h.store.snapshot().bad['51.3.0']?.reason).toBe('built for another computer')
	})

	it('gives up an engine whose stored pair is for another version', async () => {
		const h = await harness()
		await plant(h, '51.3.0', { manifestFor: '51.9.0' })
		expect(await h.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(h.store.snapshot().bad['51.3.0']?.reason).toBe(
			'the stored manifest is for another version',
		)
	})

	it('gives up an engine whose files.json and entry were edited together', async () => {
		const h = await harness()
		await plant(h, '51.3.0')
		const bin = join(folderOf(h, '51.3.0'), 'dist', 'bin.js')
		const edited = 'process.exit(0) // evil\n'
		await writeFile(bin, edited)
		const list = JSON.parse(await readFile(join(folderOf(h, '51.3.0'), 'files.json'), 'utf8'))
		const { createHash } = await import('node:crypto')
		for (const entry of list.files)
			if (entry.path === 'dist/bin.js') {
				entry.size = Buffer.byteLength(edited)
				entry.sha256 = createHash('sha256').update(edited).digest('hex')
			}
		await writeFile(join(folderOf(h, '51.3.0'), 'files.json'), `${JSON.stringify(list)}\n`)
		expect(await h.manager.resolve()).toMatchObject({ source: 'bundled' })
		expect(h.store.snapshot().bad['51.3.0']?.reason).toBe('files.json changed')
	})

	it('does not run an engine that was given up, whatever the folder holds', async () => {
		const h = await harness()
		await plant(h, '51.3.0')
		await h.store.markBad('51.3.0', 'it failed')
		const verdict = await h.manager.quickCheck('51.3.0', h.bundledFacts as never)
		expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/already given up/u) })
	})
})

describe('the folder cleanup leaves a version that is being installed', () => {
	it('does not remove it until the install is over', async () => {
		const h = await harness()
		const unpacked = join(h.kernelRoot, 'tmp', 'unpacked')
		await mkdir(unpacked, { recursive: true })
		await writeFile(join(unpacked, 'x'), 'x')
		await h.store.installFolder('51.3.0', unpacked, {
			manifest: Buffer.from('m'),
			signature: Buffer.from('s'),
		})
		expect(await h.store.cleanup()).toEqual([])
		expect(await exists(folderOf(h, '51.3.0'))).toBe(true)
		h.store.finishInstall('51.3.0')
		expect((await h.store.cleanup()).sort()).toEqual([
			'51.3.0',
			'51.3.0.manifest.json',
			'51.3.0.manifest.json.sig',
		])
	})
})
