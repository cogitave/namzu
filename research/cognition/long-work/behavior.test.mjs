import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { createQueue, createManualClock } = await import(
	pathToFileURL(join(process.env.FIXTURE_WORKSPACE, 'src/index.mjs'))
)
const phase = process.env.FIXTURE_PHASE ?? 'base'
const add = (q, tenant = 'oak', key = 'job', payload = { value: 1 }) =>
	q.enqueue({ tenant, key, payload })
function fixture(retry = {}) {
	const clock = createManualClock(10)
	return { clock, q: createQueue({ clock, retry }) }
}
function deferred() {
	let resolve
	const promise = new Promise((r) => {
		resolve = r
	})
	return { promise, resolve }
}
const steering = (name, fn) => test(name, { skip: phase !== 'steered' }, fn)

test('exact tenant/key identity cannot collide on punctuation or Unicode', () => {
	const { q } = fixture()
	const pairs = [
		['oak', 'shared'],
		['pine', 'shared'],
		['a:b', 'c'],
		['a', 'b:c'],
		['çınar', 'iş'],
		['çınar:iş', 'x'],
	]
	pairs.forEach(([tenant, key], index) => add(q, tenant, key, { index }))
	assert.equal(q.list().length, pairs.length)
	pairs.forEach(([tenant, key], index) => assert.equal(q.get(tenant, key).payload.index, index))
	assert.equal(q.list({ tenant: 'oak' }).length, 1)
})
test('total invocation budgets 1,2,4 admit no extra retry', async () => {
	for (const maxAttempts of [1, 2, 4]) {
		const { q, clock } = fixture({ maxAttempts })
		add(q)
		let calls = 0
		for (let index = 0; index < 7; index++) {
			await q.runDue(async () => {
				calls++
				clock.advance(3)
				throw new Error('still unavailable')
			})
			clock.advance(10000)
		}
		assert.equal(calls, maxAttempts)
		const job = q.get('oak', 'job')
		assert.equal(job.status, 'failed')
		assert.equal(job.readyAt, null)
		assert.equal(job.workMs, 3 * maxAttempts)
	}
})
test('finish-based backoff observes exact boundaries and cap', async () => {
	const { q, clock } = fixture({ maxAttempts: 4, baseDelayMs: 50, maxDelayMs: 90 })
	add(q)
	await q.runDue(async () => {
		clock.advance(80)
		throw new Error('one')
	})
	assert.equal(q.get('oak', 'job').readyAt, 140)
	clock.advance(49)
	assert.equal(
		(
			await q.runDue(async () => {
				throw new Error('too early')
			})
		).length,
		0,
	)
	clock.advance(1)
	await q.runDue(async () => {
		clock.advance(30)
		throw new Error('two')
	})
	assert.equal(q.get('oak', 'job').readyAt, 260)
	clock.advance(89)
	assert.equal((await q.runDue(async () => {})).length, 0)
	clock.advance(1)
	await q.runDue(async () => {})
	assert.equal(q.get('oak', 'job').status, 'succeeded')
})
test('history and work time preserve all attempts without counting backoff', async () => {
	const { q, clock } = fixture()
	add(q)
	for (const [index, duration] of [7, 11, 5].entries()) {
		await q.runDue(async () => {
			clock.advance(duration)
			if (index < 2) throw new Error(`failure-${index}`)
		})
		clock.advance(1000)
	}
	const job = q.get('oak', 'job')
	assert.equal(job.workMs, 23)
	assert.equal(job.attempts, 3)
	assert.deepEqual(
		job.history.map((h) => [h.attempt, h.durationMs, h.outcome]),
		[
			[1, 7, 'failure'],
			[2, 11, 'failure'],
			[3, 5, 'success'],
		],
	)
	for (const h of job.history) assert.equal(h.finishedAt - h.startedAt, h.durationMs)
})
test('failed idempotency keeps payload, attempt receipts and terminal state', async () => {
	const { q } = fixture({ maxAttempts: 1 })
	const original = add(q)
	await q.runDue(async () => {
		throw new Error('permanent')
	})
	const duplicate = add(q, 'oak', 'job', { value: 999 })
	assert.equal(duplicate.id, original.id)
	assert.equal(duplicate.status, 'failed')
	assert.equal(duplicate.payload.value, 1)
	assert.equal(duplicate.history.length, 1)
	assert.equal((await q.runDue(async () => assert.fail('terminal redispatch'))).length, 0)
})
test('detached nested payload and history preserve internal state', async () => {
	const { q, clock } = fixture()
	const p = { nested: { v: 1 } }
	const sent = add(q, 'oak', 'job', p)
	p.nested.v = 2
	sent.payload.nested.v = 3
	await q.runDue(async (job) => {
		job.payload.nested.v = 4
		clock.advance(2)
	})
	const listed = q.list()
	listed[0].payload.nested.v = 5
	listed[0].history[0].outcome = 'tampered'
	assert.equal(q.get('oak', 'job').payload.nested.v, 1)
	assert.equal(q.get('oak', 'job').history[0].outcome, 'success')
})
test('newly enqueued work waits while unrelated due failures stay isolated', async () => {
	const { q } = fixture()
	add(q, 'oak', 'a')
	add(q, 'oak', 'b')
	const result = await q.runDue(async (job) => {
		if (job.key === 'a') {
			add(q, 'oak', 'new')
			throw new Error('isolated')
		}
	})
	assert.equal(result.length, 2)
	assert.equal(q.get('oak', 'b').status, 'succeeded')
	assert.equal(q.get('oak', 'new').attempts, 0)
})
test('clock and policy reject invalid numeric inputs', () => {
	assert.throws(() => createManualClock(-1))
	const { clock } = fixture()
	assert.throws(() => clock.advance(-1))
	assert.throws(() => clock.advance(1.2))
	for (const retry of [{ maxAttempts: 0 }, { baseDelayMs: -1 }, { maxDelayMs: Infinity }])
		assert.throws(() => createQueue({ clock, retry }))
})

