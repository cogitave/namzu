import { describe, expect, it } from 'vitest'

import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type {
	CheckpointRunScope,
	ClaimRunOptions,
	RunLease,
} from '../../../types/run/checkpoint-store.js'
import { InMemoryCheckpointStore } from '../checkpoint-memory.js'
import {
	CHECKPOINT_STORE_CONTRACT_VERSION,
	type CheckpointStoreCapabilities,
	type ConformanceDescribe,
	type ConformanceIt,
	type MakeCheckpointStore,
	defineCheckpointStoreConformance,
} from '../conformance.js'

/**
 * A conformance suite that no wrong implementation fails is decoration.
 *
 * `run-claim.test.ts` runs the suite against the two backends that SHIP, and
 * both pass — which establishes that the suite is satisfiable and nothing
 * else. The question it cannot answer is the only one that matters to a host
 * writing a backend of its own: would this have caught me?
 *
 * So this file breaks a store on purpose and requires the suite to say so, by
 * name. Both breakages below are real: the first is the mistake a first
 * implementation makes (hand the run to whoever asks), the second is the one
 * this repository actually shipped (mint fences correctly and then not check
 * them at the write), and the second is the one a reader would never find by
 * reading, because everything about the claim path looks right.
 *
 * The mechanism is the reason the suite takes its runner as an argument. A
 * recording `describe`/`it` turns the whole contract into ordinary async
 * functions this file can call and catch, so a case FAILING is an observation
 * here rather than a red run.
 */

/** One registered case and what it did when run. */
type Outcome = { readonly name: string; readonly failure?: string }

const ALL: CheckpointStoreCapabilities = { claims: true, listing: true, multiTenant: true }

/**
 * Run the whole contract against `makeStore` and report per case.
 *
 * `expect` is vitest's real one — an assertion still throws, and the throw is
 * what this catches. Only `describe` and `it` are replaced.
 */
async function runConformance(
	makeStore: MakeCheckpointStore,
	contractVersion = CHECKPOINT_STORE_CONTRACT_VERSION,
): Promise<Outcome[]> {
	const cases: { name: string; body: () => Promise<void> }[] = []
	const path: string[] = []
	const record: ConformanceDescribe = (name, body) => {
		path.push(name)
		body()
		path.pop()
	}
	const collect: ConformanceIt = (name, body) => {
		cases.push({ name: [...path.slice(1), name].join(' > '), body })
	}

	defineCheckpointStoreConformance({
		describe: record,
		it: collect,
		expect,
		contractVersion,
		capabilities: ALL,
		makeStore,
	})

	const outcomes: Outcome[] = []
	for (const one of cases) {
		try {
			await one.body()
			outcomes.push({ name: one.name })
		} catch (error) {
			outcomes.push({
				name: one.name,
				failure: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return outcomes
}

function failed(outcomes: readonly Outcome[]): string[] {
	return outcomes.filter((o) => o.failure !== undefined).map((o) => o.name)
}

const honest: MakeCheckpointStore = () => ({ store: new InMemoryCheckpointStore() })

/** Hands the run to every taker. The mistake a first implementation makes. */
class GrantsEveryClaim extends InMemoryCheckpointStore {
	override async claimRun(_scope: CheckpointRunScope, options: ClaimRunOptions): Promise<RunLease> {
		return { holder: options.holder, fence: 1, expiresAt: (options.now ?? 0) + options.ttlMs }
	}
}

/**
 * Mints fences correctly and then ignores the one presented at the write.
 *
 * The defect this repository shipped, in the class documented as the
 * reference. Nothing about the claim path looks wrong — the numbers are right,
 * they advance, they survive a release — and a stalled holder's write is
 * accepted anyway, so a completed worker's checkpoint is silently overwritten
 * by a dead one's.
 */
class AcceptsEveryWrite extends InMemoryCheckpointStore {
	override async writeCheckpoint(
		scope: CheckpointRunScope,
		checkpoint: IterationCheckpoint,
	): Promise<void> {
		return super.writeCheckpoint(scope, checkpoint)
	}
}

describe('the store conformance suite', () => {
	it('passes the reference implementation', async () => {
		// The control, and not a formality. Every assertion below reads a
		// FAILURE as evidence, and a harness that mis-registers cases or
		// mis-wires the store would produce failures for both the broken stores
		// and the sound one — proving the suite detects nothing while looking
		// like it detects everything.
		const outcomes = await runConformance(honest)
		expect(failed(outcomes)).toEqual([])
		// And it registered a contract, not an empty shell: a `defineX` that
		// silently registered nothing would also report zero failures.
		expect(outcomes.length).toBeGreaterThan(10)
	})

	it('fails a store that hands the run to every taker', async () => {
		const outcomes = await runConformance(() => ({ store: new GrantsEveryClaim() }))
		const names = failed(outcomes)

		expect(names).toContain(
			'claim exclusivity > gives the run to the first taker and refuses the second',
		)
		// Named individually rather than counted. A count passes on any three
		// failures, including three that have nothing to do with exclusivity.
		expect(names).toContain(
			'claim exclusivity > advances the fence on renewal, so a stalled twin cannot write',
		)
		expect(names).toContain('claim expiry > releases only on the fence that currently holds it')
	})

	it('fails a store that mints fences and then does not check them', async () => {
		const outcomes = await runConformance(() => ({ store: new AcceptsEveryWrite() }))
		const names = failed(outcomes)

		expect(names).toContain(
			'fenced-out writes > fences the stalled holder out at the moment it writes',
		)
		expect(names).toContain(
			'fenced-out writes > still refuses a superseded fence after the new holder releases',
		)
		expect(names).toContain('fenced-out writes > refuses the fence its own holder just released')
		// Its claim path is untouched and must stay green, or the suite is
		// reporting the wrong subject and a host would go looking in the wrong
		// file.
		expect(names).not.toContain(
			'claim exclusivity > gives the run to the first taker and refuses the second',
		)
	})

	it('fails a backend that declares an older contract revision', async () => {
		const outcomes = await runConformance(honest, CHECKPOINT_STORE_CONTRACT_VERSION - 1)
		const version = outcomes[0]

		expect(version?.name).toBe('declares the contract revision this suite implements')
		// The message has to name BOTH numbers, and survive the truncation a
		// runner applies when it builds a failure message — the first draft put
		// the explanation in the actual value and lost both numbers at 37
		// characters, which is a check that fires and says nothing.
		expect(version?.failure ?? '').toMatch(
			new RegExp(`contract v${CHECKPOINT_STORE_CONTRACT_VERSION - 1}\\b`),
		)
		expect(version?.failure ?? '').toMatch(
			new RegExp(`contract v${CHECKPOINT_STORE_CONTRACT_VERSION}\\b`),
		)
	})
})
