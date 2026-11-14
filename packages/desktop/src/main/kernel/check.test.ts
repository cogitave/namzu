import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type CheckDeps, type CheckResult, runCheck, singleFlight } from './check.js'
import { RETRY_AFTER_MS } from './check.js'
import { nodeFs } from './fs.js'
import {
	FEED,
	type FakeFeed,
	type Harness,
	type TarEntry,
	buildArchive,
	chunks,
	faultyFs,
	kernelFactsText,
	kernelFiles,
	makeClock,
	makeFeed,
	makeHarness,
	makeKey,
	manifestObject,
	signPair,
} from './kernel-test-support.js'
import { engineStatus } from './view.js'

const open: Harness[] = []
afterEach(async () => {
	await Promise.all(open.splice(0).map((h) => h.dispose()))
})
async function harness(options: Parameters<typeof makeHarness>[0] = {}) {
	const h = await makeHarness(options)
	open.push(h)
	return h
}

interface Release {
	commandLine: string
	engine?: string
	sequence?: number
	issuedAt?: string
	expiresAt?: string
	minimumKernel?: string
	withdrawn?: string[]
	dataEpoch?: number
	desktopContract?: number
	channel?: string
	platform?: string
	files?: Record<string, string>
	entries?: (e: TarEntry[]) => TarEntry[]
	signWith?: ReturnType<typeof makeKey>
	keyId?: string
}

/** Puts a signed release on the feed. Returns what it put there. */
function publish(h: Harness, feed: FakeFeed, release: Release) {
	const engine = release.engine ?? '62.14.0'
	const files =
		release.files ??
		kernelFiles(release.commandLine, engine, {
			dataEpoch: release.dataEpoch ?? 1,
			desktopContract: release.desktopContract ?? 1,
		})
	const built = buildArchive(release.commandLine, files, {
		...(release.entries ? { entries: release.entries } : {}),
		platform: release.platform ?? 'win32',
	})
	const pair = signPair(
		manifestObject({
			commandLine: release.commandLine,
			engine,
			bundles: { [`${release.platform ?? 'win32'}-x64`]: built.bundle },
			...(release.sequence !== undefined ? { sequence: release.sequence } : {}),
			...(release.issuedAt ? { issuedAt: release.issuedAt } : {}),
			...(release.expiresAt ? { expiresAt: release.expiresAt } : {}),
			...(release.minimumKernel ? { minimumKernel: release.minimumKernel } : {}),
			...(release.withdrawn ? { withdrawn: release.withdrawn } : {}),
			...(release.dataEpoch ? { dataEpoch: release.dataEpoch } : {}),
			...(release.desktopContract ? { desktopContract: release.desktopContract } : {}),
			...(release.channel ? { channel: release.channel } : {}),
		}),
		release.signWith ?? h.key,
		release.keyId ? { keyId: release.keyId } : {},
	)
	feed.files.set(`kernel-${release.channel ?? 'latest'}.json`, pair.manifest)
	feed.files.set(`kernel-${release.channel ?? 'latest'}.json.sig`, pair.signature)
	feed.files.set(built.file, built.gz)
	return { built, pair }
}

function deps(h: Harness, feed: FakeFeed, extra: Partial<CheckDeps> = {}): CheckDeps {
	return {
		manager: h.manager,
		feedBase: FEED,
		channel: 'latest',
		fetch: feed.fetch,
		now: h.clock.now,
		selfCheck: async () => undefined,
		...extra,
	}
}

async function tmpIsEmpty(h: Harness): Promise<boolean> {
	return (await readdir(join(h.kernelRoot, 'tmp'))).length === 0
}
async function exists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined)) !== undefined
}
function stateOf(h: Harness) {
	return h.store.snapshot()
}
function failed(result: CheckResult, stage: string) {
	expect(result).toMatchObject({ kind: 'failed', stage })
}

