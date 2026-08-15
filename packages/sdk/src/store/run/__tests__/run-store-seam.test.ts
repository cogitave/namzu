import { describe, expect, it, vi } from 'vitest'

import { RunPersistence } from '../../../manager/run/persistence.js'
import type { RunEvent } from '../../../types/run/events.js'
import { InMemoryRunStore } from '../memory.js'

/**
 * The seam is only a seam if a host reaches it. Every other test here builds
 * a store and calls it directly; a host does not — the kernel builds one
 * inside `RunPersistence` out of a directory path, and until this change
 * there was no way to say otherwise.
 *
 * So these are reachability tests, not behaviour tests. They assert the hop.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

function persistence(runStore?: InMemoryRunStore) {
	return new RunPersistence({
		runId: 'run_seam',
		agentId: 'a',
		agentName: 'A',
		runConfig: {},
		providerId: 'mock',
		// Deliberately a path that does not exist and must never be created.
		outputDir: '/namzu-nonexistent-should-never-be-written',
		log: LOG,
		sessionId: 'ses_seam',
		topicId: 'top_seam',
		projectId: 'prj_seam',
		tenantId: 'tnt_seam',
		...(runStore ? { runStore } : {}),
		// biome-ignore lint/suspicious/noExplicitAny: branded id types are not
		// what this test is about; the wiring is.
	} as any)
}

describe('the run store a host injects', () => {
	it('is the one the kernel writes the run record through', async () => {
		const store = new InMemoryRunStore()
		const mgr = persistence(store)

		// `init` is where the default disk store would have created a run
		// directory under `outputDir`. Nothing should touch that path.
		await mgr.init()

		expect(store.boundTo).toEqual({ runId: 'run_seam' })
		expect(store.snapshot().meta?.id).toBe('run_seam')
	})

	it('is the one run events are appended to', async () => {
		const store = new InMemoryRunStore()
		const mgr = persistence(store)
		await mgr.init()

		// The durable event path reaches the store through
		// `RunPersistence.getRunStore()`, so extracting the interface routes
		// event emission with no change at the emitter — but "routes" is a
		// claim, and this is the test of it.
		await mgr.getRunStore().appendEvent({ type: 'run_started', runId: mgr.id } as RunEvent)

		const events = store.snapshot().events
		expect(events).toHaveLength(1)
		expect((events[0] as { type: string }).type).toBe('run_started')
	})

	it('answers the tool read-back a resumed run depends on', async () => {
		const store = new InMemoryRunStore()
		const mgr = persistence(store)
		await mgr.init()

		await mgr.getRunStore().appendEvent({
			type: 'tool_completed',
			runId: mgr.id,
			toolUseId: 'call_1',
			toolName: 'deploy',
			result: 'ok',
			isError: false,
		} as unknown as RunEvent)

		// A resumed run reads this to avoid executing a call twice. A backend
		// that recorded events but could not answer this would re-send the
		// email rather than lose a file write.
		const completed = await mgr.getRunStore().readCompletedTools()
		expect(completed.get('call_1')?.result).toBe('ok')
	})

	it('reports no location rather than inventing one', async () => {
		const store = new InMemoryRunStore()
		const mgr = persistence(store)
		await mgr.init()

		// A synthesized path would put a directory that does not exist in
		// front of an operator, and the emergency-save and tool-output paths
		// both render this.
		expect(mgr.getRunDir()).toBeNull()
	})

	it('settles a run through a backend that declines the optional index', async () => {
		const store = new InMemoryRunStore()
		const mgr = persistence(store)
		await mgr.init()
		mgr.markCompleted()

		// `addToIndex` maintains a browsable catalogue for a human reading a
		// directory, and a backend with no directory declines it. Calling it
		// unconditionally would throw on settle — the run would complete and
		// then fail while recording that it had, which is the worst moment to
		// fail. Optional on the contract only helps if the caller honours it.
		await expect(mgr.persist()).resolves.not.toThrow()
		expect(store.snapshot().meta?.status).toBe('completed')
	})

	// KNOWN GAP, stated rather than left to be discovered.
	//
	// Every test here enters at `RunPersistence`. A host enters one layer
	// higher, at `query({ runStore })`, which reaches `RunPersistence` through
	// `RunContextFactory`. Deleting the forwarding line in
	// `runtime/query/context.ts` — `runStore: config.runStore` — kills NOTHING
	// in this file, so that hop is unproven and a host could find the
	// parameter accepted and ignored.
	//
	// It is not covered here because `RunContextFactory.build` needs a fuller
	// config than this file has any business assembling — a provider, a
	// registry, a resolved output directory. The right home is beside the
	// existing `runtime/query/__tests__/context.test.ts`, which already builds
	// one. Left open deliberately: an unproven hop that is written down is a
	// task, and one that is not is a bug nobody knows about.

	it('still defaults to disk when nothing is injected', async () => {
		// The compatibility promise: adding the seam changes nothing for a
		// host that never asked for it.
		const mgr = persistence()
		expect(typeof mgr.getRunStore().writeRunMeta).toBe('function')
		expect(mgr.getRunStore()).not.toBeInstanceOf(InMemoryRunStore)
	})
})
