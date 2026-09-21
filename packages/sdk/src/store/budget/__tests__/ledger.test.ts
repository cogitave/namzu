import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import type { TokenUsage } from '../../../types/common/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { uuidv7 } from '../../../utils/uuidv7.js'
import {
	SESSION_TOKEN_BUDGET_VERSION,
	SessionTokenBudget,
	type SessionTokenBudgetScope,
	type SessionTokenBudgetSnapshot,
	SessionTokenBudgetVersionError,
	validateSessionTokenBudgetSnapshot,
} from '../ledger.js'

const usage = (totalTokens: number): TokenUsage => ({
	...EMPTY_TOKEN_USAGE,
	promptTokens: totalTokens,
	totalTokens,
})

function scope(): SessionTokenBudgetScope {
	return { rootSessionId: generateSessionId(), rootTurnId: generateTurnId() }
}

function create(limit: number): SessionTokenBudget {
	return SessionTokenBudget.create(limit, scope())
}

/** A reserved account bound to a turn of a new child session. */
function child(parent: SessionTokenBudget, tokens: number): SessionTokenBudget {
	const budget = parent.reserve(tokens)
	budget.bindTurn(generateSessionId(), generateTurnId())
	return budget
}

async function spend(budget: SessionTokenBudget, tokens: number): Promise<string> {
	const request = await budget.beginRequest()
	await budget.finishRequest(request, usage(tokens))
	return request
}

