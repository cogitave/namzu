/**
 * The checkpoint-store contract, as a suite a host can run against its own
 * backend.
 *
 * ## Why this ships rather than staying a test
 *
 * {@link import('./checkpoint-memory.js').InMemoryCheckpointStore} says in its
 * own doc comment that it is "the reference a host reads when writing a
 * backend of its own". That claim was unbacked, and the cost of it was not
 * hypothetical: the two shipped stores disagreed at the enforcement point —
 * the in-memory one accepted a write from a holder that had been superseded
 * and then released around, the disk one refused it — and the class documented
 * as the reference was the one carrying the defect. Reading a reference cannot
 * tell you that. Running it can.
 *
 * The rules below are the ones a claim depends on and no type can state:
 * exclusivity, expiry, that a superseded write is refused, and that a listing
 * answers for the tenant it was asked about and no other. Those are exactly
 * the points at which the two built-in implementations already diverged.
 *
 * ## Why it takes its runner as an argument
 *
 * `describe`, `it` and `expect` come in through
 * {@link CheckpointStoreConformanceOptions}. The suite therefore imports no
 * test framework, `@namzu/sdk` gains no test dependency from publishing it,
 * and a host on a different runner can still run it by handing over three
 * functions of the shapes below.
 *
 * It also buys the one property that separates this file from decoration: a
 * caller can pass a *recording* `describe`/`it` and run the whole contract as
 * ordinary code, which is how `conformance-fails-a-wrong-store.test.ts`
 * establishes that a deliberately broken store fails it.
 *
 * ## Consuming it
 *
 * See `docs/sdk/runtime/checkpoint-store-conformance.md`. In short:
 *
 * ```typescript
 * import { describe, expect, it } from 'your-runner'
 * import { defineCheckpointStoreConformance } from '@namzu/sdk/testing'
 *
 * defineCheckpointStoreConformance({
 *   describe, it, expect,
 *   label: 'my-backend',
 *   contractVersion: 1,
 *   capabilities: { claims: true, listing: true, multiTenant: true },
 *   makeStore: (binding) => ({ store: new MyStore(binding) }),
 * })
 * ```
 *
 * ## The assertions are public API
 *
 * Once a host wires this in, every assertion below is something their build
 * fails on. Adding one is therefore a breaking change for them even though it
 * adds no export — so a new rule arrives behind a raised
 * {@link CHECKPOINT_STORE_CONTRACT_VERSION} and a `major`, and the version
 * check is what turns "your backend silently satisfies an older, smaller
 * contract" into a named failure.
 */