describe('skipping', () => {
	it('makes no request without a compiled key, with the setting off, under an override, or without bundled facts', async () => {
		const cases: [Parameters<typeof makeHarness>[0], string][] = [
			[{ keys: [] }, 'no-key'],
			[{ enabled: false }, 'disabled'],
			[{ override: '/dev/cli/dist/bin.js' }, 'override'],
			[{ bundled: undefined }, 'unavailable'],
		]
		for (const [options, reason] of cases) {
			const h = await harness(options)
			const feed = makeFeed()
			publish(h, feed, { commandLine: '51.3.0' })
			expect(await runCheck(deps(h, feed))).toEqual({ kind: 'skipped', reason })
			expect(feed.requests, reason).toEqual([])
			expect(stateOf(h).lastCheck).toBeUndefined()
		}
	})
})

describe('a good release', () => {
	it('is downloaded, checked, stored with its signed pair and made pending; nothing but the user agent is sent', async () => {
		const h = await harness()
		const feed = makeFeed()
		const { pair } = publish(h, feed, { commandLine: '51.3.0' })
		const result = await runCheck(deps(h, feed))
		expect(result).toEqual({ kind: 'ready', version: '51.3.0', engine: '62.14.0' })
		const state = stateOf(h)
		expect(state.pending).toBe('51.3.0')
		expect(state.current).toBeUndefined()
		expect(state.lastFreshCheckAt).toBe(h.clock.value)
		expect(state.lastSequence).toBe(1794480000)
		expect(
			(await nodeFs.readFile(join(h.kernelRoot, 'versions', '51.3.0.manifest.json'))).equals(
				pair.manifest,
			),
		).toBe(true)
		expect(
			(await nodeFs.readFile(join(h.kernelRoot, 'versions', '51.3.0.manifest.json.sig'))).equals(
				pair.signature,
			),
		).toBe(true)
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0', 'dist', 'bin.js'))).toBe(true)
		expect(await tmpIsEmpty(h)).toBe(true)
		for (const headers of feed.headers) expect(headers).toEqual({ 'User-Agent': 'namzu-desktop' })
		expect(feed.requests[0]).toBe(`${FEED}kernel-latest.json`)
	})

	it('run twice gives the same state and downloads once', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		await runCheck(deps(h, feed))
		const first = stateOf(h)
		const archiveRequests = () => feed.requests.filter((url) => url.endsWith('.tar.gz')).length
		expect(archiveRequests()).toBe(1)
		const second = await runCheck(deps(h, feed))
		expect(second).toMatchObject({ kind: 'ready', version: '51.3.0' })
		expect(archiveRequests()).toBe(1)
		expect({ ...stateOf(h), lastCheck: undefined }).toEqual({ ...first, lastCheck: undefined })
	})

	it('a second call while one runs gets the same answer', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		const check = singleFlight(() => runCheck(deps(h, feed)))
		const [one, two] = await Promise.all([check(), check()])
		expect(one).toBe(two)
		expect(feed.requests.filter((url) => url.endsWith('.tar.gz'))).toHaveLength(1)
	})

	it('a newer release replaces an older pending one and the old folder is removed', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		await runCheck(deps(h, feed))
		publish(h, feed, { commandLine: '51.4.0', sequence: 1794480001 })
		expect(await runCheck(deps(h, feed))).toMatchObject({ kind: 'ready', version: '51.4.0' })
		expect(stateOf(h).pending).toBe('51.4.0')
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual(
			['51.4.0', '51.4.0.manifest.json', '51.4.0.manifest.json.sig'].sort(),
		)
	})
})

