/**
 * `createMemoryPromoter` — the supplier `promoteMemory` never had.
 *
 * The assertions that matter are about the store's CONTENTS, not about a
 * write "succeeding". A promoter that wrote an empty record for every run
 * would satisfy "it was called" and "it did not throw", and would then fill
 * the store the model reads on later runs with accounts of runs that
 * discovered nothing.
 */

import { describe, expect, it } from 'vitest'

import { InMemoryMemoryStore } from '../../store/memory/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunMemoryCandidate } from '../../types/run/memory-promotion.js'
import { RUN_MEMORY_TAG, createMemoryPromoter } from '../memory-promoter.js'

function candidate(over: Partial<RunMemoryCandidate> = {}): RunMemoryCandidate {
	return {
		runId: 'run_abc' as RunId,
		task: 'ship the invoice job',
		decisions: [],
		discoveries: [],
		userRequirements: [],
		failures: [],
		environment: [],
		files: [],
		evicted: {},
		...over,
	}
}

async function stored(store: InMemoryMemoryStore) {
	const page = await store.list()
	return page
}

describe('a run that learned something', () => {
	it('leaves exactly one durable record', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(
			candidate({ userRequirements: ['invoices must never be emailed twice'] }),
		)

		const page = await stored(store)
		expect(page.totalCount).toBe(1)
		const [entry] = page.entries
		expect(entry?.title).toBe('ship the invoice job')
		expect(entry?.tags).toContain(RUN_MEMORY_TAG)
	})

	it('writes the requirement into the body, not just a count', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(
			candidate({ userRequirements: ['invoices must never be emailed twice'] }),
		)

		const [entry] = (await stored(store)).entries
		const body = await store.get(entry?.id as never)
		// A record whose summary says "1 requirement" and whose body says
		// nothing is a record that costs a retrieval and answers nothing.
		expect(body?.content).toContain('invoices must never be emailed twice')
		expect(body?.content).toContain('What the user requires')
	})

	it('traces the record back to the run that formed it', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(candidate({ decisions: ['use the outbox table'] }))

		const [entry] = (await stored(store)).entries
		const body = await store.get(entry?.id as never)
		// Without it, a surprising memory cannot be checked against what
		// actually happened.
		expect(body?.metadata).toMatchObject({ runId: 'run_abc' })
	})

	it('says it is reading a truncated account when entries were evicted', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(
			candidate({ discoveries: ['the parser is hand-rolled'], evicted: { discoveries: 4 } }),
		)

		const [entry] = (await stored(store)).entries
		const body = await store.get(entry?.id as never)
		// The candidate carries eviction counts rather than hiding them, and a
		// promoter that dropped them would undo that: somebody reading this
		// record should know the run's account of itself is incomplete.
		expect(body?.content).toContain('4 entries evicted')
	})

	it('caps how much of each category it renders', async () => {
		const store = new InMemoryMemoryStore()
		const many = Array.from({ length: 50 }, (_, i) => `discovery ${i}`)
		await createMemoryPromoter({ store, maxPerCategory: 3 })(candidate({ discoveries: many }))

		const [entry] = (await stored(store)).entries
		const body = await store.get(entry?.id as never)
		expect(body?.content).toContain('discovery 2')
		expect(body?.content).not.toContain('discovery 3')
	})

	it('carries the host tags so one store can serve several agents', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store, tags: ['triage-bot'] })(
			candidate({ failures: ['retrying the webhook made it worse'] }),
		)

		const [entry] = (await stored(store)).entries
		expect(entry?.tags).toEqual(expect.arrayContaining([RUN_MEMORY_TAG, 'triage-bot']))
	})
})

describe('a run that learned nothing', () => {
	it('leaves NO record at all — the store is empty', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(candidate())

		// Asserted as emptiness, not as "the write succeeded". A promoter that
		// wrote a row per run would pass every other test in this file and
		// would fill the store the model reads with runs that found nothing.
		const page = await stored(store)
		expect(page.totalCount).toBe(0)
		expect(page.entries).toEqual([])
	})

	it('writes nothing for a run whose only trace is the files it opened', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(
			candidate({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
		)

		// `files` is what was TOUCHED, not what was learned, and every run that
		// opened anything has some. Counting it would make the filter fire on
		// essentially every run, which is the same as having no filter.
		expect((await stored(store)).totalCount).toBe(0)
	})

	it('writes nothing for a run that only restated its task', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(candidate({ task: 'do the thing' }))

		// Every candidate has a task — it is the prompt, restated by the
		// extractor. A promoter that treated it as knowledge would write a
		// record for literally every run.
		expect((await stored(store)).totalCount).toBe(0)
	})

	it('still writes when the only thing learned is an environment fact', async () => {
		const store = new InMemoryMemoryStore()
		await createMemoryPromoter({ store })(candidate({ environment: ['node 22, pnpm 10'] }))

		// The guard on the three above: a filter that refused everything would
		// pass all of them, and a promoter that never writes is the defect this
		// module exists to fix wearing a different shape.
		expect((await stored(store)).totalCount).toBe(1)
	})
})

describe('what it does not hide', () => {
	it('lets a broken store surface, rather than swallowing it', async () => {
		const store = {
			create: async () => {
				throw new Error('the memory store is unreachable')
			},
		} as unknown as InMemoryMemoryStore

		// The runtime already catches and LOGS a promoter's failure at settle,
		// so catching here as well would hide a broken store from the one place
		// that reports it — and an operator would see a memory feature that
		// silently never wrote anything.
		await expect(createMemoryPromoter({ store })(candidate({ decisions: ['x'] }))).rejects.toThrow(
			/unreachable/,
		)
	})
})
