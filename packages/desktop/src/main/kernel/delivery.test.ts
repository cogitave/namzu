import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineDeliveryView } from '../../shared/engine-delivery-protocol.js'
import { REQUIRED_EXTENSIONS } from '../required-extensions.js'
import { RuntimeClient } from '../rpc-client.js'
import { type DeliveryClock, EngineDelivery } from './delivery.js'
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

const open: Harness[] = []
const clients: RuntimeClient[] = []
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()))
	await Promise.all(open.splice(0).map((h) => h.dispose()))
})

async function harness(options: Parameters<typeof makeHarness>[0] = {}) {
	const h = await makeHarness(options)
	open.push(h)
	return h
}

/** A program that answers like an engine host, as far as `mode` says. */
function stub(version: string, mode: 'ok' | 'exit' | 'no-extensions' | 'dies-after-start'): string {
	return `
const MODE = ${JSON.stringify(mode)}
if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }
if (MODE === 'exit') process.exit(3)
let buffer = ''
process.stdin.on('data', (chunk) => {
	buffer += chunk
	for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
		const message = JSON.parse(buffer.slice(0, at))
		buffer = buffer.slice(at + 1)
		if (message.method !== 'initialize') continue
		const extensions = MODE === 'no-extensions' ? [] : ${JSON.stringify([...REQUIRED_EXTENSIONS])}
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { agentInfo: { name: 'namzu' }, extensions } }) + '\\n')
		if (MODE === 'dies-after-start') setImmediate(() => process.exit(7))
	}
})
process.stdin.on('end', () => process.exit(0))
`
}

function release(
	h: Harness,
	feed: FakeFeed,
	version: string,
	options: {
		mode?: Parameters<typeof stub>[1]
		desktopContract?: number
		issuedAt?: string
		expiresAt?: string
	} = {},
) {
	const files = kernelFiles(version, '62.14.0', {
		...(options.desktopContract ? { desktopContract: options.desktopContract } : {}),
		extra: { 'dist/bin.js': stub(version, options.mode ?? 'ok') },
	})
	const built = buildArchive(version, files)
	const pair = signPair(
		manifestObject({
			commandLine: version,
			engine: '62.14.0',
			bundles: { 'win32-x64': built.bundle },
			...(options.desktopContract ? { desktopContract: options.desktopContract } : {}),
			...(options.issuedAt ? { issuedAt: options.issuedAt } : {}),
			...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
		}),
		h.key,
	)
	feed.files.set('kernel-latest.json', pair.manifest)
	feed.files.set('kernel-latest.json.sig', pair.signature)
	feed.files.set(built.file, built.gz)
}

/** Timers the test fires by hand. */
function manualClock(h: Harness) {
	const afters: { ms: number; run: () => void; live: boolean }[] = []
	const everys: { ms: number; run: () => void; live: boolean }[] = []
	const clock: DeliveryClock = {
		now: h.clock.now,
		after: (ms, run) => {
			const timer = { ms, run, live: true }
			afters.push(timer)
			return () => {
				timer.live = false
			}
		},
		every: (ms, run) => {
			const timer = { ms, run, live: true }
			everys.push(timer)
			return () => {
				timer.live = false
			}
		},
	}
	return { clock, afters, everys }
}

async function bundledStub(h: Harness, mode: Parameters<typeof stub>[1] = 'ok') {
	await mkdir(join(h.root, 'bundled', 'dist'), { recursive: true })
	await writeFile(join(h.root, 'bundled', 'dist', 'bin.js'), stub('51.1.0', mode))
}

function delivery(
	h: Harness,
	feed: FakeFeed,
	extra: Partial<ConstructorParameters<typeof EngineDelivery>[0]> = {},
) {
	const timers = manualClock(h)
	const views: EngineDeliveryView[] = []
	const engine = new EngineDelivery({
		manager: h.manager,
		ready: Promise.resolve(),
		channel: 'latest',
		feedBase: FEED,
		fetch: feed.fetch,
		selfCheck: async () => undefined,
		clock: timers.clock,
		bundledVersions: () => ({ commandLine: '51.1.0', engine: '62.13.0' }),
		versionsOf: () => ({}),
		spec: (entry) => ({ program: process.execPath, args: [entry, 'acp', '--desktop'] }),
		publish: (view) => views.push(view),
		log: () => undefined,
		...extra,
	})
	return { engine, views, ...timers }
}