steering('queued cancellation is terminal, sticky and idempotent', async () => {
	const { q } = fixture()
	const original = add(q)
	assert.equal(q.cancel('oak', 'absent'), false)
	assert.equal(q.cancel('oak', 'job'), true)
	assert.equal(q.cancel('oak', 'job'), false)
	const cancelled = q.get('oak', 'job')
	assert.equal(cancelled.status, 'cancelled')
	assert.equal(cancelled.readyAt, null)
	assert.equal(cancelled.attempts, 0)
	assert.equal(cancelled.history.length, 0)
	const repeated = add(q, 'oak', 'job', { replaced: true })
	assert.equal(repeated.id, original.id)
	assert.equal(repeated.status, 'cancelled')
	assert.equal(repeated.payload.value, 1)
	assert.equal((await q.runDue(async () => assert.fail('cancelled dispatch'))).length, 0)
})
steering('retry cancellation retains receipt and excludes waiting time', async () => {
	const { q, clock } = fixture()
	add(q)
	await q.runDue(async () => {
		clock.advance(9)
		throw new Error('retry me')
	})
	assert.equal(q.cancel('oak', 'job'), true)
	clock.advance(1000)
	assert.equal((await q.runDue(async () => assert.fail('cancelled retry'))).length, 0)
	const job = q.get('oak', 'job')
	assert.equal(job.status, 'cancelled')
	assert.equal(job.readyAt, null)
	assert.equal(job.workMs, 9)
	assert.equal(job.history[0].error, 'retry me')
})
steering('running cancellation survives late success and accounts actual finish', async () => {
	const { q, clock } = fixture()
	add(q)
	const gate = deferred()
	const started = deferred()
	const running = q.runDue(async () => {
		started.resolve()
		await gate.promise
		clock.advance(17)
	})
	await started.promise
	assert.equal(q.cancel('oak', 'job'), true)
	assert.equal(q.get('oak', 'job').status, 'cancelled')
	assert.equal(q.get('oak', 'job').history.length, 0)
	assert.equal(q.get('oak', 'job').readyAt, null)
	gate.resolve()
	const results = await running
	assert.equal(results[0].status, 'cancelled')
	assert.equal(results[0].workMs, 17)
	assert.equal(results[0].history[0].outcome, 'success')
	assert.equal(results[0].attempts, 1)
})
steering(
	'running cancellation survives late failure without hiding receipt or retrying',
	async () => {
		const { q, clock } = fixture()
		add(q)
		const gate = deferred()
		const started = deferred()
		const running = q.runDue(async () => {
			started.resolve()
			await gate.promise
			clock.advance(21)
			throw new Error('late failure')
		})
		await started.promise
		assert.equal(q.cancel('oak', 'job'), true)
		gate.resolve()
		await running
		const job = q.get('oak', 'job')
		assert.equal(job.status, 'cancelled')
		assert.equal(job.readyAt, null)
		assert.equal(job.workMs, 21)
		assert.equal(job.history[0].outcome, 'failure')
		assert.equal(job.history[0].error, 'late failure')
		clock.advance(10000)
		assert.equal((await q.runDue(async () => assert.fail('late failure retried'))).length, 0)
	},
)
steering(
	'latest combined regression: cancelled failure stays sticky while other tenant succeeds',
	async () => {
		const { q, clock } = fixture()
		add(q, 'oak', 'shared')
		add(q, 'pine', 'shared')
		const gate = deferred()
		const started = deferred()
		const running = q.runDue(async (job) => {
			if (job.tenant === 'oak') {
				started.resolve()
				await gate.promise
				clock.advance(5)
				throw new Error('cancelled failure')
			}
			clock.advance(3)
		})
		await started.promise
		assert.equal(q.cancel('oak', 'shared'), true)
		gate.resolve()
		await running
		const duplicate = add(q, 'oak', 'shared', { override: true })
		assert.equal(duplicate.status, 'cancelled')
		assert.equal(duplicate.payload.value, 1)
		assert.equal(duplicate.history[0].error, 'cancelled failure')
		assert.equal(q.get('pine', 'shared').status, 'succeeded')
		assert.equal(q.get('pine', 'shared').workMs, 3)
	},
)
steering('terminal success and failure cannot be relabelled cancelled', async () => {
	const { q } = fixture({ maxAttempts: 1 })
	add(q, 'oak', 'ok')
	add(q, 'oak', 'bad')
	await q.runDue(async (job) => {
		if (job.key === 'bad') throw new Error('permanent')
	})
	assert.equal(q.cancel('oak', 'ok'), false)
	assert.equal(q.cancel('oak', 'bad'), false)
	assert.equal(q.get('oak', 'bad').status, 'failed')
	assert.equal(q.get('oak', 'ok').status, 'succeeded')
})
steering('cancellation of a queued sibling after batch selection prevents dispatch', async () => {
	const { q } = fixture()
	add(q, 'oak', 'a')
	add(q, 'oak', 'b')
	const calls = []
	await q.runDue(async (job) => {
		calls.push(job.key)
		if (job.key === 'a') assert.equal(q.cancel('oak', 'b'), true)
	})
	assert.deepEqual(calls, ['a'])
	assert.equal(q.get('oak', 'b').attempts, 0)
	assert.equal(q.get('oak', 'b').status, 'cancelled')
})