describe('a session token budget is keyed by its root turn', () => {
	it('binds the root account to (rootSessionId, rootTurnId) and snapshots version 2', () => {
		const key = scope()
		const root = SessionTokenBudget.create(500, key)
		expect(root.scope).toEqual(key)
		expect(root.turn).toEqual({ sessionId: key.rootSessionId, turnId: key.rootTurnId })
		expect(root.turnId).toBe(key.rootTurnId)
		const snapshot = root.snapshot()
		expect(snapshot).toMatchObject({
			v: SESSION_TOKEN_BUDGET_VERSION,
			kind: 'token-budget',
			rootSessionId: key.rootSessionId,
			rootTurnId: key.rootTurnId,
			limit: 500,
			rootAccountId: root.accountId,
		})
		root.narrow(300)
		expect(root.snapshot().limit).toBe(300)
		expect(validateSessionTokenBudgetSnapshot(root.snapshot())).toEqual(root.snapshot())
	})

	it('shares one ledger across a three-level child session tree', async () => {
		const root = create(1_000)
		const childSession = generateSessionId()
		const childTurn = generateTurnId()
		const worker = root.reserve(600)
		worker.bindTurn(childSession, childTurn)
		const grandchild = child(worker, 300)
		const greatGrandchild = child(grandchild, 100)
		await spend(greatGrandchild, 40)
		await spend(grandchild, 60)
		await spend(worker, 100)
		await spend(root, 50)
		expect(root.treeTokens).toBe(250)
		expect(worker.treeTokens).toBe(200)
		expect(root.findTurn(childTurn)?.accountId).toBe(worker.accountId)
		expect(worker.turn).toEqual({ sessionId: childSession, turnId: childTurn })
		const restored = SessionTokenBudget.restore(root.snapshot())
		expect(restored.account(greatGrandchild.accountId).ownTokens).toBe(40)
		expect(restored.account(greatGrandchild.accountId).remaining).toBe(60)
		expect(restored.remaining).toBe(1_000 - 50 - 600)
	})

	it('keeps two root turns of one session independent, each with its own limit', async () => {
		const rootSessionId = generateSessionId()
		const first = SessionTokenBudget.create(100, { rootSessionId, rootTurnId: generateTurnId() })
		const second = SessionTokenBudget.create(5_000, { rootSessionId, rootTurnId: generateTurnId() })
		await spend(first, 100)
		expect(first.remaining).toBe(0)
		expect(second.remaining).toBe(5_000)
		await spend(second, 1_000)
		expect(first.treeTokens).toBe(100)
		expect(second.treeTokens).toBe(1_000)
		expect(first.snapshot().rootTurnId).not.toBe(second.snapshot().rootTurnId)
	})

	it('refuses a version 1 snapshot with an upgrade message', () => {
		const legacy = {
			version: 1,
			rootAccountId: uuidv7(),
			accounts: [],
			requests: [],
			completedRequests: [],
		}
		expect(() => validateSessionTokenBudgetSnapshot(legacy)).toThrow(SessionTokenBudgetVersionError)
		expect(() => validateSessionTokenBudgetSnapshot(legacy)).toThrow(
			/version 1 \(keyed by run\).*\(rootSessionId, rootTurnId\).*before upgrading/,
		)
		expect(() =>
			SessionTokenBudget.restore(legacy as unknown as SessionTokenBudgetSnapshot),
		).toThrow(SessionTokenBudgetVersionError)
	})

	it('refuses another version or another kind by name', () => {
		const snapshot = create(10).snapshot()
		expect(() => validateSessionTokenBudgetSnapshot({ ...snapshot, v: 3 })).toThrow(
			/Unsupported token budget snapshot version 3/,
		)
		expect(() => validateSessionTokenBudgetSnapshot({ ...snapshot, kind: 'checkpoint' })).toThrow(
			/Not a token-budget document/,
		)
		expect(() => validateSessionTokenBudgetSnapshot(null)).toThrow('expected an object')
	})

	it('refuses a document whose limit or root binding disagrees with its accounts', () => {
		const root = create(100)
		expect(() => validateSessionTokenBudgetSnapshot({ ...root.snapshot(), limit: 200 })).toThrow(
			'disagrees',
		)
		expect(() =>
			validateSessionTokenBudgetSnapshot({ ...root.snapshot(), rootTurnId: generateTurnId() }),
		).toThrow('root account')
		expect(() =>
			validateSessionTokenBudgetSnapshot({ ...root.snapshot(), rootSessionId: 'nope' }),
		).toThrow('rootSessionId')
		const unbound = root.snapshot()
		const account = unbound.accounts[0]
		if (!account) throw new Error('Expected root account')
		account.turn = undefined
		account.usage = {}
		expect(() => validateSessionTokenBudgetSnapshot(unbound)).toThrow('root account')
	})

	it('refuses malformed bound turns and usage without a binding', () => {
		const root = create(100)
		const worker = root.reserve(10)
		const cases: Array<(snapshot: SessionTokenBudgetSnapshot) => void> = [
			(snapshot) => {
				snapshot.accounts[0]!.turn = { sessionId: generateSessionId(), turnId: generateTurnId() }
			},
			(snapshot) => {
				snapshot.accounts[1]!.usage = { [generateTurnId()]: usage(1) }
			},
			(snapshot) => {
				snapshot.accounts[1]!.turn = 'x' as never
			},
			(snapshot) => {
				snapshot.accounts[1]!.usage = { 'not-a-turn': usage(1) }
			},
			(snapshot) => {
				snapshot.accounts[1]!.settled = 'yes' as never
			},
			(snapshot) => {
				snapshot.poisoned = 'yes' as never
			},
			(snapshot) => {
				snapshot.requests = {} as never
			},
		]
		for (const mutate of cases) {
			const snapshot = root.snapshot()
			mutate(snapshot)
			expect(() => validateSessionTokenBudgetSnapshot(snapshot)).toThrow()
		}
		expect(worker.turn).toBeUndefined()
	})
})