describe('trust', () => {
	it('refuses a forged signature before anything is read from the manifest', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0', signWith: makeKey() })
		failed(await runCheck(deps(h, feed)), 'signature')
		expect(feed.requests).toHaveLength(2)
		expect(stateOf(h).lastSequence).toBe(0)
		expect(stateOf(h).pending).toBeUndefined()
	})

	it('refuses a key id it does not trust', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0', keyId: 'stranger' })
		failed(await runCheck(deps(h, feed)), 'signature')
	})

	it('refuses a manifest changed by one byte', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		const bytes = Buffer.from(feed.files.get('kernel-latest.json') as Buffer)
		bytes[bytes.indexOf('51.3.0')] = '6'.charCodeAt(0)
		feed.files.set('kernel-latest.json', bytes)
		failed(await runCheck(deps(h, feed)), 'signature')
		expect(feed.requests.some((url) => url.endsWith('.tar.gz'))).toBe(false)
	})

	it('refuses a replayed manifest with a lower sequence, and records nothing from it', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0', sequence: 200 })
		await runCheck(deps(h, feed))
		publish(h, feed, { commandLine: '51.2.0', sequence: 100, minimumKernel: '51.0.0' })
		failed(await runCheck(deps(h, feed)), 'replay')
		expect(stateOf(h).lastSequence).toBe(200)
	})

	it('accepts the same sequence again (a re-issue)', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0', sequence: 200 })
		await runCheck(deps(h, feed))
		expect(await runCheck(deps(h, feed))).toMatchObject({ kind: 'ready' })
	})

	it('refuses a manifest for another channel even when it is signed', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		const real = JSON.parse(feed.files.get('kernel-latest.json')?.toString() as string)
		real.channel = 'beta'
		const pair = signPair(real, h.key)
		feed.files.set('kernel-latest.json', pair.manifest)
		feed.files.set('kernel-latest.json.sig', pair.signature)
		failed(await runCheck(deps(h, feed)), 'channel')
	})

	it('refuses a manifest with a field it does not know', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		const value = JSON.parse(feed.files.get('kernel-latest.json')?.toString() as string)
		value.surprise = true
		const pair = signPair(value, h.key)
		feed.files.set('kernel-latest.json', pair.manifest)
		feed.files.set('kernel-latest.json.sig', pair.signature)
		failed(await runCheck(deps(h, feed)), 'manifest')
	})
})

describe('freshness without trusting the clock', () => {
	it('installs nothing from an expired manifest and does not move lastFreshCheckAt', async () => {
		const h = await harness({ clock: makeClock('2026-12-30T00:00:00Z') })
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		expect(await runCheck(deps(h, feed))).toEqual({ kind: 'stale' })
		expect(stateOf(h).lastFreshCheckAt).toBeUndefined()
		expect(stateOf(h).pending).toBeUndefined()
		expect(feed.requests.some((url) => url.endsWith('.tar.gz'))).toBe(false)
	})

	it('an expired manifest replayed with the clock set back is still stale', async () => {
		const h = await harness({ clock: makeClock('2026-12-01T00:00:00Z') })
		const feed = makeFeed()
		// A good newer manifest seen at the true time raises the floor of trusted time.
		publish(h, feed, {
			commandLine: '51.3.0',
			sequence: 500,
			issuedAt: '2026-11-30T00:00:00Z',
			expiresAt: '2026-12-14T00:00:00Z',
		})
		expect(await runCheck(deps(h, feed))).toMatchObject({ kind: 'ready' })
		const seenAt = stateOf(h).lastFreshCheckAt
		// An old manifest (same sequence number, issued earlier, expired) and a clock set back.
		publish(h, feed, {
			commandLine: '51.9.0',
			sequence: 500,
			issuedAt: '2026-11-01T00:00:00Z',
			expiresAt: '2026-11-15T00:00:00Z',
		})
		h.clock.value = Date.parse('2026-11-10T00:00:00Z')
		expect(await runCheck(deps(h, feed))).toEqual({ kind: 'stale' })
		expect(stateOf(h).lastFreshCheckAt).toBe(seenAt)
		expect(stateOf(h).pending).toBe('51.3.0')
	})

	it('records the highest issue time and the floor, and never lowers them', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, {
			commandLine: '51.3.0',
			sequence: 5,
			minimumKernel: '51.2.0',
			issuedAt: '2026-11-12T10:00:00Z',
		})
		await runCheck(deps(h, feed))
		publish(h, feed, {
			commandLine: '51.3.0',
			sequence: 6,
			minimumKernel: '51.1.0',
			issuedAt: '2026-11-12T09:00:00Z',
			expiresAt: '2026-11-26T09:00:00Z',
		})
		await runCheck(deps(h, feed))
		expect(stateOf(h).minimumKernel).toBe('51.2.0')
		expect(stateOf(h).highestIssuedAt).toBe(Date.parse('2026-11-12T10:00:00Z'))
	})
})