import type { CostInfo } from '../../types/common/index.js'
import type { IterationCheckpoint } from '../../types/hitl/index.js'
import type { CheckpointId, ProjectId, RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { CheckpointStore } from '../../types/run/checkpoint-store.js'
import { claimRun, listDurableRuns, releaseRun } from './listing.js'

/**
 * Which revision of the contract the assertions in this file express.
 *
 * A host DECLARES the version it wrote its backend against, as a literal in
 * its own test file, and the suite's first case compares the two. Re-exporting
 * this constant into that slot defeats the check — the point is that the
 * number is frozen in the host's source at the moment they wrote the backend,
 * so upgrading `@namzu/sdk` past a contract revision fails with a sentence
 * naming both numbers instead of a scatter of assertion failures whose common
 * cause is not obvious.
 *
 * Raised only together with a `major`, and only when an assertion is ADDED or
 * TIGHTENED. Adding a case behind a new optional capability flag does not
 * raise it: a host that does not declare the capability never runs the case.
 */
export const CHECKPOINT_STORE_CONTRACT_VERSION = 1

/**
 * What a backend can do, so the suite runs the cases it is answerable for and
 * no others.
 *
 * Every field is required rather than defaulted. A capability that defaults to
 * `false` lets a host skip a whole section by forgetting a key, and a suite you
 * can opt out of by omission is a suite that reports a pass it did not
 * establish.
 */
export interface CheckpointStoreCapabilities {
	/**
	 * The store implements `claimRun` / `releaseRun` and enforces the fence at
	 * `writeCheckpoint`. `false` skips every claim case — appropriate only for
	 * a single-writer backend, which is a deployment shape, not a shortcut.
	 */
	readonly claims: boolean
	/** The store implements `listDurableRuns`. */
	readonly listing: boolean
	/**
	 * One instance can hold more than one tenant's runs.
	 *
	 * `false` for a store whose addressing fixes the tenant — the built-in disk
	 * layout has no tenant segment in it, so a second tenant is a second store.
	 * Such a backend still answers the isolation case that CAN be put to it: a
	 * listing for a tenant it does not hold returns nothing.
	 */
	readonly multiTenant: boolean
}

/** The attribution the suite addresses its runs under. */
export interface CheckpointStoreBinding {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: SessionId
}

/** A store to test, plus whatever teardown producing it required. */
export interface CheckpointStoreHandle {
	readonly store: CheckpointStore
	/** Called after each case, pass or fail. */
	dispose?(): void | Promise<void>
}

/**
 * Build a store bound to `binding`. Called once per case, so no case can be
 * affected by another's writes — the suite never assumes a shared instance and
 * never cleans one.
 */
export type MakeCheckpointStore = (
	binding: CheckpointStoreBinding,
) => CheckpointStoreHandle | Promise<CheckpointStoreHandle>

/** The assertions the suite uses, and nothing more. */
export interface ConformanceAssertion {
	toBe(expected: unknown): void
	toEqual(expected: unknown): void
	toBeGreaterThan(expected: number): void
	toMatch(expected: RegExp): void
}

/** Shape of the `expect` a runner supplies. */
export type ConformanceExpect = (actual: unknown) => ConformanceAssertion
/** Shape of the `it` a runner supplies. */
export type ConformanceIt = (name: string, body: () => Promise<void>) => unknown
/** Shape of the `describe` a runner supplies. */
export type ConformanceDescribe = (name: string, body: () => void) => unknown

/** Everything {@link defineCheckpointStoreConformance} needs. */
export interface CheckpointStoreConformanceOptions {
	readonly describe: ConformanceDescribe
	readonly it: ConformanceIt
	readonly expect: ConformanceExpect
	/**
	 * The contract revision this backend was written against, written as a
	 * literal. See {@link CHECKPOINT_STORE_CONTRACT_VERSION}.
	 */
	readonly contractVersion: number
	readonly capabilities: CheckpointStoreCapabilities
	readonly makeStore: MakeCheckpointStore
	/** Names the backend in test output. Defaults to `checkpoint store`. */
	readonly label?: string
}

/** The tenant/project/session every case addresses unless it needs a second. */
const BINDING: CheckpointStoreBinding = {
	tenantId: 'tnt_conformance' as TenantId,
	projectId: 'prj_conformance' as ProjectId,
	sessionId: 'ses_conformance' as SessionId,
}

/** A tenant no backend under test holds runs for. */
const FOREIGN_TENANT = 'tnt_conformance_other' as TenantId

/** Fixed instant, so every expiry in a case is judged against one clock. */
const NOW = 5_000_000

const NO_COST: CostInfo = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
}

let checkpointSeq = 0

