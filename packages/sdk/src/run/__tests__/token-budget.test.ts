import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import type { TokenUsage } from '../../types/common/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import {
	TokenBudget,
	type TokenBudgetSnapshot,
	validateTokenBudgetSnapshot,
} from '../token-budget.js'

const usage = (totalTokens: number): TokenUsage => ({
	...EMPTY_TOKEN_USAGE,
	promptTokens: totalTokens,
	totalTokens,
})

function child(parent: TokenBudget, tokens: number): TokenBudget {
	const budget = parent.reserve(tokens)
	budget.bindRun(generateRunId())
	return budget
}

async function spend(budget: TokenBudget, tokens: number): Promise<string> {
	const request = await budget.beginRequest()
	await budget.finishRequest(request, usage(tokens))
	return request
}

describe('a scoped token budget', () => {
	it('conserves measured usage and unspent reservations for arbitrary concurrent completions', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 350 }), fc.boolean()), {
					minLength: 3,
					maxLength: 3,
				}),
				async (outcomes) => {
					const root = TokenBudget.create(1_000, generateRunId())
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
			{ seed: 34797, numRuns: 100 },
		)
	})

	it('conserves parent, child and grandchild spend without charging descendants twice', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
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
		})
		expect(worker.summary()).toMatchObject({ ownTokens: 100, treeTokens: 150 })
	})

	it('serializes reservation arithmetic before concurrent provisioning can await', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const outcomes = await Promise.allSettled([1, 2].map(async () => child(root, 600)))
		expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1)
		expect(root.remaining).toBe(400)
	})

	it('does not let a grandchild escape the immediate parent allocation', () => {
		const root = TokenBudget.create(10_000, generateRunId())
		const worker = child(root, 100)
		expect(() => worker.reserve(101)).toThrow('cannot reserve')
		expect(() => worker.account(root.accountId)).toThrow('outside this subtree')
		expect(worker.findRun(root.rootRunId)).toBeUndefined()
		expect(root.remaining).toBe(9_900)
	})

	it('narrows the full descendant budget and returns the unused reservation difference', () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const worker = child(root, 500)
		worker.narrow(200)
		expect(root.remaining).toBe(800)
		expect(worker.remaining).toBe(200)
		expect(() => worker.reserve(201)).toThrow('cannot reserve')
		worker.narrow(0)
		expect(worker.limit).toBe(200)
		expect(() => worker.narrow(201)).toThrow('cannot widen')
		const unlimited = TokenBudget.create(0, generateRunId())
		unlimited.narrow(100)
		expect(unlimited.remaining).toBe(100)
	})

	it('keeps narrowing debt and existing descendant accounts across restore', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const worker = child(root, 500)
		const grandchild = child(worker, 400)
		await spend(grandchild, 200)
		worker.narrow(100)
		expect(grandchild.remaining).toBe(0)
		expect(root.treeTokens).toBe(200)
		const restored = TokenBudget.restore(root.snapshot())
		expect(restored.account(grandchild.accountId).remaining).toBe(0)
		expect(restored.remaining).toBe(800)
	})

	it('keeps reserved child headroom usable when the parent has none unreserved', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
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
		const root = TokenBudget.create(1_000, generateRunId())
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

	it('propagates ancestor debt through more than one reserved edge', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const worker = child(root, 800)
		const grandchild = child(worker, 600)
		await spend(root, 450)
		await spend(worker, 50)
		expect(grandchild.remaining).toBe(500)
		expect(root.treeTokens).toBe(500)
	})

	it('retains an ended parent reservation until its descendants settle', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
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
		const root = TokenBudget.create(1_000, generateRunId())
		const worker = child(root, 500)
		const request = await worker.beginRequest()
		worker.settle()
		expect(root.remaining).toBe(500)
		await worker.finishRequest(request, usage(75))
		expect(root.remaining).toBe(925)
		expect(worker.remaining).toBe(0)
	})

	it('refuses reservation or another request during the same account provider call', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const request = await root.beginRequest()
		expect(() => root.reserve(10)).toThrow('in-flight')
		await expect(root.beginRequest()).rejects.toThrow('in-flight')
		await root.finishRequest(request, usage(10))
		expect(root.reserve(990).limit).toBe(990)
	})

	it('admits requests concurrently in separately reserved child accounts', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const first = child(root, 400)
		const second = child(root, 400)
		await Promise.all([spend(first, 100), spend(second, 200)])
		expect(root.treeTokens).toBe(300)
		expect(root.remaining).toBe(200)
	})

	it('max-reconciles cumulative run totals and idempotent settlement', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
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
		const root = TokenBudget.create(1_000, generateRunId())
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

	it('binds a scope to one run and refuses spending an unbound reservation', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const worker = root.reserve(500)
		await expect(worker.beginRequest()).rejects.toThrow('not bound')
		expect(() => worker.settle(10)).toThrow('Unbound')
		expect(() => worker.bindRun(root.rootRunId)).toThrow('another token budget')
		const runId = generateRunId()
		worker.bindRun(runId)
		worker.bindRun(runId)
		expect(() => worker.bindRun(generateRunId())).toThrow('immutable')
		expect(root.findRun(runId)?.accountId).toBe(worker.accountId)
		expect(root.findRun(generateRunId())).toBeUndefined()
	})

	it('has an explicit unlimited root while all child reservations stay finite', () => {
		const root = TokenBudget.create(0, generateRunId())
		expect(root.remaining).toBe(Number.POSITIVE_INFINITY)
		expect(root.summary().remainingTokens).toBeNull()
		expect(JSON.parse(JSON.stringify(root.summary())).remainingTokens).toBeNull()
		const worker = child(root, 1_000)
		expect(worker.remaining).toBe(1_000)
		expect(() => root.reserve(Number.POSITIVE_INFINITY)).toThrow('safe integer')
	})

	it('refuses reservation sums that cannot be represented exactly, including on an unlimited root', () => {
		const root = TokenBudget.create(0, generateRunId())
		child(root, Number.MAX_SAFE_INTEGER)
		expect(() => root.reserve(1)).toThrow('safe integer')
		expect(root.summary().reservedTokens).toBe(Number.MAX_SAFE_INTEGER)
		const valid = root.snapshot()
		const other = child(TokenBudget.create(0, generateRunId()), 1).snapshot().accounts.at(-1)
		if (!other) throw new Error('Expected another child account')
		valid.accounts.push({ ...other, parentId: root.accountId })
		expect(() => validateTokenBudgetSnapshot(valid)).toThrow('safe integer')
	})

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid arithmetic inputs %s before state changes',
		(invalid) => {
			expect(() => TokenBudget.create(invalid, generateRunId())).toThrow('safe integer')
			const root = TokenBudget.create(1_000, generateRunId())
			expect(() => root.reserve(invalid)).toThrow('safe integer')
			expect(() => root.recordUsage(usage(invalid))).toThrow('safe integer')
			expect(root.remaining).toBe(1_000)
			expect(() => root.reserve(0)).toThrow('cannot reserve')
		},
	)
})