describe('candidate rules', () => {
	async function noDownload(
		h: Harness,
		feed: FakeFeed,
		release: Release,
		expected: Record<string, unknown>,
	) {
		publish(h, feed, release)
		expect(await runCheck(deps(h, feed))).toMatchObject(expected)
		expect(feed.requests.some((url) => url.endsWith('.tar.gz'))).toBe(false)
		expect(stateOf(h).pending).toBeUndefined()
	}

	it('wants a version newer than the bundled one', async () => {
		const h = await harness()
		await noDownload(h, makeFeed(), { commandLine: '51.1.0' }, { kind: 'current' })
	})

	it('wants a version newer than the current one', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		await runCheck(deps(h, feed))
		await h.manager.resolve()
		expect(stateOf(h).current).toBe('51.3.0')
		feed.requests.length = 0
		await noDownload(h, feed, { commandLine: '51.2.0', sequence: 1794480001 }, { kind: 'current' })
	})

	it('wants a bundle for this platform and architecture', async () => {
		const h = await harness()
		await noDownload(
			h,
			makeFeed(),
			{ commandLine: '51.3.0', platform: 'darwin' },
			{ kind: 'current' },
		)
	})

	it('does not take a version below the floor', async () => {
		const h = await harness()
		// A manifest cannot offer an engine below its own floor (the reader refuses it), so the floor is
		// raised by one that offers something this machine has no bundle for, and a later one is below it.
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.4.0', minimumKernel: '51.4.0', platform: 'darwin' })
		await runCheck(deps(h, feed))
		await noDownload(
			h,
			feed,
			{ commandLine: '51.3.0', minimumKernel: '51.0.0', sequence: 1794480001 },
			{ kind: 'current' },
		)
	})

	it('does not take a withdrawn version', async () => {
		const h = await harness()
		await noDownload(
			h,
			makeFeed(),
			{ commandLine: '51.3.0', withdrawn: ['51.3.0'] },
			{ kind: 'current' },
		)
	})

	it('does not try a version that was marked bad again', async () => {
		const h = await harness()
		await h.store.markBad('51.3.0', 'it failed')
		await noDownload(h, makeFeed(), { commandLine: '51.3.0' }, { kind: 'current' })
	})

	it('says a newer app is needed when the contract is out of range, without downloading', async () => {
		const h = await harness()
		await noDownload(
			h,
			makeFeed(),
			{ commandLine: '51.3.0', desktopContract: 2 },
			{ kind: 'needs-newer-app', version: '51.3.0' },
		)
	})

	it('says a newer app is needed when the data epoch differs', async () => {
		const h = await harness()
		await noDownload(
			h,
			makeFeed(),
			{ commandLine: '51.3.0', dataEpoch: 2 },
			{ kind: 'needs-newer-app', version: '51.3.0' },
		)
	})

	it('withdrawing the engine in use takes it out of use, leaving the one before', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0', sequence: 1 })
		await runCheck(deps(h, feed))
		await h.manager.resolve()
		publish(h, feed, { commandLine: '51.4.0', sequence: 2 })
		await runCheck(deps(h, feed))
		await h.manager.resolve()
		expect(stateOf(h)).toMatchObject({ current: '51.4.0', previous: '51.3.0' })
		publish(h, feed, { commandLine: '51.4.0', sequence: 3, withdrawn: ['51.4.0'] })
		await runCheck(deps(h, feed))
		expect(stateOf(h)).toMatchObject({ current: '51.3.0' })
		expect(stateOf(h).previous).toBeUndefined()
		expect(stateOf(h).bad['51.4.0']?.reason).toBe('withdrawn')
		expect(await exists(join(h.kernelRoot, 'versions', '51.4.0'))).toBe(false)
	})
})

