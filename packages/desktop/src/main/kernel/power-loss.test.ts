import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type CheckDeps, runCheck } from './check.js'
import { nodeFs } from './fs.js'
import {
	FEED,
	type FakeFeed,
	type Harness,
	buildArchive,
	faultyFs,
	kernelFiles,
	makeFeed,
	makeHarness,
	manifestObject,
	signPair,
} from './kernel-test-support.js'
import type { ResolvedKernel } from './manager.js'
import { KernelStore, versionOfEntry } from './store.js'

/**
 * A power cut between any two file operations of an install, a promotion or a going back must
 * leave a next start that works: a managed engine that passes its check, or the bundled one,
 * and a versions folder that holds nothing no slot names.
 */

const open: Harness[] = []
afterEach(async () => {
	await Promise.all(open.splice(0).map((h) => h.dispose()))
})

function publish(h: Harness, feed: FakeFeed, commandLine: string, sequence: number) {
	const built = buildArchive(commandLine, kernelFiles(commandLine, '62.14.0'))
	const pair = signPair(
		manifestObject({
			commandLine,
			engine: '62.14.0',
			sequence,
			bundles: { 'win32-x64': built.bundle },
		}),
		h.key,
	)
	feed.files.set('kernel-latest.json', pair.manifest)
	feed.files.set('kernel-latest.json.sig', pair.signature)
	feed.files.set(built.file, built.gz)
}

function depsFor(h: Harness, feed: FakeFeed, manager: Harness['manager']): CheckDeps {
	return {
		manager,
		feedBase: FEED,
		channel: 'latest',
		fetch: feed.fetch,
		now: h.clock.now,
		selfCheck: async () => undefined,
	}
}

/** A harness with `51.2.0` previous and `51.3.0` current, and the feed one release ahead. */
async function world() {
	const h = await makeHarness()
	open.push(h)
	const feed = makeFeed()
	for (const [version, sequence] of [
		['51.2.0', 1],
		['51.3.0', 2],
	] as const) {
		publish(h, feed, version, sequence)
		await runCheck(depsFor(h, feed, h.manager))
		await h.manager.resolve()
	}
	publish(h, feed, '51.4.0', 3)
	return { h, feed }
}

async function exists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined)) !== undefined
}

/** The next start: nothing but the disk survives. */
async function nextStart(h: Harness): Promise<{ resolved: ResolvedKernel; kept: Set<string> }> {
	const next = await h.restart()
	await next.manager.cleanup()
	const resolved = await next.manager.resolve()
	const state = next.store.snapshot()
	const kept = KernelStore.kept(state)
	// Every version a slot names is whole.
	for (const version of kept) {
		expect(
			await exists(join(h.kernelRoot, 'versions', version, 'dist', 'bin.js')),
			`${version} folder`,
		).toBe(true)
		expect(
			await exists(join(h.kernelRoot, 'versions', `${version}.manifest.json`)),
			`${version} manifest`,
		).toBe(true)
		expect(
			await exists(join(h.kernelRoot, 'versions', `${version}.manifest.json.sig`)),
			`${version} signature`,
		).toBe(true)
	}
	// Nothing else is left.
	for (const name of await readdir(join(h.kernelRoot, 'versions'))) {
		const version = versionOfEntry(name)
		expect(version !== undefined && kept.has(version), `leftover ${name}`).toBe(true)
	}
	expect(await readdir(join(h.kernelRoot, 'tmp'))).toEqual([])
	// What runs is whole, and asking twice gives the same answer.
	if (resolved.source === 'managed') {
		expect(await exists(resolved.entry)).toBe(true)
		expect(kept.has(resolved.version as string)).toBe(true)
	} else expect(resolved.source).toBe('bundled')
	const { wentBack: _first, ...again } = await next.manager.resolve()
	const { wentBack: _second, ...first } = resolved
	expect(again).toEqual(first)
	return { resolved, kept }
}