describe('a scoped session token budget', () => {
	it('tracks unlimited descendants and preserves a subsequently narrowed ancestor', async () => {
		const root = create(0)
		const worker = child(root, 0)
		const grandchild = child(worker, 0)
		await spend(grandchild, 250_000)
		expect(root.summary().treeTokens).toBe(250_000)
		expect(worker.remaining).toBe(Number.POSITIVE_INFINITY)
		const restored = SessionTokenBudget.restore(root.snapshot())
		expect(restored.account(grandchild.accountId).remaining).toBe(Number.POSITIVE_INFINITY)
		root.narrow(250_010)
		expect(grandchild.remaining).toBe(10)
		expect(() => worker.reserve(0)).toThrow('cannot reserve')
		await spend(grandchild, 10)
		expect(worker.remaining).toBe(0)
		await expect(grandchild.beginRequest()).rejects.toThrow()
	})

	it('isolates uncertain children without erasing usage or reopening their own account', async () => {
		const root = create(0)
		const broken = child(root, 0)
		const healthy = child(root, 0)
		const request = await broken.beginRequest()
		await broken.failRequest(request, usage(15))
		expect(root.summary()).toMatchObject({ poisoned: false, unresolvedRequests: 1, treeTokens: 15 })
		await expect(broken.beginRequest()).rejects.toThrow('unresolved')
		await spend(healthy, 20)
		await spend(root, 10)
		const restored = SessionTokenBudget.restore(root.snapshot())
		expect(restored.summary()).toMatchObject({
			treeTokens: 45,
			unresolvedRequests: 1,
			poisoned: false,
		})
		await spend(restored.account(healthy.accountId), 5)
		restored.narrow(100)
		expect(restored.account(healthy.accountId).remaining).toBe(0)
		await restored.account(broken.accountId).finishRequest(request, usage(25))
		expect(restored.summary().poisoned).toBe(true)
		await restored.account(broken.accountId).reconcileRequest(request, usage(30))
		expect(restored.summary()).toMatchObject({
			treeTokens: 65,
			unresolvedRequests: 0,
			poisoned: false,
		})
	})

	it('contains uncertainty within the finite branch that owns the missing receipt', async () => {
		const root = create(0)
		const finite = child(root, 500)
		const broken = child(finite, 100)
		const sibling = child(finite, 100)
		const outside = child(root, 200)
		await broken.failRequest(await broken.beginRequest())
		expect(sibling.remaining).toBe(0)
		expect(finite.remaining).toBe(0)
		await spend(outside, 20)
		await spend(root, 10)
		expect(root.treeTokens).toBe(30)
	})

	it('keeps poisoned snapshots globally blocked even for unlimited trees', async () => {
		const root = create(0)
		const worker = child(root, 0)
		const restored = SessionTokenBudget.restore({ ...root.snapshot(), poisoned: true })
		await expect(restored.account(worker.accountId).beginRequest()).rejects.toThrow(
			'accounting failure',
		)
	})

	it('conserves measured usage and unspent reservations for arbitrary concurrent completions', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 350 }), fc.boolean()), {
					minLength: 3,
					maxLength: 3,
				}),
				async (outcomes) => {
					const root = create(1_000)
					await spend(root, 100)
					const workers = outcomes.map(() => child(root, 200))
					const requests = await Promise.all(workers.map((worker) => worker.beginRequest()))
					await Promise.all(
						workers.map(async (worker, index) => {
							const outcome = outcomes[index]
							const request = requests[index]
							if (!outcome || !request) throw new Error('Missing generated completion')
							const [spent, settled] = outcome
							await worker.finishRequest(request, usage(spent))
							if (settled) worker.settle(spent)
						}),
					)
					const measured = 100 + outcomes.reduce((sum, [spent]) => sum + spent, 0)
					const held = outcomes.reduce(
						(sum, [spent, settled]) => sum + (settled ? 0 : Math.max(0, 200 - spent)),
						0,
					)
					expect(root.treeTokens).toBe(measured)
					expect(root.ownTokens).toBe(100)
					expect(root.remaining).toBe(Math.max(0, 1_000 - measured - held))
					for (const worker of workers)
						expect(worker.remaining).toBeLessThanOrEqual(Math.max(0, 1_000 - measured))
				},
			),
			{ seed: 34797, numRuns: 50 },
		)
	})

	it('conserves parent, child and grandchild spend without charging descendants twice', async () => {
		const root = create(1_000)
		await spend(root, 200)
		const worker = child(root, 400)
		const grandchild = child(worker, 100)
		expect(root.remaining).toBe(400)
		expect(worker.remaining).toBe(300)
		await spend(grandchild, 50)
		grandchild.settle(50)
		await spend(worker, 100)
		worker.settle(100)
		expect(root.summary()).toMatchObject({
			ownTokens: 200,
			treeTokens: 350,
			reservedTokens: 0,
			remainingTokens: 650,
			unsettledChildren: 0,
		})
		expect(worker.summary()).toMatchObject({ ownTokens: 100, treeTokens: 150 })
	})

	it('serializes reservation arithmetic before concurrent provisioning can await', async () => {
		const root = create(1_000)
		const outcomes = await Promise.allSettled([1, 2].map(async () => child(root, 600)))
		expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1)
		expect(root.remaining).toBe(400)
	})

	it('does not let a grandchild escape the immediate parent allocation', () => {
		const root = create(10_000)
		const worker = child(root, 100)
		expect(() => worker.reserve(101)).toThrow('cannot reserve')
		expect(() => worker.account(root.accountId)).toThrow('outside this subtree')
		expect(worker.findTurn(root.scope.rootTurnId)).toBeUndefined()
		expect(root.remaining).toBe(9_900)
	})

	it('narrows the full descendant budget and returns the unused reservation difference', () => {
		const root = create(1_000)
		const worker = child(root, 500)
		worker.narrow(200)
		expect(root.remaining).toBe(800)
		expect(worker.remaining).toBe(200)
		expect(() => worker.reserve(201)).toThrow('cannot reserve')
		worker.narrow(0)
		expect(worker.limit).toBe(200)
		expect(() => worker.narrow(201)).toThrow('cannot widen')
		const unlimited = create(0)
		unlimited.narrow(100)
		expect(unlimited.remaining).toBe(100)
	})

	it('keeps narrowing debt and existing descendant accounts across restore', async () => {
		const root = create(1_000)
		const worker = child(root, 500)
		const grandchild = child(worker, 400)
		await spend(grandchild, 200)
		worker.narrow(100)
		expect(grandchild.remaining).toBe(0)
		expect(root.treeTokens).toBe(200)
		const restored = SessionTokenBudget.restore(root.snapshot())
		expect(restored.account(grandchild.accountId).remaining).toBe(0)
		expect(restored.remaining).toBe(800)
	})

	it('keeps reserved child headroom usable when the parent has none unreserved', async () => {
		const root = create(1_000)
		await spend(root, 700)
		const worker = child(root, 300)
		expect(root.remaining).toBe(0)
		await expect(root.beginRequest()).rejects.toThrow('exhausted')
		expect(worker.remaining).toBe(300)
		await spend(worker, 300)
		expect(root.treeTokens).toBe(1_000)
		await expect(worker.beginRequest()).rejects.toThrow('exhausted')
	})

	it('charges overshoot debt to siblings and every ancestor', async () => {
		const root = create(1_000)
		const first = child(root, 400)
		const second = child(root, 400)
		await spend(first, 800)
		first.settle(800)
		expect(root.remaining).toBe(0)
		expect(second.remaining).toBe(200)
		await spend(second, 250)
		second.settle(250)
		expect(root.treeTokens).toBe(1_050)
		expect(root.remaining).toBe(0)
		await expect(root.beginRequest()).rejects.toThrow('exhausted')
	})

	it('retains an ended parent reservation until its descendants settle', async () => {
		const root = create(1_000)
		const worker = child(root, 500)
		const grandchild = child(worker, 200)
		worker.settle(50)
		expect(root.remaining).toBe(500)
		await spend(grandchild, 80)
		grandchild.settle(80)
		expect(root.remaining).toBe(870)
		expect(root.treeTokens).toBe(130)
	})

	it('retains a cancelled account reservation until an admitted request reports usage', async () => {
		const root = create(1_000)
		const worker = child(root, 500)
		const request = await worker.beginRequest()
		worker.settle()
		expect(root.remaining).toBe(500)
		await worker.finishRequest(request, usage(75))
		expect(root.remaining).toBe(925)
		expect(worker.remaining).toBe(0)
		await expect(worker.beginRequest()).rejects.toThrow('settled')
	})

	it('refuses reservation or another request during the same account provider call', async () => {
		const root = create(1_000)
		expect(root.hasInFlightRequest).toBe(false)
		const request = await root.beginRequest()
		expect(root.hasInFlightRequest).toBe(true)
		expect(() => root.reserve(10)).toThrow('in-flight')
		await expect(root.beginRequest()).rejects.toThrow('in-flight')
		await root.finishRequest(request, usage(10))
		expect(root.hasInFlightRequest).toBe(false)
		expect(root.reserve(990).limit).toBe(990)
	})

	it('max-reconciles cumulative turn totals and idempotent settlement', async () => {
		const root = create(1_000)
		const worker = child(root, 500)
		await spend(worker, 100)
		worker.recordUsage(usage(100))
		worker.recordUsage(usage(90))
		worker.settle(100)
		worker.settle(100)
		expect(root.remaining).toBe(900)
		worker.settle(120)
		expect(root.remaining).toBe(880)
		expect(worker.ownTokens).toBe(120)
	})

	it('preserves full usage fields including reasoning as a subset of completion', async () => {
		const root = create(1_000)
		const request = await root.beginRequest()
		const measured = {
			promptTokens: 100,
			completionTokens: 40,
			totalTokens: 140,
			cachedTokens: 30,
			cacheWriteTokens: 10,
			reasoningTokens: 25,
		}
		await root.finishRequest(request, measured)
		root.recordUsage(measured)
		expect(root.ownUsage).toEqual(measured)
		const detached = root.ownUsage
		detached.totalTokens = 999
		expect(root.ownTokens).toBe(140)
	})

	it('binds an account to one turn and refuses spending an unbound reservation', async () => {
		const root = create(1_000)
		const worker = root.reserve(500)
		await expect(worker.beginRequest()).rejects.toThrow('not bound')
		expect(() => worker.settle(10)).toThrow('Unbound')
		expect(() => worker.recordUsage(usage(1))).toThrow('not bound')
		expect(() => worker.bindTurn(root.scope.rootSessionId, root.scope.rootTurnId)).toThrow(
			'another token budget',
		)
		expect(() => worker.bindTurn('nope' as never, generateTurnId())).toThrow('UUID')
		const session = generateSessionId()
		const turn = generateTurnId()
		worker.bindTurn(session, turn)
		worker.bindTurn(session, turn)
		expect(() => worker.bindTurn(session, generateTurnId())).toThrow('immutable')
		expect(() => worker.bindTurn(generateSessionId(), turn)).toThrow('immutable')
		expect(root.findTurn(turn)?.accountId).toBe(worker.accountId)
		expect(root.findTurn(generateTurnId())).toBeUndefined()
		const settled = root.reserve(10)
		settled.settle()
		expect(() => settled.bindTurn(generateSessionId(), generateTurnId())).toThrow('settled')
	})

	it('has an explicit unlimited root while all child reservations stay finite', () => {
		const root = create(0)
		expect(root.remaining).toBe(Number.POSITIVE_INFINITY)
		expect(root.summary().remainingTokens).toBeNull()
		const worker = child(root, 1_000)
		expect(worker.remaining).toBe(1_000)
		expect(() => root.reserve(Number.POSITIVE_INFINITY)).toThrow('safe integer')
	})

	it('refuses reservation sums that cannot be represented exactly, including on an unlimited root', () => {
		const root = create(0)
		child(root, Number.MAX_SAFE_INTEGER)
		expect(() => root.reserve(1)).toThrow('safe integer')
		expect(root.summary().reservedTokens).toBe(Number.MAX_SAFE_INTEGER)
		const valid = root.snapshot()
		const other = child(create(0), 1).snapshot().accounts.at(-1)
		if (!other) throw new Error('Expected another child account')
		valid.accounts.push({ ...other, parentId: root.accountId })
		expect(() => validateSessionTokenBudgetSnapshot(valid)).toThrow('safe integer')
	})

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid arithmetic inputs %s before state changes',
		(invalid) => {
			expect(() => create(invalid)).toThrow('safe integer')
			const root = create(1_000)
			expect(() => root.reserve(invalid)).toThrow('safe integer')
			expect(() => root.recordUsage(usage(invalid))).toThrow('safe integer')
			expect(() => root.settle(invalid)).toThrow('safe integer')
			expect(root.remaining).toBe(1_000)
			expect(() => root.reserve(0)).toThrow('cannot reserve')
		},
	)
})