describe('when the app checks', () => {
	it('first 30 seconds after launch, then every 4 hours, one at a time', async () => {
		const h = await harness()
		const feed = makeFeed()
		release(h, feed, '51.1.0')
		const d = delivery(h, feed)
		d.engine.start()
		expect(d.afters.map((timer) => timer.ms)).toEqual([30_000])
		expect(d.everys.map((timer) => timer.ms)).toEqual([4 * 60 * 60_000])
		// Nothing is asked before the first timer fires.
		expect(feed.requests).toEqual([])
		d.afters[0]?.run()
		await d.engine.check()
		expect(feed.requests.map((url) => url.slice(FEED.length))).toEqual([
			'kernel-latest.json',
			'kernel-latest.json.sig',
		])
		d.everys[0]?.run()
		await d.engine.check()
		expect(feed.requests).toHaveLength(4)
	})

	it('runs a second call while one is running as that same check', async () => {
		const h = await harness()
		const feed = makeFeed()
		release(h, feed, '51.1.0')
		let release1: () => void = () => undefined
		const held = new Promise<void>((resolve) => {
			release1 = resolve
		})
		const slow = async (...args: Parameters<FakeFeed['fetch']>) => {
			await held
			return feed.fetch(...args)
		}
		const d = delivery(h, feed, { fetch: slow })
		const first = d.engine.check()
		const second = d.engine.check()
		expect(second).toBe(first)
		release1()
		await first
		expect(feed.requests).toHaveLength(2)
	})

	it('starts its timers once however often it is started', async () => {
		const h = await harness()
		const d = delivery(h, makeFeed())
		d.engine.start()
		d.engine.start()
		expect(d.afters).toHaveLength(1)
		expect(d.everys).toHaveLength(1)
		d.engine.stop()
		expect(d.afters[0]?.live).toBe(false)
		expect(d.everys[0]?.live).toBe(false)
	})

	it('makes no request at all with the setting off, with an override, or with no key', async () => {
		for (const options of [
			{ enabled: false },
			{ override: '/dev/engine/dist/bin.js' },
			{ keys: [] },
		] as Parameters<typeof makeHarness>[0][]) {
			const h = await harness(options)
			const feed = makeFeed()
			release(h, feed, '52.0.0')
			const d = delivery(h, feed)
			d.engine.start()
			d.afters[0]?.run()
			d.everys[0]?.run()
			const result = await d.engine.check()
			expect(result.kind).toBe('skipped')
			expect(feed.requests).toEqual([])
		}
	})

	it('looks soon after the setting is turned on, and says so on screen when it is off', async () => {
		const h = await harness({ enabled: false })
		const feed = makeFeed()
		release(h, feed, '52.0.0')
		const d = delivery(h, feed)
		expect(d.engine.view().status).toEqual({ kind: 'off' })
		d.engine.settingChanged()
		expect(d.afters).toHaveLength(0)
		h.flags.enabled = true
		d.engine.settingChanged()
		expect(d.afters.map((timer) => timer.ms)).toEqual([0])
		d.afters[0]?.run()
		await d.engine.check()
		expect(feed.requests.length).toBeGreaterThan(0)
	})
})

describe('what the screen is told', () => {
	it('walks from not checked, to checking, to up to date, to ready', async () => {
		const h = await harness()
		const feed = makeFeed()
		release(h, feed, '51.1.0')
		const d = delivery(h, feed)
		expect(d.engine.view()).toMatchObject({
			available: true,
			enabled: true,
			runs: { source: 'bundled', commandLine: '51.1.0', engine: '62.13.0' },
			status: { kind: 'unknown' },
			canUseOwn: false,
		})
		await d.engine.check()
		// The first push is the folder having been read.
		expect(d.views.map((view) => view.status.kind)).toEqual(['unknown', 'checking', 'current'])
		expect(d.engine.view().status).toEqual({ kind: 'current', checkedAt: h.clock.now() })
		release(h, feed, '52.0.0', { issuedAt: '2026-11-12T11:00:00Z' })
		await d.engine.check()
		expect(d.engine.view().status).toEqual({ kind: 'ready', version: '52.0.0' })
		expect(d.engine.view().canUseOwn).toBe(true)
		// Ready is not running: the engine in use does not change until a host starts.
		expect(d.engine.view().runs.source).toBe('bundled')
	})

	it('says a newer engine needs a newer app', async () => {
		const h = await harness()
		const feed = makeFeed()
		release(h, feed, '52.0.0', { desktopContract: 2 })
		const d = delivery(h, feed)
		await d.engine.check()
		expect(d.engine.view().status).toEqual({ kind: 'needs-newer-app' })
	})

	it('says the check has not worked once three days have passed since a fresh answer', async () => {
		const h = await harness()
		const feed = makeFeed()
		release(h, feed, '51.1.0')
		const d = delivery(h, feed)
		await d.engine.check()
		const at = h.clock.now()
		h.clock.value += 3 * 24 * 60 * 60 * 1000
		expect(d.engine.view().status).toEqual({ kind: 'current', checkedAt: at })
		h.clock.value += 1000
		expect(d.engine.view().status).toEqual({ kind: 'cannot-check', since: at })
	})

	it('names a developer override', async () => {
		const h = await harness({ override: '/dev/engine/dist/bin.js' })
		const d = delivery(h, makeFeed(), {
			versionsOf: () => ({ commandLine: '99.0.0', engine: '98.0.0' }),
		})
		expect(d.engine.view()).toMatchObject({
			runs: { source: 'override', commandLine: '99.0.0', engine: '98.0.0' },
			status: { kind: 'override' },
		})
	})

	it('shows nothing from the feed except checked version numbers', async () => {
		const h = await harness()
		const feed = makeFeed()
		release(h, feed, '52.0.0')
		const d = delivery(h, feed)
		await d.engine.check()
		const text = JSON.stringify(d.engine.view())
		expect(text).not.toContain('kernel-latest')
		expect(text).not.toContain(FEED)
	})
})