describe('token budget request durability', () => {
	it('writes the pending marker before admitting external work', async () => {
		const snapshots: TokenBudgetSnapshot[] = []
		let release: (() => void) | undefined
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const root = TokenBudget.create(1_000, generateRunId(), {
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

	it('preserves the same account and reservation across a cold restore', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		await spend(root, 100)
		const worker = child(root, 400)
		await spend(worker, 50)
		const restored = TokenBudget.restore(root.snapshot())
		expect(restored.remaining).toBe(500)
		const reopened = restored.account(worker.accountId)
		expect(reopened.ownTokens).toBe(50)
		expect(reopened.remaining).toBe(350)
		reopened.settle(50)
		expect(restored.remaining).toBe(850)
	})

	it('never spends a duplicated completion twice, including after cold restore', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const request = await spend(root, 120)
		await root.finishRequest(request, usage(120))
		const restored = TokenBudget.restore(root.snapshot())
		await restored.finishRequest(request, usage(120))
		expect(restored.ownTokens).toBe(120)
		const worker = child(restored, 100)
		await expect(worker.finishRequest(request, usage(120))).rejects.toThrow('another account')
	})

	it('retains partial failed-request usage, rather than refunding unknown spend', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
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
		const restored = TokenBudget.restore(root.snapshot())
		const reopened = restored.account(worker.accountId)
		await reopened.failRequest(request, usage(100))
		expect(restored.treeTokens).toBe(100)
		await reopened.finishRequest(request, usage(140))
		expect(restored.treeTokens).toBe(140)
		expect(restored.summary().inFlightRequests).toBe(0)
		await expect(restored.beginRequest()).rejects.toThrow('unresolved')
	})

	it('reopens a cold uncertain ledger only after explicit final-receipt reconciliation', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const request = await root.beginRequest()
		await root.failRequest(request, usage(100))
		const saved: TokenBudgetSnapshot[] = []
		const restored = TokenBudget.restore(root.snapshot(), {
			async save(snapshot) {
				saved.push(snapshot)
			},
		})
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
		const reopened = TokenBudget.restore(durable)
		await spend(reopened, 40)
		expect(reopened.ownTokens).toBe(200)
		expect(reopened.summary()).toMatchObject({ poisoned: false, inFlightRequests: 0 })
	})

	it('keeps every branch blocked until all uncertain requests are reconciled', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const first = child(root, 300)
		const second = child(root, 300)
		const [firstRequest, secondRequest] = await Promise.all([
			first.beginRequest(),
			second.beginRequest(),
		])
		await first.failRequest(firstRequest, usage(50))
		const restored = TokenBudget.restore(root.snapshot())
		await restored.account(first.accountId).reconcileRequest(firstRequest, usage(100))
		expect(restored.treeTokens).toBe(100)
		expect(restored.summary()).toMatchObject({ poisoned: true, inFlightRequests: 1 })
		await expect(restored.beginRequest()).rejects.toThrow('unresolved')
		await restored.account(second.accountId).reconcileRequest(secondRequest, usage(150))
		expect(restored.treeTokens).toBe(250)
		expect(restored.summary()).toMatchObject({ poisoned: false, inFlightRequests: 0 })
		expect(restored.remaining).toBe(400)
		expect(restored.account(first.accountId).remaining).toBe(200)
		expect(restored.account(second.accountId).remaining).toBe(150)
	})

	it('normalizes partial prompt/output counts without adding reasoning twice', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
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
		const root = TokenBudget.create(1_000, generateRunId())
		const first = child(root, 300)
		const second = child(root, 300)
		await first.beginRequest()
		const restored = TokenBudget.restore(root.snapshot())
		expect(restored.remaining).toBe(0)
		expect(restored.account(second.accountId).remaining).toBe(0)
		await expect(restored.account(second.accountId).beginRequest()).rejects.toThrow('unresolved')
		expect(restored.summary().reservedTokens).toBe(600)
	})

	it('preserves the durable pending marker if charging usage cannot be persisted', async () => {
		let durable: TokenBudgetSnapshot | undefined
		let fail = false
		const root = TokenBudget.create(1_000, generateRunId(), {
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
		expect(TokenBudget.restore(durable).remaining).toBe(0)
	})

	it('rejects admission before contact when the marker cannot be persisted', async () => {
		const root = TokenBudget.create(1_000, generateRunId(), {
			async save() {
				throw new Error('write denied')
			},
		})
		await expect(root.beginRequest()).rejects.toThrow('write denied')
		expect(root.ownTokens).toBe(0)
		expect(root.remaining).toBe(0)
	})

	it('poisons all admission when provider usage is invalid', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const request = await root.beginRequest()
		await expect(root.finishRequest(request, usage(Number.NaN))).rejects.toThrow('safe integer')
		expect(root.remaining).toBe(0)
		expect(root.snapshot().requests).toHaveLength(1)
	})

	it('inherits a defensive root persistence binding for every descendant', () => {
		const runId = generateRunId()
		const scope = {
			runId,
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
		}
		const root = TokenBudget.create(1_000, runId, { scope, async save() {} })
		const worker = child(root, 100)
		expect(worker.binding).toEqual({ scope, accountId: worker.accountId })
		const binding = worker.binding
		if (!binding) throw new Error('Expected root binding')
		Object.assign(binding.scope, { runId: generateRunId() })
		expect(root.binding?.scope.runId).toBe(runId)
		expect(TokenBudget.create(100, generateRunId()).binding).toBeUndefined()
	})
})

