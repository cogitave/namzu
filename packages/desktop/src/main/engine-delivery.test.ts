import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngineDelivery, engineDeliveryAllowed, webFetch } from './engine-delivery.js'
import type { FetchLike } from './kernel/feed-fetch.js'
import {
	buildArchive,
	kernelFactsText,
	kernelFiles,
	makeKey,
	manifestObject,
	signPair,
} from './kernel/kernel-test-support.js'
import { KERNEL_FEED_URL, KERNEL_PUBLIC_KEYS } from './kernel/keys.js'
import { REQUIRED_EXTENSIONS } from './required-extensions.js'

const folders: string[] = []
afterEach(async () => {
	await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function scratch() {
	const folder = await mkdtemp(join(tmpdir(), 'namzu-delivery-test-'))
	folders.push(folder)
	return folder
}

const key = makeKey('test1')
const KEY_ENV = `${key.id}:${key.publicKey}`
const clock = {
	now: () => Date.UTC(2026, 10, 12, 12, 0, 0),
	after: () => () => undefined,
	every: () => () => undefined,
}

/** The engine a test installs: answers `--version` and `initialize` like the real one. */
function engineStub(version: string): string {
	return `
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }
let buffer = ''
process.stdin.on('data', (chunk) => {
	buffer += chunk
	for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
		const message = JSON.parse(buffer.slice(0, at))
		buffer = buffer.slice(at + 1)
		if (message.method !== 'initialize') continue
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
			agentInfo: { name: 'namzu' },
			extensions: ${JSON.stringify([...REQUIRED_EXTENSIONS])},
			kernel: { engine: '62.14.0', dataEpoch: 1, commandLine: ${JSON.stringify(version)}, desktopContract: 1 },
		} }) + '\\n')
	}
})
process.stdin.on('end', () => process.exit(0))
`
}

async function bundledFolder(root: string): Promise<string> {
	const folder = join(root, 'bundled')
	await mkdir(join(folder, 'dist'), { recursive: true })
	await writeFile(join(folder, 'dist', 'bin.js'), engineStub('51.1.0'))
	await writeFile(join(folder, 'package.json'), JSON.stringify({ version: '51.1.0' }))
	await writeFile(
		join(folder, 'kernel.json'),
		kernelFactsText({ commandLine: '51.1.0', engine: '62.13.0', platform: 'win32', arch: 'x64' }),
	)
	return folder
}

function options(root: string, over: Partial<Parameters<typeof createEngineDelivery>[0]> = {}) {
	const requests: string[] = []
	const fetch: FetchLike = async (url) => {
		requests.push(url)
		return { status: 404, body: null }
	}
	return {
		requests,
		options: {
			isPackaged: false,
			resourcesPath: undefined,
			// These tests say what they mean: the repository's own list is not what they rely on.
			compiledKeys: [],
			userData: join(root, 'userdata'),
			env: {},
			platform: 'win32',
			arch: 'x64',
			execPath: process.execPath,
			clientVersion: '0.5.0',
			fetch,
			clock,
			enabled: () => true,
			publish: () => undefined,
			nodeFlags: () => [],
			...over,
		} satisfies Parameters<typeof createEngineDelivery>[0],
	}
}

describe('building the engine delivery', () => {
	it('builds nothing with no compiled key, so nothing is asked and nothing is written', async () => {
		const root = await scratch()
		const { options: o, requests } = options(root, {
			env: { NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:1/' },
		})
		const none = createEngineDelivery(o)
		expect(none).toBeUndefined()
		expect(requests).toEqual([])
		expect(await readdir(root)).toEqual([])
	})

	it('never takes a key from the environment in a packaged app', async () => {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		// A packaged build keeps its bundled engine under <resources>/cli: it is there, and still no key.
		await mkdir(join(root, 'cli', 'dist'), { recursive: true })
		await writeFile(
			join(root, 'cli', 'dist', 'bin.js'),
			await readFile(join(bundled, 'dist', 'bin.js')),
		)
		const { options: o } = options(root, {
			isPackaged: true,
			resourcesPath: root,
			env: { NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV, NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled },
		})
		expect(createEngineDelivery(o)).toBeUndefined()
	})

	it('needs a bundled engine to compare with, even with a test key', async () => {
		const root = await scratch()
		const { options: o } = options(root, { env: { NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV } })
		expect(createEngineDelivery(o)).toBeUndefined()
	})

	it('takes a stand-in for the bundled engine only when not packaged and a test key is allowed', async () => {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		const withKey = {
			NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV,
			NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled,
			NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:9/feed/',
		}
		const built = createEngineDelivery(options(root, { env: withKey }).options)
		expect(built).toBeDefined()
		await built?.ready
		expect(
			createEngineDelivery(
				options(root, {
					env: {
						NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled,
						NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:9/feed/',
					},
				}).options,
			),
		).toBeUndefined()
	})

	it('finds, checks, keeps and then runs a newer engine, with a real self-check', async () => {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		const files = kernelFiles('52.0.0', '62.14.0', {
			extra: { 'dist/bin.js': engineStub('52.0.0') },
		})
		const built = buildArchive('52.0.0', files)
		const now = clock.now()
		const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z')
		const pair = signPair(
			manifestObject({
				commandLine: '52.0.0',
				engine: '62.14.0',
				bundles: { 'win32-x64': built.bundle },
				issuedAt: iso(now - 60_000),
				expiresAt: iso(now + 86_400_000),
				minimumKernel: '51.0.0',
			}),
			key,
		)
		const served = new Map<string, Buffer>([
			['kernel-latest.json', pair.manifest],
			['kernel-latest.json.sig', pair.signature],
			[built.file, built.gz],
		])
		const requests: { url: string; headers: Record<string, string> }[] = []
		const fetch: FetchLike = async (url, init) => {
			requests.push({ url, headers: init.headers })
			const data = served.get(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)))
			return data
				? {
						status: 200,
						body: (async function* () {
							yield new Uint8Array(data)
						})(),
					}
				: { status: 404, body: null }
		}
		const { options: o } = options(root, {
			fetch,
			env: {
				NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV,
				NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled,
				NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:9/feed/',
			},
		})
		const delivery = createEngineDelivery(o)
		expect(delivery).toBeDefined()
		await delivery?.ready
		const result = await delivery?.check()
		expect(result).toEqual({ kind: 'ready', version: '52.0.0', engine: '62.14.0' })
		expect(requests.map((request) => request.url)).toEqual([
			'http://127.0.0.1:9/feed/kernel-latest.json',
			'http://127.0.0.1:9/feed/kernel-latest.json.sig',
			`http://127.0.0.1:9/feed/${built.file}`,
		])
		// Nothing about the person or the machine goes with the request.
		for (const request of requests)
			expect(request.headers).toEqual({ 'User-Agent': 'namzu-desktop' })
		const lease = await delivery?.lease()
		expect(lease?.entry).toBe(
			join(root, 'userdata', 'kernel', 'versions', '52.0.0', 'dist', 'bin.js'),
		)
		lease?.release()
		expect(delivery?.view()).toMatchObject({
			available: true,
			runs: { source: 'managed', commandLine: '52.0.0' },
		})
		// The log has lines about it, and none of the person's folders.
		await delivery?.flushLog()
		const log = await readFile(join(root, 'userdata', 'kernel', 'updates.log'), 'utf8')
		expect(log).toContain('"event":"check"')
		expect(log).not.toContain(root)
	})

	it('makes no request with the setting off', async () => {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		const { options: o, requests } = options(root, {
			enabled: () => false,
			env: {
				NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV,
				NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled,
				NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:9/feed/',
			},
		})
		const delivery = createEngineDelivery(o)
		await delivery?.ready
		expect(await delivery?.check()).toEqual({ kind: 'skipped', reason: 'disabled' })
		expect(requests).toEqual([])
		expect(delivery?.view().status).toEqual({ kind: 'off' })
	})
})

describe('which runs may contact a feed', () => {
	/** A packaged-style resources folder holding the bundled engine. */
	async function packagedRoot() {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		await mkdir(join(root, 'res', 'cli', 'dist'), { recursive: true })
		await writeFile(join(root, 'res', 'cli', 'dist', 'bin.js'), engineStub('51.1.0'))
		await writeFile(
			join(root, 'res', 'cli', 'kernel.json'),
			await readFile(join(bundled, 'kernel.json')),
		)
		await writeFile(join(root, 'res', 'cli', 'package.json'), JSON.stringify({ version: '51.1.0' }))
		return { root, bundled, resources: join(root, 'res') }
	}
	function countingClock() {
		const timers: string[] = []
		return {
			timers,
			clock: {
				now: clock.now,
				after: () => {
					timers.push('after')
					return () => undefined
				},
				every: () => {
					timers.push('every')
					return () => undefined
				},
			},
		}
	}

	it('lists the first public key in the repository', () => {
		expect(KERNEL_PUBLIC_KEYS.map((entry) => entry.id)).toEqual(['k1'])
	})

	it('decides by isPackaged and an explicit feed address, nothing else', () => {
		expect(engineDeliveryAllowed({ isPackaged: true, env: {} })).toBe(true)
		expect(engineDeliveryAllowed({ isPackaged: false, env: {} })).toBe(false)
		expect(engineDeliveryAllowed({ isPackaged: false, env: { NAMZU_KERNEL_FEED_URL: '' } })).toBe(
			false,
		)
		expect(
			engineDeliveryAllowed({
				isPackaged: false,
				env: { NAMZU_KERNEL_FEED_URL: 'http://example.test/' },
			}),
		).toBe(false)
		expect(
			engineDeliveryAllowed({
				isPackaged: false,
				env: { NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:9/' },
			}),
		).toBe(true)
	})

	it('packaged with a key: active, and the first look goes to the compiled feed', async () => {
		const { root, resources } = await packagedRoot()
		const { timers, clock: counting } = countingClock()
		const { options: o, requests } = options(root, {
			isPackaged: true,
			resourcesPath: resources,
			compiledKeys: [key],
			compiledFeed: 'https://feed.example.test/kernel/',
			clock: counting,
		})
		const delivery = createEngineDelivery(o)
		expect(delivery).toBeDefined()
		await delivery?.ready
		delivery?.start()
		expect(timers.length).toBeGreaterThan(0)
		await delivery?.check()
		expect(requests[0]).toBe('https://feed.example.test/kernel/kernel-latest.json')
		delivery?.stop()
	})

	it('unpackaged with a key and no feed address: no object, no timer, no request, no folder', async () => {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		const { timers, clock: counting } = countingClock()
		const { options: o, requests } = options(root, {
			compiledKeys: [key],
			clock: counting,
			// A stand-in bundled engine and a test key are there, as in an end-to-end run.
			env: { NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV, NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled },
		})
		const delivery = createEngineDelivery(o)
		expect(delivery).toBeUndefined()
		delivery?.start()
		expect(timers).toEqual([])
		expect(requests).toEqual([])
		expect(await readdir(root)).toEqual(['bundled'])
		// The compiled address is never what an unpackaged run asks.
		expect(KERNEL_FEED_URL).toContain('https://')
	})

	it('unpackaged with an explicit feed address: active with that feed', async () => {
		const root = await scratch()
		const bundled = await bundledFolder(root)
		const { options: o, requests } = options(root, {
			compiledKeys: [key],
			compiledFeed: 'https://feed.example.test/kernel/',
			env: {
				NAMZU_KERNEL_TEST_BUNDLED_DIR: bundled,
				NAMZU_KERNEL_TEST_PUBLIC_KEY: KEY_ENV,
				NAMZU_KERNEL_FEED_URL: 'http://127.0.0.1:9/mine/',
			},
		})
		const delivery = createEngineDelivery(o)
		expect(delivery).toBeDefined()
		await delivery?.ready
		await delivery?.check()
		expect(requests[0]).toBe('http://127.0.0.1:9/mine/kernel-latest.json')
	})
})

describe('the platform fetch adapter', () => {
	it('reads a body through its reader and reports the final address', async () => {
		const adapted = webFetch(async () => new Response('hello', { status: 200 }))
		const response = await adapted('https://feed.test/a', {
			headers: {},
			redirect: 'manual',
			credentials: 'omit',
			signal: new AbortController().signal,
		})
		let text = ''
		for await (const chunk of response.body ?? []) text += new TextDecoder().decode(chunk)
		expect(response.status).toBe(200)
		expect(text).toBe('hello')
	})

	it('releases the body of a redirect and hands its address on', async () => {
		const adapted = webFetch(
			async () => new Response('moved', { status: 302, headers: { location: '/b' } }),
		)
		const response = await adapted('https://feed.test/a', {
			headers: {},
			redirect: 'manual',
			credentials: 'omit',
			signal: new AbortController().signal,
		})
		expect(response).toMatchObject({ status: 302, location: '/b', body: null })
	})
})