describe('starting a host on the chosen engine', () => {
	async function ready(version: string, mode: Parameters<typeof stub>[1]) {
		const h = await harness()
		await bundledStub(h)
		const feed = makeFeed()
		release(h, feed, version, { mode })
		const d = delivery(h, feed)
		expect((await d.engine.check()).kind).toBe('ready')
		return { h, feed, d }
	}
	function client(d: ReturnType<typeof delivery>, h: Harness) {
		const runtime = new RuntimeClient(h.root, {
			program: 'unused',
			args: [],
			launcher: d.engine.launcher(),
		})
		clients.push(runtime)
		const closed: Error[] = []
		runtime.on('closed', (error: Error) => closed.push(error))
		return { runtime, closed }
	}
	/** Every end-of-host report the manager received, so a test can wait for the real work. */
	function watchExits(h: Harness) {
		const reports: Promise<boolean>[] = []
		const original = h.manager.hostExited.bind(h.manager)
		vi.spyOn(h.manager, 'hostExited').mockImplementation((token, options) => {
			const report = original(token, options)
			reports.push(report)
			return report
		})
		return () => Promise.all(reports)
	}

	it('runs a newer engine from the next start on, and says which one runs', async () => {
		const { h, d } = await ready('52.0.0', 'ok')
		const { runtime, closed } = client(d, h)
		await runtime.start()
		expect(d.engine.view().runs).toMatchObject({
			source: 'managed',
			commandLine: '52.0.0',
			engine: '62.14.0',
		})
		expect(d.engine.view().bundled).toEqual({ commandLine: '51.1.0', engine: '62.13.0' })
		expect(h.manager.inUse().has('52.0.0')).toBe(true)
		const exits = watchExits(h)
		expect(closed).toHaveLength(0)
		await runtime.close()
		expect(await exits()).toEqual([false])
		expect(h.manager.inUse().has('52.0.0')).toBe(false)
	})

	it('never swaps a host that is running', async () => {
		const h = await harness()
		await bundledStub(h)
		const feed = makeFeed()
		const d = delivery(h, feed)
		const { runtime } = client(d, h)
		await runtime.start()
		release(h, feed, '52.0.0', { mode: 'ok' })
		await d.engine.check()
		expect(d.engine.view().status.kind).toBe('ready')
		expect(d.engine.view().runs.source).toBe('bundled')
		const next = client(d, h)
		await next.runtime.start()
		expect(d.engine.view().runs.source).toBe('managed')
	})

	it('gives up an engine that fails to start, ends on the bundled one, and never tries it again', async () => {
		const { h, d } = await ready('52.0.0', 'exit')
		const first = client(d, h)
		await first.runtime.start()
		expect(first.closed).toEqual([])
		expect(d.engine.view().runs.source).toBe('bundled')
		expect(h.store.snapshot().bad['52.0.0']?.reason).toMatch(/^host failed/)
		expect(d.engine.view().status).toMatchObject({
			kind: 'went-back',
			version: '52.0.0',
			problem: 'did-not-start',
			to: '51.1.0',
		})
		const second = client(d, h)
		await second.runtime.start()
		expect(h.logs.filter((entry) => entry.event === 'marked-bad')).toHaveLength(1)
	})

	it('gives up an engine that lacks a required method', async () => {
		const { h, d } = await ready('52.0.0', 'no-extensions')
		const { runtime, closed } = client(d, h)
		await runtime.start()
		expect(closed).toEqual([])
		expect(d.engine.view().runs.source).toBe('bundled')
		expect(h.store.snapshot().bad['52.0.0']).toBeDefined()
	})

	it('goes back to the engine before it when the newest fails, and to the bundled one when that fails too', async () => {
		const h = await harness()
		await bundledStub(h)
		const feed = makeFeed()
		const d = delivery(h, feed)
		release(h, feed, '52.0.0', { mode: 'ok', issuedAt: '2026-11-12T11:00:00Z' })
		await d.engine.check()
		const one = client(d, h)
		await one.runtime.start()
		await one.runtime.close()
		release(h, feed, '53.0.0', { mode: 'exit', issuedAt: '2026-11-12T11:30:00Z' })
		await d.engine.check()
		const two = client(d, h)
		await two.runtime.start()
		// 53 was promoted, failed, and 52 (the one before) took over in the same open.
		expect(d.engine.view().runs).toMatchObject({ source: 'managed', commandLine: '52.0.0' })
		expect(h.store.snapshot().bad['53.0.0']).toBeDefined()
		expect(two.closed).toEqual([])
	})

	it('counts a host that dies right after it starts, and gives the engine up after two', async () => {
		const { h, d } = await ready('52.0.0', 'dies-after-start')
		const exits = watchExits(h)
		for (let run = 0; run < 2; run++) {
			const { runtime, closed } = client(d, h)
			await runtime.start()
			await vi.waitFor(() => expect(closed).toHaveLength(1))
			expect(d.engine.view().runs.source).toBe('managed')
		}
		expect(await exits()).toEqual([false, true])
		expect(h.store.snapshot().bad['52.0.0']?.reason).toBe('it ended early twice')
		expect(d.engine.view().status).toMatchObject({ kind: 'went-back', problem: 'ended-early' })
		const after = client(d, h)
		await after.runtime.start()
		expect(d.engine.view().runs.source).toBe('bundled')
	})

	it('hands the failure on when the bundled engine itself does not start', async () => {
		const h = await harness()
		await bundledStub(h, 'exit')
		const d = delivery(h, makeFeed())
		const { runtime, closed } = client(d, h)
		await expect(runtime.start()).rejects.toThrow()
		expect(closed).toHaveLength(1)
		expect(h.store.snapshot().bad).toEqual({})
	})

	it('uses this app’s own engine from the next start after the person chooses it', async () => {
		const { h, d } = await ready('52.0.0', 'ok')
		await d.engine.useOwnEngine()
		expect(d.engine.view().canUseOwn).toBe(false)
		const { runtime } = client(d, h)
		await runtime.start()
		expect(d.engine.view().runs.source).toBe('bundled')
		// Not a failure: the screen does not say it could not use the engine.
		expect(d.engine.view().status.kind).not.toBe('went-back')
	})
})