function checkpoint(runId: string): IterationCheckpoint {
	checkpointSeq += 1
	return {
		id: `cp_conformance_${checkpointSeq}` as CheckpointId,
		runId: runId as RunId,
		iteration: 1,
		messages: [],
		tokenUsage: {
			promptTokens: 1,
			completionTokens: 1,
			totalTokens: 2,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: NO_COST,
		guardState: { iterationCount: 1, elapsedMs: 1 },
		createdAt: NOW,
	}
}

function runScope(binding: CheckpointStoreBinding, runId = 'run_conformance_a') {
	return { ...binding, runId: runId as RunId }
}

/**
 * Assert that `call` rejected with a message matching `pattern`.
 *
 * Written against `toMatch` rather than a runner's `rejects` helper so the
 * suite needs no matcher beyond the four on {@link ConformanceAssertion}. A
 * call that RESOLVES yields a sentence saying so, which is the diagnostic that
 * matters: the failure this whole file exists for is a write that was accepted
 * when it should have been refused.
 */
async function expectRejection(
	expect: ConformanceExpect,
	call: () => Promise<unknown>,
	pattern: RegExp,
): Promise<void> {
	let message = '<the call resolved; no rejection was raised>'
	try {
		await call()
	} catch (error) {
		message = error instanceof Error ? error.message : String(error)
	}
	expect(message).toMatch(pattern)
}

/**
 * Register the checkpoint-store contract against one backend.
 *
 * Call it once per backend. It registers cases through the supplied `describe`
 * and `it`; it does not run them.
 */
export function defineCheckpointStoreConformance(options: CheckpointStoreConformanceOptions): void {
	const { describe, it, expect, capabilities, makeStore } = options
	const label = options.label ?? 'checkpoint store'

	/**
	 * Run `body` against a store built for this case alone.
	 *
	 * `finally`, so a failing assertion still disposes — a suite that leaks a
	 * temp directory per failure makes a red run expensive to iterate on, and
	 * an expensive red run is one people stop running.
	 */
	const withStore = (body: (store: CheckpointStore) => Promise<void>) => async () => {
		const handle = await makeStore(BINDING)
		try {
			await body(handle.store)
		} finally {
			await handle.dispose?.()
		}
	}

	describe(`${label} conformance`, () => {
		it('declares the contract revision this suite implements', async () => {
			// First case on purpose. When it fails, every case below it is
			// answering a different contract than the backend was written for,
			// and reading their failures as defects would send a host chasing
			// bugs that are really a version skew.
			//
			// Both numbers ride in the COMPARED VALUES rather than in a
			// sentence, because a runner truncates a long actual when it builds
			// the failure message — measured, on the first draft of this, at 37
			// characters, which cut off the very numbers the case exists to
			// report. The guidance that would not fit lives on
			// `CHECKPOINT_STORE_CONTRACT_VERSION`, which is where a reader of
			// this failure is being sent anyway.
			expect(`checkpoint-store contract v${options.contractVersion}`).toBe(
				`checkpoint-store contract v${CHECKPOINT_STORE_CONTRACT_VERSION}`,
			)
		})

		if (capabilities.claims) {
			describe('claim exclusivity', () => {
				it(
					'gives the run to the first taker and refuses the second',
					withStore(async (store) => {
						const first = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 60_000,
							now: NOW,
						})
						const second = await claimRun(store, runScope(BINDING), {
							holder: 'w2',
							ttlMs: 60_000,
							now: NOW,
						})

						expect(first?.holder).toBe('w1')
						// `null`, not a throw: two readers on one queue is the
						// ordinary case, and an exception would make the normal
						// outcome look like a fault.
						expect(second).toBe(null)
					}),
				)

				it(
					'advances the fence on renewal, so a stalled twin cannot write',
					withStore(async (store) => {
						const first = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 1_000,
							now: NOW,
						})
						const renewed = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 60_000,
							now: NOW + 500,
						})

						// Renewal and reclamation are one operation and both
						// advance. A renewal that kept the fence would leave any
						// duplicate of the holder — a retried job, a
						// double-scheduled pod — able to write with the number it
						// captured before.
						expect(renewed?.fence).toBeGreaterThan(first?.fence as number)
					}),
				)

				it(
					'refuses a lease with no duration',
					withStore(async (store) => {
						// A lease that expires immediately is a lease every worker
						// can take at once, which is the condition the call exists
						// to prevent.
						await expectRejection(
							expect,
							() => claimRun(store, runScope(BINDING), { holder: 'w1', ttlMs: 0, now: NOW }),
							/positive number of milliseconds/,
						)
					}),
				)
			})

			describe('claim expiry', () => {
				it(
					'lets a later worker take a run whose holder went away',
					withStore(async (store) => {
						const first = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 1_000,
							now: NOW,
						})
						const second = await claimRun(store, runScope(BINDING), {
							holder: 'w2',
							ttlMs: 60_000,
							now: NOW + 2_000,
						})

						// A lock held by a dead process is held forever. The expiry
						// is the whole difference between a lease and a wedged run.
						expect(second?.holder).toBe('w2')
						expect(second?.fence).toBeGreaterThan(first?.fence as number)
					}),
				)

				it(
					'returns the run to the queue when its holder releases',
					withStore(async (store) => {
						const claim = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 60_000,
							now: NOW,
						})
						await releaseRun(store, runScope(BINDING), claim?.fence as number)

						const next = await claimRun(store, runScope(BINDING), {
							holder: 'w2',
							ttlMs: 60_000,
							now: NOW + 1,
						})
						expect(next?.holder).toBe('w2')
					}),
				)

				it(
					'releases only on the fence that currently holds it',
					withStore(async (store) => {
						const first = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 1_000,
							now: NOW,
						})
						await claimRun(store, runScope(BINDING), {
							holder: 'w2',
							ttlMs: 60_000,
							now: NOW + 2_000,
						})

						// A worker that stalled past its lease must not be able to
						// hand away a run somebody else is now holding.
						await releaseRun(store, runScope(BINDING), first?.fence as number)

						const third = await claimRun(store, runScope(BINDING), {
							holder: 'w3',
							ttlMs: 60_000,
							now: NOW + 3_000,
						})
						expect(third).toBe(null)
					}),
				)
			})

			describe('fenced-out writes', () => {
				it(
					'lets the current holder keep writing',
					withStore(async (store) => {
						const claim = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 60_000,
							now: NOW,
						})
						await store.writeCheckpoint(
							runScope(BINDING),
							checkpoint('run_conformance_a'),
							claim?.fence,
						)
						const written = await store.listCheckpoints(runScope(BINDING))
						expect(written.length).toBe(1)
					}),
				)

				it(
					'still accepts an unfenced write on a claimed run',
					withStore(async (store) => {
						await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 60_000,
							now: NOW,
						})
						// A host that adopts claims on one worker must not break the
						// workers that have not adopted them yet. Refusing here would
						// make the capability impossible to roll out incrementally.
						await store.writeCheckpoint(runScope(BINDING), checkpoint('run_conformance_a'))
						const written = await store.listCheckpoints(runScope(BINDING))
						expect(written.length).toBe(1)
					}),
				)

				it(
					'fences the stalled holder out at the moment it writes',
					withStore(async (store) => {
						const first = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 1_000,
							now: NOW,
						})
						await claimRun(store, runScope(BINDING), {
							holder: 'w2',
							ttlMs: 60_000,
							now: NOW + 2_000,
						})

						// `w1` believes it still holds the run. It cannot know
						// otherwise: a long pause, a suspended container and a
						// partition all look from the inside like time not passing.
						// The write is the only place it can be told, and this is
						// that place.
						await expectRejection(
							expect,
							() =>
								store.writeCheckpoint(
									runScope(BINDING),
									checkpoint('run_conformance_a'),
									first?.fence,
								),
							/no longer holds it/,
						)
					}),
				)

				it(
					'still refuses a superseded fence after the new holder releases',
					withStore(async (store) => {
						// The silent one, and the case on which the two built-in
						// stores actually disagreed. Not a duplicate write — a LOST
						// one.
						//
						// w1 stalls at its fence. w2 reclaims, does the work, and
						// releases cleanly, which is the documented
						// `finally { releaseRun() }`. w1 then wakes believing it
						// still holds the run and writes. If that write is accepted,
						// its checkpoint carries a fresh `createdAt`, sorts newest,
						// and the next resume restores w1's stale history — so w2's
						// completed work vanishes with no error anywhere.
						const stale = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 1_000,
							now: NOW,
						})
						const live = await claimRun(store, runScope(BINDING), {
							holder: 'w2',
							ttlMs: 60_000,
							now: NOW + 2_000,
						})
						await releaseRun(store, runScope(BINDING), live?.fence as number)

						await expectRejection(
							expect,
							() =>
								store.writeCheckpoint(
									runScope(BINDING),
									checkpoint('run_conformance_a'),
									stale?.fence,
								),
							/no longer holds it/,
						)
					}),
				)

				it(
					'refuses the fence its own holder just released',
					withStore(async (store) => {
						// The same hole one step shorter, and the one that pins the
						// release itself rather than a reclaim before it. A holder
						// that gives a run back has given up the right to write to
						// it; nothing else took the run in between, so only the
						// release can be what refuses this.
						const claim = await claimRun(store, runScope(BINDING), {
							holder: 'w1',
							ttlMs: 60_000,
							now: NOW,
						})
						await releaseRun(store, runScope(BINDING), claim?.fence as number)

						await expectRejection(
							expect,
							() =>
								store.writeCheckpoint(
									runScope(BINDING),
									checkpoint('run_conformance_a'),
									claim?.fence,
								),
							/no longer holds it/,
						)
					}),
				)
			})
		}

		if (capabilities.listing) {
			describe('listing scope isolation', () => {
				it(
					'answers nothing for a tenant it does not hold',
					withStore(async (store) => {
						await store.writeCheckpoint(
							runScope(BINDING, 'run_conformance_a'),
							checkpoint('run_conformance_a'),
						)

						const foreign = await listDurableRuns(store, { tenantId: FOREIGN_TENANT })
						// A listing is SCOPED, not addressed: another tenant is a
						// question this store has no rows for. Leaking one row here
						// is the whole of a cross-tenant read.
						expect(foreign.entries.map((e) => e.runId)).toEqual([])
					}),
				)

				it(
					'answers nothing for a project it does not hold',
					withStore(async (store) => {
						await store.writeCheckpoint(
							runScope(BINDING, 'run_conformance_a'),
							checkpoint('run_conformance_a'),
						)

						const foreign = await listDurableRuns(store, {
							tenantId: BINDING.tenantId,
							projectId: 'prj_conformance_other' as ProjectId,
						})
						expect(foreign.entries.map((e) => e.runId)).toEqual([])
					}),
				)

				it(
					'refuses a listing scope with a hole in it',
					withStore(async (store) => {
						// `{ tenantId, sessionId }` reads as "that session under
						// whichever project holds it". A flat backend can answer it
						// and a hierarchical one cannot, so answering differently per
						// backend is the one thing this contract exists to prevent.
						await expectRejection(
							expect,
							() =>
								listDurableRuns(store, {
									tenantId: BINDING.tenantId,
									sessionId: BINDING.sessionId,
								}),
							/contiguous prefix|without `projectId`/,
						)
					}),
				)

				it(
					'rebuilds an addressable row for every run it holds',
					withStore(async (store) => {
						await store.writeCheckpoint(
							runScope(BINDING, 'run_conformance_a'),
							checkpoint('run_conformance_a'),
						)
						await store.writeCheckpoint(
							runScope(BINDING, 'run_conformance_b'),
							checkpoint('run_conformance_b'),
						)

						const page = await listDurableRuns(store, { tenantId: BINDING.tenantId })
						expect(page.entries.map((e) => e.runId)).toEqual([
							'run_conformance_a',
							'run_conformance_b',
						])
						// A row that cannot be turned back into a scope is a report,
						// not a work queue.
						expect(page.entries.map((e) => e.tenantId)).toEqual([
							BINDING.tenantId,
							BINDING.tenantId,
						])
						expect(page.entries.map((e) => e.sessionId)).toEqual([
							BINDING.sessionId,
							BINDING.sessionId,
						])
					}),
				)

				if (capabilities.multiTenant) {
					it(
						'keeps one tenant’s runs out of another tenant’s listing',
						withStore(async (store) => {
							await store.writeCheckpoint(
								runScope(BINDING, 'run_conformance_a'),
								checkpoint('run_conformance_a'),
							)
							await store.writeCheckpoint(
								{
									tenantId: FOREIGN_TENANT,
									projectId: BINDING.projectId,
									sessionId: BINDING.sessionId,
									runId: 'run_conformance_z' as RunId,
								},
								checkpoint('run_conformance_z'),
							)

							const mine = await listDurableRuns(store, { tenantId: BINDING.tenantId })
							expect(mine.entries.map((e) => e.runId)).toEqual(['run_conformance_a'])

							const theirs = await listDurableRuns(store, { tenantId: FOREIGN_TENANT })
							expect(theirs.entries.map((e) => e.runId)).toEqual(['run_conformance_z'])
						}),
					)
				}

				if (capabilities.claims) {
					it(
						'shows the queue reader which runs nobody holds',
						withStore(async (store) => {
							for (const id of ['run_conformance_a', 'run_conformance_b', 'run_conformance_c'])
								await store.writeCheckpoint(runScope(BINDING, id), checkpoint(id))

							await claimRun(store, runScope(BINDING, 'run_conformance_a'), {
								holder: 'w1',
								ttlMs: 60_000,
								now: NOW,
							})
							await claimRun(store, runScope(BINDING, 'run_conformance_b'), {
								holder: 'w1',
								ttlMs: 1_000,
								now: NOW,
							})

							const free = await listDurableRuns(
								store,
								{ tenantId: BINDING.tenantId },
								{ claimed: false, now: NOW + 2_000 },
							)
							// `run_conformance_b`'s holder is gone. An expired claim
							// counts as unheld, or a dead worker's runs stay invisible
							// forever — the failure the lease exists to prevent,
							// reintroduced by the filter that reads it.
							expect(free.entries.map((e) => e.runId)).toEqual([
								'run_conformance_b',
								'run_conformance_c',
							])

							const taken = await listDurableRuns(
								store,
								{ tenantId: BINDING.tenantId },
								{ claimed: true, now: NOW + 2_000 },
							)
							expect(taken.entries.map((e) => e.runId)).toEqual(['run_conformance_a'])
							expect(taken.entries[0]?.claim?.holder).toBe('w1')
							expect(taken.entries[0]?.claim?.expired).toBe(false)
						}),
					)
				}
			})
		}
	})
}
