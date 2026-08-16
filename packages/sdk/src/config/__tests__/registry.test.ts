import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { DiskConfigOverrideStore, InMemoryConfigOverrideStore } from '../../store/config/index.js'
import { ConfigNamespaceCollisionError, ConfigRegistry } from '../registry.js'

/**
 * A configuration seam is only worth having if it is LIVE.
 *
 * `config/runtime.ts` is one schema parsed once into a frozen object, and
 * nothing in that directory watches, subscribes or changes. A registry that
 * resolved a value once and handed it out would be the frozen object again
 * with more ceremony — so the tests that matter here are the ones about
 * resolution order, about a bad patch leaving the good value alone, and
 * about a consumer seeing a change it did not restart for.
 */

const Schema = z.object({
	enabled: z.boolean().default(true),
	attempts: z.number().int().positive().default(3),
	label: z.string().default('default'),
})

describe('resolution order', () => {
	it('is defaults, then base, then override', () => {
		const registry = new ConfigRegistry()

		const bare = registry.register('bare', Schema)
		expect(bare.get()).toEqual({ enabled: true, attempts: 3, label: 'default' })

		const based = registry.register('based', Schema, { base: { attempts: 5 } })
		expect(based.get()).toEqual({ enabled: true, attempts: 5, label: 'default' })

		based.update({ attempts: 9 })
		// Three assertions rather than one, so an implementation that applied
		// them backwards — base over override, or defaults over base — fails
		// on the pair it got wrong instead of passing on the one it got right.
		expect(based.get()).toEqual({ enabled: true, attempts: 9, label: 'default' })
	})

	it('puts a PERSISTED override over a base at registration too', () => {
		// The update path and the registration path resolve separately, and a
		// test that only exercised the first left the second free to order them
		// backwards — caught by mutating exactly that line and watching every
		// test pass.
		const store = new InMemoryConfigOverrideStore()
		store.save('reopened', { attempts: 12 })

		const scope = new ConfigRegistry({ store }).register('reopened', Schema, {
			base: { attempts: 5, label: 'from-base' },
		})

		expect(scope.get()).toEqual({ enabled: true, attempts: 12, label: 'from-base' })
	})

	it('accumulates successive patches rather than replacing them', () => {
		const scope = new ConfigRegistry().register('acc', Schema)
		scope.update({ attempts: 7 })
		scope.update({ label: 'tuned' })
		// A second `update` that replaced the override layer would silently
		// revert the first, which reads to an operator as a setting that did
		// not take.
		expect(scope.get()).toEqual({ enabled: true, attempts: 7, label: 'tuned' })
	})
})

describe('an invalid patch', () => {
	it('throws, leaves the previous value, and tells no watcher', () => {
		const scope = new ConfigRegistry().register('bad', Schema, { base: { attempts: 4 } })
		const seen: unknown[] = []
		scope.watch((next) => seen.push(next))

		expect(() => scope.update({ attempts: -1 })).toThrow()

		// Validate then assign, never the reverse. An implementation that
		// assigned first would leave the bad value readable here and would
		// already have told every watcher about it.
		expect(scope.get()).toEqual({ enabled: true, attempts: 4, label: 'default' })
		expect(seen).toEqual([])
	})

	it('refuses rather than clamping', () => {
		// `refuse-do-not-degrade`: a config that accepted `attempts: -1` and
		// silently used 1 would leave an operator believing they had set
		// something they had not.
		const scope = new ConfigRegistry().register('clamp', Schema)
		expect(() => scope.update({ attempts: 0 })).toThrow()
		expect(scope.get().attempts).toBe(3)
	})
})

describe('watch', () => {
	it('fires with (next, previous) and unsubscribes', () => {
		const scope = new ConfigRegistry().register('w', Schema)
		const calls: [number, number][] = []
		const off = scope.watch((next, prev) => calls.push([next.attempts, prev.attempts]))

		scope.update({ attempts: 5 })
		expect(calls).toEqual([[5, 3]])

		off()
		scope.update({ attempts: 6 })
		// The second update proves the unsubscribe: a `watch` that returned a
		// no-op would pass the first assertion on its own.
		expect(calls).toEqual([[5, 3]])
		expect(scope.get().attempts).toBe(6)
	})

	it('survives a watcher that throws', () => {
		const scope = new ConfigRegistry().register('throwing', Schema)
		const after: number[] = []
		scope.watch(() => {
			throw new Error('a host listener blew up')
		})
		scope.watch((next) => after.push(next.attempts))

		expect(() => scope.update({ attempts: 8 })).not.toThrow()
		// The update stands, and the watchers after the throwing one still
		// hear about it — the same trade `MCPClient.emitLifecycle` makes.
		expect(scope.get().attempts).toBe(8)
		expect(after).toEqual([8])
	})
})

describe('namespaces', () => {
	it('refuses a second registration, naming the namespace', () => {
		const registry = new ConfigRegistry()
		registry.register('taken', Schema)

		// Two owners of one namespace means whichever registered second
		// silently decides the schema.
		expect(() => registry.register('taken', Schema)).toThrow(ConfigNamespaceCollisionError)
		expect(() => registry.register('taken', Schema)).toThrow('taken')
	})
})