describe('a terminal tab or a short command', () => {
	it('runs on the engine chosen now and keeps its folder until it is over', async () => {
		const h = await harness()
		await bundledStub(h)
		const feed = makeFeed()
		release(h, feed, '52.0.0')
		const d = delivery(h, feed)
		await d.engine.check()
		const lease = await d.engine.lease()
		expect(lease.entry).toBe(join(h.kernelRoot, 'versions', '52.0.0', 'dist', 'bin.js'))
		expect(h.manager.inUse().has('52.0.0')).toBe(true)
		lease.release()
		lease.release()
		expect(h.manager.inUse().has('52.0.0')).toBe(false)
	})

	it('runs on the bundled engine when nothing is managed', async () => {
		const h = await harness()
		const d = delivery(h, makeFeed())
		expect((await d.engine.lease()).entry).toBe(join(h.root, 'bundled', 'dist', 'bin.js'))
	})
})

it('waits for the engine folder to be read before it does anything', async () => {
	const h = await harness()
	let open: () => void = () => undefined
	const ready = new Promise<void>((resolve) => {
		open = resolve
	})
	const feed = makeFeed()
	release(h, feed, '51.1.0')
	const d = delivery(h, feed, { ready })
	const check = d.engine.check()
	const lease = d.engine.lease()
	await Promise.resolve()
	expect(feed.requests).toEqual([])
	open()
	await check
	await lease
	expect(feed.requests).toHaveLength(2)
	// The folder was read, so the screen is told once it is.
	expect(d.views.length).toBeGreaterThan(0)
})