describe('session token budget request durability', () => {
	it('writes the pending marker before admitting external work', async () => {
		const snapshots: SessionTokenBudgetSnapshot[] = []
		let release: (() => void) | undefined
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const root = SessionTokenBudget.create(1_000, scope(), {
			async save(snapshot) {
				await barrier
				snapshots.push(snapshot)
			},
		})
		let admitted = false
		const pending = root.beginRequest().then((request) => {
			admitted = true
			return request
		})
		await Promise.resolve()
		expect(admitted).toBe(false)
		release?.()
		const request = await pending
		expect(snapshots.at(-1)?.requests.map((entry) => entry.id)).toEqual([request])
		await root.finishRequest(request, usage(80))
		expect(snapshots.at(-1)?.completedRequests.map((entry) => entry.id)).toEqual([request])
		expect(snapshots.at(-1)?.requests).toHaveLength(0)
	})

	it('never spends a duplicated completion twice, including after cold restore', async () => {
		const root = create(1_000)
		const request = await spend(root, 120)
		await root.finishRequest(request, usage(120))
		await root.failRequest(request, usage(120))
		const restored = SessionTokenBudget.restore(root.snapshot())
		await restored.finishRequest(request, usage(120))
		expect(restored.ownTokens).toBe(120)
		const worker = child(restored, 100)
		await expect(worker.finishRequest(request, usage(120))).rejects.toThrow('another account')
		await expect(worker.finishRequest('unknown', usage(1))).rejects.toThrow('Unknown')
	})

	it('retains partial failed-request usage, rather than refunding unknown spend', async () => {
		const root = create(1_000)
		const worker = child(root, 500)
		const request = await worker.beginRequest()
		await worker.failRequest(request, usage(100))
		await worker.failRequest(request, usage(100))
		worker.settle()
		expect(root.treeTokens).toBe(100)
		expect(root.summary()).toMatchObject({
			poisoned: true,
			remainingTokens: 0,
			inFlightRequests: 1,
		})
		const restored = SessionTokenBudget.restore(root.snapshot())
		const reopened = restored.account(worker.accountId)
		await reopened.failRequest(request, usage(100))
		expect(restored.treeTokens).toBe(100)
		await reopened.finishRequest(request, usage(140))
		expect(restored.treeTokens).toBe(140)
		expect(restored.summary().inFlightRequests).toBe(0)
		await expect(restored.beginRequest()).rejects.toThrow('unresolved')
	})

	it('reopens a cold uncertain ledger only after explicit final-receipt reconciliation', async () => {
		const root = create(1_000)
		const request = await root.beginRequest()
		await root.failRequest(request, usage(100))
		const saved: SessionTokenBudgetSnapshot[] = []
		const restored = SessionTokenBudget.restore(root.snapshot(), {
			async save(snapshot) {
				saved.push(snapshot)
			},
		})
		expect(restored.binding).toEqual({ ...root.scope, accountId: root.accountId })
		await restored.finishRequest(request, usage(140))
		expect(restored.summary().poisoned).toBe(true)
		await expect(restored.beginRequest()).rejects.toThrow('unresolved')
		await restored.reconcileRequest(request, usage(160))
		await restored.reconcileRequest(request, usage(160))
		expect(restored.ownTokens).toBe(160)
		expect(restored.remaining).toBe(840)
		expect(saved.at(-1)?.poisoned).not.toBe(true)
		const durable = saved.at(-1)
		if (!durable) throw new Error('Expected persisted reconciliation')
		const reopened = SessionTokenBudget.restore(durable)
		await spend(reopened, 40)
		expect(reopened.ownTokens).toBe(200)
		expect(reopened.summary()).toMatchObject({ poisoned: false, inFlightRequests: 0 })
	})

	it('keeps every branch blocked until all uncertain requests are reconciled', async () => {
		const root = create(1_000)
		const first = child(root, 300)
		const second = child(root, 300)
		const [firstRequest, secondRequest] = await Promise.all([
			first.beginRequest(),
			second.beginRequest(),
		])
		await first.failRequest(firstRequest, usage(50))
		const restored = SessionTokenBudget.restore(root.snapshot())
		await restored.account(first.accountId).reconcileRequest(firstRequest, usage(100))
		expect(restored.treeTokens).toBe(100)
		expect(restored.summary()).toMatchObject({ poisoned: true, inFlightRequests: 1 })
		await expect(restored.beginRequest()).rejects.toThrow('unresolved')
		await restored.account(second.accountId).reconcileRequest(secondRequest, usage(150))
		expect(restored.treeTokens).toBe(250)
		expect(restored.summary()).toMatchObject({ poisoned: false, inFlightRequests: 0 })
		expect(restored.remaining).toBe(400)
	})

	it('normalizes partial prompt/output counts without adding reasoning twice', async () => {
		const root = create(1_000)
		const request = await root.beginRequest()
		await root.failRequest(request, { ...EMPTY_TOKEN_USAGE, totalTokens: 150 })
		await root.finishRequest(request, {
			...EMPTY_TOKEN_USAGE,
			promptTokens: 100,
			completionTokens: 60,
			totalTokens: 160,
			reasoningTokens: 40,
		})
		expect(root.ownUsage).toMatchObject({
			totalTokens: 160,
			promptTokens: 100,
			completionTokens: 60,
			reasoningTokens: 40,
		})
	})

	it('blocks every account when a crash leaves any request unresolved', async () => {
		const root = create(1_000)
		const first = child(root, 300)
		const second = child(root, 300)
		await first.beginRequest()
		const restored = SessionTokenBudget.restore(root.snapshot())
		expect(restored.remaining).toBe(0)
		expect(restored.account(second.accountId).remaining).toBe(0)
		await expect(restored.account(second.accountId).beginRequest()).rejects.toThrow('unresolved')
		expect(restored.summary().reservedTokens).toBe(600)
	})

	it('preserves the durable pending marker if charging usage cannot be persisted', async () => {
		let durable: SessionTokenBudgetSnapshot | undefined
		let fail = false
		const root = SessionTokenBudget.create(1_000, scope(), {
			async save(snapshot) {
				if (fail) throw new Error('disk unavailable')
				durable = snapshot
			},
		})
		const request = await root.beginRequest()
		fail = true
		await expect(root.finishRequest(request, usage(100))).rejects.toThrow('disk unavailable')
		expect(root.ownTokens).toBe(100)
		expect(root.remaining).toBe(0)
		await expect(root.reconcileRequest(request, usage(100))).rejects.toThrow('disk unavailable')
		expect(root.summary().poisoned).toBe(true)
		await expect(root.flush()).rejects.toThrow('disk unavailable')
		expect(durable?.requests).toHaveLength(1)
		if (!durable) throw new Error('Expected pending durable ledger')
		expect(SessionTokenBudget.restore(durable).remaining).toBe(0)
	})

	it('rejects admission before contact when the marker cannot be persisted', async () => {
		const root = SessionTokenBudget.create(1_000, scope(), {
			async save() {
				throw undefined
			},
		})
		await expect(root.beginRequest()).rejects.toThrow('persistence failed')
		expect(root.ownTokens).toBe(0)
		expect(root.remaining).toBe(0)
	})

	it('poisons all admission when provider usage is invalid', async () => {
		const root = create(1_000)
		const request = await root.beginRequest()
		await expect(root.finishRequest(request, usage(Number.NaN))).rejects.toThrow('safe integer')
		expect(root.remaining).toBe(0)
		expect(root.snapshot().requests).toHaveLength(1)
		const other = create(1_000)
		const failing = await other.beginRequest()
		await expect(other.failRequest(failing, usage(-1))).rejects.toThrow('safe integer')
		expect(other.summary().poisoned).toBe(true)
	})

	it('gives every descendant a defensive binding to the root key, only when persisted', () => {
		const key = scope()
		const root = SessionTokenBudget.create(1_000, key, { async save() {} })
		const worker = child(root, 100)
		expect(worker.binding).toEqual({ ...key, accountId: worker.accountId })
		const binding = worker.binding
		if (!binding) throw new Error('Expected root binding')
		Object.assign(binding, { rootTurnId: generateTurnId() })
		expect(root.binding?.rootTurnId).toBe(key.rootTurnId)
		expect(create(100).binding).toBeUndefined()
		const turn = root.turn
		if (!turn) throw new Error('Expected root turn')
		turn.turnId = generateTurnId()
		expect(root.turnId).toBe(key.rootTurnId)
	})
})