describe('the download', () => {
	it('refuses a download that ends early', async () => {
		const h = await harness()
		const feed = makeFeed()
		const { built } = publish(h, feed, { commandLine: '51.3.0' })
		feed.serve.set(built.file, () => ({ body: chunks(built.gz.subarray(0, built.gz.length - 10)) }))
		failed(await runCheck(deps(h, feed)), 'download')
		expect(stateOf(h).pending).toBeUndefined()
		expect(stateOf(h).bad['51.3.0']).toBeUndefined()
		expect(await tmpIsEmpty(h)).toBe(true)
	})

	it('stops an endless download at the size the manifest states', async () => {
		const h = await harness()
		const feed = makeFeed()
		const { built } = publish(h, feed, { commandLine: '51.3.0' })
		let sent = 0
		feed.serve.set(built.file, () => ({
			body: (async function* () {
				for (;;) {
					sent += 9000
					yield Buffer.alloc(9000, 1)
				}
			})(),
		}))
		failed(await runCheck(deps(h, feed)), 'download')
		expect(sent).toBeLessThanOrEqual(built.gz.length + 2 * 9000)
		expect(await tmpIsEmpty(h)).toBe(true)
	})

	it('refuses a download of the right size with the wrong bytes', async () => {
		const h = await harness()
		const feed = makeFeed()
		const { built } = publish(h, feed, { commandLine: '51.3.0' })
		const wrong = Buffer.from(built.gz)
		wrong[wrong.length - 20] = (wrong[wrong.length - 20] as number) ^ 0xff
		feed.serve.set(built.file, () => ({ body: chunks(wrong) }))
		failed(await runCheck(deps(h, feed)), 'download')
		expect(stateOf(h).pending).toBeUndefined()
	})

	it('a newer engine that could not be fetched never reads as up to date, and is not fetched at every check', async () => {
		const h = await harness()
		const feed = makeFeed()
		const { built } = publish(h, feed, { commandLine: '51.3.0' })
		const wrong = Buffer.from(built.gz)
		wrong[wrong.length - 20] = (wrong[wrong.length - 20] as number) ^ 0xff
		feed.serve.set(built.file, () => ({ body: chunks(wrong) }))
		const view = () => ({
			available: true,
			enabled: true,
			override: false,
			state: stateOf(h),
			running: { source: 'bundled' as const },
			bundled: {},
			checking: false,
			now: h.clock.now(),
		})
		failed(await runCheck(deps(h, feed)), 'download')
		// No fresh, successful answer was recorded, and the screen says it could not check.
		expect(stateOf(h).lastFreshCheckAt).toBeUndefined()
		expect(engineStatus(view()).kind).toBe('cannot-check')
		// Four hours later: the manifest is asked again, the archive is not.
		const archiveRequests = () => feed.requests.filter((url) => url.endsWith('.tar.gz')).length
		expect(archiveRequests()).toBe(1)
		const at = stateOf(h).lastCheck?.at
		h.clock.value += 4 * 60 * 60 * 1000
		failed(await runCheck(deps(h, feed)), 'download')
		expect(archiveRequests()).toBe(1)
		expect(stateOf(h).lastCheck?.at).toBe(at)
		expect(engineStatus(view()).kind).toBe('cannot-check')
		// After the wait, and after a restart, it tries again.
		h.clock.value += RETRY_AFTER_MS
		failed(await runCheck(deps(h, feed)), 'download')
		expect(archiveRequests()).toBe(2)
		const again = await h.restart()
		failed(await runCheck({ ...deps(h, feed), manager: again.manager }), 'download')
		expect(archiveRequests()).toBe(3)
	})

	it('refuses an answer that is not 200, a redirect to a place that is not allowed, and a plain http address', async () => {
		const h = await harness()
		const feed = makeFeed()
		failed(await runCheck(deps(h, feed)), 'fetch')
		publish(h, feed, { commandLine: '51.3.0' })
		feed.serve.set('kernel-latest.json', () => ({
			body: chunks(Buffer.from('x')),
			url: 'http://evil.example/kernel-latest.json',
		}))
		failed(await runCheck(deps(h, feed)), 'fetch')
		feed.serve.delete('kernel-latest.json')
		failed(await runCheck(deps(h, feed, { feedBase: 'http://example.com/' })), 'fetch')
		expect(feed.requests.every((url) => !url.startsWith('http://example.com'))).toBe(true)
	})

	it('refuses a manifest larger than a megabyte', async () => {
		const h = await harness()
		const feed = makeFeed()
		feed.serve.set('kernel-latest.json', () => ({
			body: chunks(Buffer.alloc(2 * 1024 * 1024, 32)),
		}))
		const result = await runCheck(deps(h, feed))
		failed(result, 'fetch')
		// It is the size cap that stopped it, not the missing signature that comes after.
		expect(result).toMatchObject({ message: expect.stringMatching(/larger than allowed/u) })
	})

	it('reports a network failure as a failed check and leaves state alone', async () => {
		const h = await harness()
		const result = await runCheck(
			deps(h, makeFeed(), {
				fetch: async () => {
					throw new Error('offline')
				},
			}),
		)
		failed(result, 'fetch')
		expect(stateOf(h).lastFreshCheckAt).toBeUndefined()
		expect(stateOf(h).lastCheck?.problem).toMatch(/offline/u)
	})
})