describe('persistence', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-config-'))
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('an override survives a fresh registry over the same store', () => {
		const path = join(dir, 'overrides.json')
		new ConfigRegistry({ store: new DiskConfigOverrideStore(path) })
			.register('persist', Schema)
			.update({ attempts: 11 })

		// A NEW registry and a NEW store object over the same file — a
		// memory-only registry, or one that cached in the store instance,
		// fails here.
		const reopened = new ConfigRegistry({ store: new DiskConfigOverrideStore(path) })
		expect(reopened.register('persist', Schema).get().attempts).toBe(11)
	})

	it('loads as empty from an unreadable file rather than refusing to start', () => {
		const path = join(dir, 'nested', 'nothing-here.json')
		const scope = new ConfigRegistry({ store: new DiskConfigOverrideStore(path) }).register(
			'fresh',
			Schema,
		)
		// A config override is a preference. Refusing to start a run because
		// one is unreadable turns a convenience into an outage.
		expect(scope.get().attempts).toBe(3)
	})
})

describe('scoping', () => {
	it('two scopes do not see each other', () => {
		const shared = new InMemoryConfigOverrideStore()
		const root = new ConfigRegistry({ store: shared })
		const runA = root.scope('run_a')
		const runB = root.scope('run_b')

		const a = runA.register('mcp.files', Schema)
		const b = runB.register('mcp.files', Schema)

		a.update({ attempts: 20 })

		// Two concurrent runs share a process and a store. Without a scope
		// prefix the second would read the first's overrides and be retuned by
		// somebody else's operator.
		expect(a.get().attempts).toBe(20)
		expect(b.get().attempts).toBe(3)
		expect(runA.namespaces()).toEqual(['mcp.files'])
		expect(root.namespaces()).toEqual([])

		// Registered AFTER A's update, which is where a shared store key
		// actually leaks: B above was already resolved when A wrote, so it
		// would have kept its own value either way. A run that starts later is
		// the one that would silently inherit somebody else's tuning.
		const runC = root.scope('run_c')
		expect(runC.register('mcp.files', Schema).get().attempts).toBe(3)
	})

	it("a scope's own override still survives its own restart", () => {
		const shared = new InMemoryConfigOverrideStore()
		new ConfigRegistry({ store: shared }).scope('run_a').register('x', Schema).update({
			attempts: 30,
		})

		// Scoped, not discarded: the store is shared on purpose so an
		// operator's override is not lost when the run that carried it ends.
		const again = new ConfigRegistry({ store: shared }).scope('run_a').register('x', Schema)
		expect(again.get().attempts).toBe(30)
	})
})

describe('a persisted override written against an older shape', () => {
	it('is refused at registration rather than at the first read', () => {
		const store = new InMemoryConfigOverrideStore()
		store.save('legacy', { attempts: 'seven' })

		// A registry that deferred validation would hand out a value the
		// schema forbids, and the failure would surface wherever it happened
		// to be consumed rather than where it was loaded.
		expect(() => new ConfigRegistry({ store }).register('legacy', Schema)).toThrow()
	})
})

describe('the seam is LIVE, which is the whole point', () => {
	it('a consumer reading through get() sees a change it did not restart for', () => {
		const scope = new ConfigRegistry().register('live', Schema, { base: { attempts: 2 } })

		// A consumer that reads on every use, which is the contract this seam
		// asks of one.
		const readEachTime = () => scope.get().attempts
		expect(readEachTime()).toBe(2)

		scope.update({ attempts: 40 })

		// A registry that resolved once and handed out a frozen value would
		// still answer 2 here — the frozen object with more ceremony.
		expect(readEachTime()).toBe(40)
	})

	it('a consumer that captured the value at construction does NOT, and that is why get() is a call', () => {
		const scope = new ConfigRegistry().register('captured', Schema, { base: { attempts: 2 } })
		const captured = scope.get().attempts
		scope.update({ attempts: 40 })

		// Stated as a test rather than a comment: this is the mistake the
		// supervisor made before this change, and the reason its policy is a
		// function rather than a value.
		expect(captured).toBe(2)
		expect(scope.get().attempts).toBe(40)
	})
})

describe('the driver: an MCP reconnect policy retuned mid-outage', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('uses the NEW maxAttempts on the attempts still to come', async () => {
		const { MCPReconnectOptionsSchema, MCPReconnectSupervisor } = await import(
			'../../connector/mcp/reconnect.js'
		)
		const registry = new ConfigRegistry()
		const policy = registry.register('mcp.flaky', MCPReconnectOptionsSchema, {
			base: { initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 2 },
		})

		let attempts = 0
		let gaveUpAfter: number | undefined
		let onDisconnect: (() => void) | undefined
		const client = {
			onLifecycle: (cb: (e: { type: string }) => void) => {
				onDisconnect = () => cb({ type: 'mcp_client_disconnected' })
				return () => {}
			},
			isConnected: () => false,
			connect: async () => {
				attempts += 1
				// Raised mid-outage, after the first attempt has already failed
				// — which is exactly when an operator reaches for this knob.
				if (attempts === 1) policy.update({ maxAttempts: 4 })
				throw new Error('still down')
			},
		}

		const supervisor = new MCPReconnectSupervisor(client as never, () => ({
			...policy.get(),
			onGaveUp: (n: number) => {
				gaveUpAfter = n
			},
		}))
		supervisor.start()
		onDisconnect?.()

		await vi.advanceTimersByTimeAsync(500)

		// Four, not two. Reading the policy at construction — the shape this
		// supervisor had — gives two, and the whole task would be a
		// declaration nothing drives.
		expect(attempts).toBe(4)
		expect(gaveUpAfter).toBe(4)
	})
})