describe('session token budget snapshot ingress', () => {
	it('returns a defensive copy with request receipts and measured usage intact', async () => {
		const root = create(1_000)
		await spend(root, 100)
		const snapshot = root.snapshot()
		const validated = validateSessionTokenBudgetSnapshot(snapshot)
		expect(validated).toEqual(snapshot)
		const first = validated.accounts[0]
		if (!first) throw new Error('Expected root account')
		first.limit = 10
		expect(root.limit).toBe(1_000)
		expect(snapshot.accounts[0]?.limit).toBe(1_000)
	})

	it('rejects broken topology, duplicate identity and unknown request owners', async () => {
		const root = create(1_000)
		const worker = child(root, 400)
		await worker.beginRequest()
		const cases: Array<(snapshot: SessionTokenBudgetSnapshot) => void> = [
			(snapshot) => {
				snapshot.accounts.push({ ...snapshot.accounts[0]! })
			},
			(snapshot) => {
				snapshot.accounts[1]!.parentId = generateTurnId()
			},
			(snapshot) => {
				snapshot.accounts[1]!.parentId = worker.accountId
			},
			(snapshot) => {
				snapshot.accounts[1]!.turn = snapshot.accounts[0]!.turn
				snapshot.accounts[1]!.usage = { ...snapshot.accounts[0]!.usage }
			},
			(snapshot) => {
				snapshot.requests[0]!.accountId = root.accountId
			},
			(snapshot) => {
				snapshot.requests[0]!.usage = usage(500)
			},
			(snapshot) => {
				snapshot.requests[0]!.unresolved = 'yes' as never
			},
			(snapshot) => {
				snapshot.completedRequests.push({ ...snapshot.requests[0]! })
			},
			(snapshot) => {
				snapshot.requests.push({ ...snapshot.requests[0]!, id: generateTurnId() })
			},
		]
		for (const mutate of cases) {
			const snapshot = root.snapshot()
			mutate(snapshot)
			expect(() => validateSessionTokenBudgetSnapshot(snapshot)).toThrow()
		}
	})
})