describe('what is in the archive', () => {
	it('refuses an archive with a link, gives up that version, and never tries it again', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, {
			commandLine: '51.3.0',
			entries: (e) => [...e, { name: 'dist/link.js', type: '2', linkname: 'x' }],
		})
		failed(await runCheck(deps(h, feed)), 'extract')
		expect(stateOf(h).bad['51.3.0']).toBeDefined()
		expect(await tmpIsEmpty(h)).toBe(true)
		feed.requests.length = 0
		expect(await runCheck(deps(h, feed))).toMatchObject({ kind: 'current' })
		expect(feed.requests.some((url) => url.endsWith('.tar.gz'))).toBe(false)
	})

	it('refuses a kernel.json that disagrees with the manifest', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, {
			commandLine: '51.3.0',
			files: kernelFiles('51.3.0', '62.14.0', {
				extra: { 'kernel.json': kernelFactsText({ commandLine: '51.3.0', engine: '62.15.0' }) },
			}),
		})
		failed(await runCheck(deps(h, feed)), 'verify')
		expect(stateOf(h).bad['51.3.0']).toBeDefined()
		expect(await exists(join(h.kernelRoot, 'versions', '51.3.0'))).toBe(false)
	})

	it('refuses a kernel.json built for another platform', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, {
			commandLine: '51.3.0',
			files: kernelFiles('51.3.0', '62.14.0', {
				extra: {
					'kernel.json': kernelFactsText({
						commandLine: '51.3.0',
						engine: '62.14.0',
						platform: 'linux',
					}),
				},
			}),
		})
		failed(await runCheck(deps(h, feed)), 'verify')
	})

	it('refuses a kernel folder without kernel.json', async () => {
		const h = await harness()
		const feed = makeFeed()
		const files = Object.fromEntries(
			Object.entries(kernelFiles('51.3.0', '62.14.0')).filter(([name]) => name !== 'kernel.json'),
		)
		publish(h, feed, { commandLine: '51.3.0', files })
		failed(await runCheck(deps(h, feed)), 'verify')
		expect(stateOf(h).pending).toBeUndefined()
	})
})