describe('token budget snapshot ingress', () => {
	it('returns a defensive copy with request receipts and measured usage intact', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		await spend(root, 100)
		const snapshot = root.snapshot()
		const validated = validateTokenBudgetSnapshot(snapshot)
		expect(validated).toEqual(snapshot)
		const first = validated.accounts[0]
		if (!first) throw new Error('Expected root account')
		first.limit = 10
		expect(root.limit).toBe(1_000)
		expect(snapshot.accounts[0]?.limit).toBe(1_000)
	})

	it('rejects broken topology, duplicate identity and unknown request owners', async () => {
		const root = TokenBudget.create(1_000, generateRunId())
		const worker = child(root, 400)
		await worker.beginRequest()
		const cases: Array<(snapshot: TokenBudgetSnapshot) => void> = [
			(snapshot) => {
				snapshot.version = 2 as 1
			},
			(snapshot) => {
				snapshot.accounts.push({ ...snapshot.accounts[0]! })
			},
			(snapshot) => {
				snapshot.accounts[1]!.parentId = generateRunId()
			},
			(snapshot) => {
				snapshot.accounts[1]!.parentId = worker.accountId
			},
			(snapshot) => {
				snapshot.accounts[1]!.limit = 0
			},
			(snapshot) => {
				snapshot.accounts[1]!.runId = root.rootRunId
			},
			(snapshot) => {
				snapshot.requests[0]!.accountId = root.accountId
			},
			(snapshot) => {
				snapshot.requests[0]!.usage = usage(500)
			},
			(snapshot) => {
				snapshot.completedRequests.push({ ...snapshot.requests[0]! })
			},
		]
		for (const mutate of cases) {
			const snapshot = root.snapshot()
			mutate(snapshot)
			expect(() => validateTokenBudgetSnapshot(snapshot)).toThrow()
		}
	})
})