describe('a power cut during an install', () => {
	it('leaves a working next start whichever operation it lands on, and the next check finishes the job', async () => {
		const { h, feed } = await world()
		const probe = faultyFs(nodeFs)
		const counting = await h.restart(probe.fs)
		await runCheck(depsFor(h, feed, counting.manager))
		const total = probe.ops.length
		expect(total).toBeGreaterThan(10)
		for (let at = 1; at <= total; at++) {
			const w = await world()
			const crash = faultyFs(nodeFs, { at, mode: 'crash' })
			const doomed = await w.h.restart(crash.fs)
			await runCheck(depsFor(w.h, w.feed, doomed.manager))
			expect(crash.fired(), `op ${at} ran`).toBe(true)
			const { resolved } = await nextStart(w.h)
			// The engine that was current is still what runs, or the new one is whole and runs.
			expect(resolved).toMatchObject({ source: 'managed' })
			expect(['51.3.0', '51.4.0']).toContain(resolved.version)
			const again = await w.h.restart()
			const result = await runCheck(depsFor(w.h, w.feed, again.manager))
			// Either the new engine is made ready now, or the crash came after it was, and the
			// first start above already promoted it.
			const stateNow = again.store.snapshot()
			if (result.kind === 'ready') expect(result.version, `op ${at}`).toBe('51.4.0')
			else expect([result.kind, stateNow.current], `op ${at}`).toEqual(['current', '51.4.0'])
			expect((await nextStart(w.h)).resolved.version).toBe('51.4.0')
		}
	}, 120_000)
})

describe('a power cut during a promotion', () => {
	it('leaves a working next start whichever operation it lands on', async () => {
		const { h, feed } = await world()
		await runCheck(depsFor(h, feed, h.manager))
		expect(h.store.snapshot().pending).toBe('51.4.0')
		const probe = faultyFs(nodeFs)
		const counting = await h.restart(probe.fs)
		await counting.manager.resolve()
		const total = probe.ops.length
		expect(total).toBeGreaterThan(2)
		for (let at = 1; at <= total; at++) {
			const w = await world()
			await runCheck(depsFor(w.h, w.feed, w.h.manager))
			const crash = faultyFs(nodeFs, { at, mode: 'crash' })
			const doomed = await w.h.restart(crash.fs)
			await doomed.manager.resolve()
			expect(crash.fired(), `op ${at} ran`).toBe(true)
			const { resolved } = await nextStart(w.h)
			expect(resolved).toMatchObject({ source: 'managed' })
			expect(['51.3.0', '51.4.0']).toContain(resolved.version)
			// Whichever it is, the next spawn ends with the new engine current and one before it.
			const state = (await w.h.restart()).store.snapshot()
			expect(state.pending === undefined || state.pending === '51.4.0').toBe(true)
		}
	}, 120_000)
})

describe('a power cut while going back', () => {
	it('leaves a working next start whichever operation it lands on', async () => {
		const { h } = await world()
		await writeFile(join(h.kernelRoot, 'versions', '51.3.0', 'dist', 'bin.js'), '// tampered\n')
		const probe = faultyFs(nodeFs)
		const counting = await h.restart(probe.fs)
		expect(await counting.manager.resolve()).toMatchObject({ version: '51.2.0' })
		const total = probe.ops.length
		expect(total).toBeGreaterThan(2)
		for (let at = 1; at <= total; at++) {
			const w = await world()
			await writeFile(join(w.h.kernelRoot, 'versions', '51.3.0', 'dist', 'bin.js'), '// tampered\n')
			const crash = faultyFs(nodeFs, { at, mode: 'crash' })
			const doomed = await w.h.restart(crash.fs)
			await doomed.manager.resolve()
			expect(crash.fired(), `op ${at} ran`).toBe(true)
			const { resolved } = await nextStart(w.h)
			// The tampered one never runs; the one before does.
			expect(resolved).toMatchObject({ source: 'managed', version: '51.2.0' })
		}
	}, 120_000)
})

describe('a failed state write', () => {
	it('never loses current: each rename of the state file that fails leaves the old state whole', async () => {
		const { h, feed } = await world()
		const before = (await nodeFs.readFile(h.store.paths.state)).toString()
		const failing = {
			...nodeFs,
			rename: async (from: string, to: string) => {
				if (to.endsWith('state.json')) throw new Error('disk full')
				await nodeFs.rename(from, to)
			},
		}
		const next = await h.restart(failing)
		await runCheck(depsFor(h, feed, next.manager))
		expect(await next.manager.resolve()).toMatchObject({ source: 'managed', version: '51.3.0' })
		expect((await nodeFs.readFile(h.store.paths.state)).toString()).toBe(before)
		expect((await nextStart(h)).resolved.version).toBe('51.3.0')
	})
})