describe('the self-check', () => {
	it('gives up an engine that fails it and removes its folder', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		const result = await runCheck(
			deps(h, feed, { selfCheck: async () => 'initialize lacks a method' }),
		)
		failed(result, 'self-check')
		expect(stateOf(h).pending).toBeUndefined()
		expect(stateOf(h).bad['51.3.0']?.reason).toMatch(/initialize lacks/u)
		expect(await readdir(join(h.kernelRoot, 'versions'))).toEqual([])
	})

	it('treats a self-check that throws as a failure', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		failed(
			await runCheck(
				deps(h, feed, {
					selfCheck: async () => {
						throw new Error('timed out')
					},
				}),
			),
			'self-check',
		)
	})

	it('is given the folder, the entry and what the manifest promised', async () => {
		const h = await harness()
		const feed = makeFeed()
		publish(h, feed, { commandLine: '51.3.0' })
		let seen: unknown
		await runCheck(
			deps(h, feed, {
				selfCheck: async (args) => {
					seen = args
					return undefined
				},
			}),
		)
		expect(seen).toEqual({
			folder: join(h.kernelRoot, 'versions', '51.3.0'),
			entry: join(h.kernelRoot, 'versions', '51.3.0', 'dist', 'bin.js'),
			expected: { commandLine: '51.3.0', engine: '62.14.0', desktopContract: 1, dataEpoch: 1 },
		})
	})
})

describe('errors on disk', () => {
	it('leave current untouched, clean tmp, and the next check succeeds', async () => {
		const h0 = await harness()
		const feed = makeFeed()
		publish(h0, feed, { commandLine: '51.3.0', sequence: 1 })
		await runCheck(deps(h0, feed))
		await h0.manager.resolve()
		publish(h0, feed, { commandLine: '51.4.0', sequence: 2 })
		const probe = faultyFs(nodeFs)
		const { manager } = await h0.restart(probe.fs)
		await runCheck({ ...deps(h0, feed), manager })
		const total = probe.ops.length
		expect(total).toBeGreaterThan(5)
		for (let at = 1; at <= total; at += 3) {
			const h = await harness()
			try {
				const feed2 = makeFeed()
				publish(h, feed2, { commandLine: '51.3.0', sequence: 1 })
				await runCheck(deps(h, feed2))
				await h.manager.resolve()
				publish(h, feed2, { commandLine: '51.4.0', sequence: 2 })
				const faulty = faultyFs(nodeFs, { at, mode: 'once' })
				const next = await h.restart(faulty.fs)
				const result = await runCheck({ ...deps(h, feed2), manager: next.manager })
				expect(result.kind === 'ready' || result.kind === 'failed', `op ${at}`).toBe(true)
				const state = next.store.snapshot()
				expect(state.current, `current after failing op ${at}`).toBe('51.3.0')
				const again = await h.restart()
				expect(await runCheck({ ...deps(h, feed2), manager: again.manager })).toMatchObject({
					kind: 'ready',
					version: '51.4.0',
				})
				expect(await tmpIsEmpty(h)).toBe(true)
			} finally {
				// Every check above is awaited, so nothing is still writing here. Removing the
				// folder at the end of its own iteration also keeps a failing iteration from
				// leaving its folder for the shared afterEach to remove mid-write.
				await h.dispose()
			}
		}
		// The whole body is real filesystem I/O (unpack and install) repeated for every third
		// operation of an update, so it takes the time that I/O takes, not vitest's default 5 s.
		// Measured: about 1.8 s alone (1.73 to 1.81 s over five runs), 2.2 s inside the whole
		// Desktop suite, and 4.6 s inside the suite on a loaded machine, which is next to the
		// default limit. 60 s is over 13 times the slowest of those, so a slow runner cannot trip
		// it and only a real hang does.
	}, 60_000)
})
