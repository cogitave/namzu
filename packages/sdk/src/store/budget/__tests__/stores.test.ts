import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { SessionPaths } from '../../../session/paths.js'
import type { TokenUsage } from '../../../types/common/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { uuidv7 } from '../../../utils/uuidv7.js'
import {
	DiskSessionTokenBudgetStore,
	type SessionTokenBudgetStore,
	openSessionTokenBudget,
} from '../disk.js'
import {
	SessionTokenBudget,
	type SessionTokenBudgetScope,
	type SessionTokenBudgetSnapshot,
	SessionTokenBudgetVersionError,
} from '../ledger.js'
import { InMemorySessionTokenBudgetStore } from '../memory.js'

function usage(totalTokens: number): TokenUsage {
	return {
		promptTokens: totalTokens,
		completionTokens: 0,
		totalTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

let home: string
let paths: SessionPaths
let scope: SessionTokenBudgetScope
let snapshot: SessionTokenBudgetSnapshot

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'namzu-session-ledger-'))
	paths = new SessionPaths({ home, slug: '-work-project' })
	scope = { rootSessionId: generateSessionId(), rootTurnId: generateTurnId() }
	const rootAccountId = uuidv7()
	const childSession = generateSessionId()
	const childTurn = generateTurnId()
	snapshot = {
		v: 2,
		kind: 'token-budget',
		rootSessionId: scope.rootSessionId,
		rootTurnId: scope.rootTurnId,
		limit: 1_000,
		rootAccountId,
		accounts: [
			{
				id: rootAccountId,
				limit: 1_000,
				settled: false,
				turn: { sessionId: scope.rootSessionId, turnId: scope.rootTurnId },
				usage: { [scope.rootTurnId]: usage(100) },
			},
			{
				id: uuidv7(),
				parentId: rootAccountId,
				limit: 400,
				settled: false,
				turn: { sessionId: childSession, turnId: childTurn },
				usage: { [childTurn]: usage(150) },
			},
		],
		requests: [],
		completedRequests: [],
	}
})

afterEach(async () => {
	await removeTempDirAsync(home)
})

const backends: [string, () => SessionTokenBudgetStore][] = [
	['disk', () => new DiskSessionTokenBudgetStore({ paths })],
	['memory', () => new InMemorySessionTokenBudgetStore()],
]

describe.each(backends)('%s session token budget store', (_name, make) => {
	it('shares one ledger across a three-level child session tree and reopens each account', async () => {
		const store = make()
		const root = await openSessionTokenBudget({ store, scope, limit: 1_000 })
		const worker = root.reserve(600)
		worker.bindTurn(generateSessionId(), generateTurnId())
		const grandchild = worker.reserve(300)
		grandchild.bindTurn(generateSessionId(), generateTurnId())
		const greatGrandchild = grandchild.reserve(100)
		const deepTurn = generateTurnId()
		greatGrandchild.bindTurn(generateSessionId(), deepTurn)
		const request = await greatGrandchild.beginRequest()
		await greatGrandchild.finishRequest(request, usage(70))
		await root.flush()
		const binding = greatGrandchild.binding
		if (!binding) throw new Error('Expected a persisted binding')
		expect(binding).toEqual({ ...scope, accountId: greatGrandchild.accountId })
		const reopened = await openSessionTokenBudget({
			store,
			scope: binding,
			accountId: binding.accountId,
			requireExisting: true,
		})
		expect(reopened.turnId).toBe(deepTurn)
		expect(reopened.ownTokens).toBe(70)
		expect(reopened.remaining).toBe(30)
		const whole = await openSessionTokenBudget({ store, scope, requireExisting: true })
		expect(whole.treeTokens).toBe(70)
		expect(whole.findTurn(deepTurn)?.accountId).toBe(greatGrandchild.accountId)
	})

	it('keeps two root turns of one session independent, with different limits', async () => {
		const store = make()
		const first = { rootSessionId: scope.rootSessionId, rootTurnId: generateTurnId() }
		const second = { rootSessionId: scope.rootSessionId, rootTurnId: generateTurnId() }
		const a = await openSessionTokenBudget({ store, scope: first, limit: 100 })
		const b = await openSessionTokenBudget({ store, scope: second, limit: 9_000 })
		const request = await a.beginRequest()
		await a.finishRequest(request, usage(100))
		expect((await store.load(first))?.limit).toBe(100)
		expect((await store.load(second))?.limit).toBe(9_000)
		expect((await store.load(second))?.accounts[0]?.usage[second.rootTurnId]?.totalTokens).toBe(0)
		expect(b.remaining).toBe(9_000)
		// The same key reopened with another limit is still refused: a new limit is a new turn.
		await expect(openSessionTokenBudget({ store, scope: first, limit: 200 })).rejects.toThrow(
			'limit mismatch',
		)
	})

	it('refuses a stale save that reduces spend, drops an account or swaps the root', async () => {
		const store = make()
		await store.save(scope, snapshot)
		const resetSpend = structuredClone(snapshot)
		resetSpend.accounts[0]!.usage[scope.rootTurnId] = usage(0)
		await expect(store.save(scope, resetSpend)).rejects.toThrow('reduce recorded')
		await expect(
			store.save(scope, { ...snapshot, accounts: [snapshot.accounts[0]!] }),
		).rejects.toThrow('remove an existing')
		const rebound = structuredClone(snapshot)
		rebound.accounts[1]!.turn!.sessionId = generateSessionId()
		await expect(store.save(scope, rebound)).rejects.toThrow('remove an existing')
		const reopenedSettled = structuredClone(snapshot)
		reopenedSettled.accounts[1]!.settled = true
		await store.save(scope, reopenedSettled)
		await expect(store.save(scope, snapshot)).rejects.toThrow('remove an existing')
		const otherRoot = structuredClone(reopenedSettled)
		const newRootId = uuidv7()
		otherRoot.rootAccountId = newRootId
		otherRoot.accounts[0]!.id = newRootId
		otherRoot.accounts[1]!.parentId = newRootId
		await expect(store.save(scope, otherRoot)).rejects.toThrow('different root')
		expect(await store.load(scope)).toEqual(reopenedSettled)
	})

	it('refuses a snapshot for another key and a version 1 snapshot', async () => {
		const store = make()
		await expect(store.save({ ...scope, rootTurnId: generateTurnId() }, snapshot)).rejects.toThrow(
			'root scope mismatch',
		)
		const legacy = {
			version: 1,
			rootAccountId: uuidv7(),
			accounts: [],
			requests: [],
			completedRequests: [],
		}
		await expect(
			store.save(scope, legacy as unknown as SessionTokenBudgetSnapshot),
		).rejects.toThrow(SessionTokenBudgetVersionError)
		await expect(store.load({ ...scope, rootSessionId: 'x' as never })).rejects.toThrow('UUID')
		expect(await store.load(scope)).toBeNull()
	})

	it('keeps receipts and unresolved requests until a completion receipt replaces them', async () => {
		const store = make()
		const request = { id: uuidv7(), accountId: snapshot.rootAccountId, turnId: scope.rootTurnId }
		await store.save(scope, { ...snapshot, requests: [{ ...request, unresolved: true }] })
		await expect(store.save(scope, { ...snapshot, requests: [request] })).rejects.toThrow(
			'unresolved',
		)
		await expect(store.save(scope, snapshot)).rejects.toThrow('without a completion receipt')
		const completed = { ...snapshot, completedRequests: [{ ...request, usage: usage(50) }] }
		await store.save(scope, completed)
		await expect(store.save(scope, snapshot)).rejects.toThrow('completion receipt')
		expect(await store.load(scope)).toEqual(completed)
	})

	it('requires measured receipts before clearing a poisoned ledger', async () => {
		const store = make()
		const request = { id: uuidv7(), accountId: snapshot.rootAccountId, turnId: scope.rootTurnId }
		const pending = { ...snapshot, poisoned: true, requests: [request] }
		await store.save(scope, pending)
		await expect(store.save(scope, { ...pending, poisoned: false })).rejects.toThrow(
			'unresolved requests',
		)
		await expect(store.save(scope, { ...snapshot, completedRequests: [request] })).rejects.toThrow(
			'without a completion receipt',
		)
		const reconciled = { ...snapshot, completedRequests: [{ ...request, usage: usage(100) }] }
		await store.save(scope, reconciled)
		expect(await store.load(scope)).toEqual(reconciled)
	})

	it('does not mint a new allowance when a binding names a missing ledger', async () => {
		const store = make()
		await expect(
			openSessionTokenBudget({ store, scope, limit: 1_000, requireExisting: true }),
		).rejects.toThrow('missing')
		await expect(openSessionTokenBudget({ store, scope, accountId: uuidv7() })).rejects.toThrow(
			'missing',
		)
		await expect(openSessionTokenBudget({ store, scope })).rejects.toThrow('explicit limit')
		expect(await store.load(scope)).toBeNull()
		await store.save(scope, snapshot)
		await expect(
			openSessionTokenBudget({ store, scope, accountId: uuidv7(), requireExisting: true }),
		).rejects.toThrow('outside this subtree')
	})

	it('copies records in and out', async () => {
		const store = make()
		const mine = structuredClone(snapshot)
		await store.save(scope, mine)
		mine.accounts[0]!.limit = 1
		const loaded = await store.load(scope)
		expect(loaded).toEqual(snapshot)
		loaded!.accounts[0]!.limit = 2
		expect(await store.load(scope)).toEqual(snapshot)
	})
})

describe('the disk session token budget store', () => {
	it('writes the snapshot itself to <root-session>/budgets/<root-turn>.json, owner-only', async () => {
		await new DiskSessionTokenBudgetStore({ paths }).save(scope, snapshot)
		const path = paths.budgetFile({ sessionId: scope.rootSessionId }, scope.rootTurnId)
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(snapshot)
		expect(await readdir(dirname(path))).toEqual([`${scope.rootTurnId}.json`])
		if (process.platform !== 'win32') {
			expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
			expect((await stat(path)).mode & 0o777).toBe(0o600)
		}
	})

	it('serializes its own writes and snapshots caller data before an asynchronous save', async () => {
		const store = new DiskSessionTokenBudgetStore({ paths })
		const first = structuredClone(snapshot)
		const second = structuredClone(snapshot)
		second.accounts[0]!.usage[scope.rootTurnId] = usage(200)
		const writes = [store.save(scope, first), store.save(scope, second)]
		first.accounts[0]!.usage[scope.rootTurnId] = usage(0)
		second.accounts[0]!.usage[scope.rootTurnId] = usage(0)
		await Promise.all(writes)
		const loaded = await new DiskSessionTokenBudgetStore({ paths }).load(scope)
		expect(loaded?.accounts[0]?.usage[scope.rootTurnId]?.totalTokens).toBe(200)
	})

	it('reads the latest record even while a refused save is still pending', async () => {
		const store = new DiskSessionTokenBudgetStore({ paths })
		await store.save(scope, snapshot)
		const stale = structuredClone(snapshot)
		stale.accounts[0]!.usage[scope.rootTurnId] = usage(0)
		const refused = store.save(scope, stale)
		const loaded = store.load(scope)
		await expect(refused).rejects.toThrow('reduce recorded')
		expect(await loaded).toEqual(snapshot)
	})

	it.each([
		['broken JSON', 'broken JSON', SyntaxError],
		[
			'version 1',
			JSON.stringify({ version: 1, rootAccountId: uuidv7() }),
			SessionTokenBudgetVersionError,
		],
		['another kind', JSON.stringify({ v: 2, kind: 'lease' }), SessionTokenBudgetVersionError],
	])(
		'refuses a damaged or foreign record (%s) without overwriting it',
		async (_name, damaged, error) => {
			const store = new DiskSessionTokenBudgetStore({ paths })
			await store.save(scope, snapshot)
			const path = paths.budgetFile({ sessionId: scope.rootSessionId }, scope.rootTurnId)
			await writeFile(path, damaged)
			await expect(new DiskSessionTokenBudgetStore({ paths }).load(scope)).rejects.toThrow(error)
			await expect(openSessionTokenBudget({ store, scope, limit: 1_000 })).rejects.toThrow()
			expect(await readFile(path, 'utf8')).toBe(damaged)
		},
	)

	it('refuses a record stored under another key', async () => {
		const store = new DiskSessionTokenBudgetStore({ paths })
		await store.save(scope, snapshot)
		const other = { rootSessionId: scope.rootSessionId, rootTurnId: generateTurnId() }
		const from = paths.budgetFile({ sessionId: scope.rootSessionId }, scope.rootTurnId)
		await writeFile(
			paths.budgetFile({ sessionId: other.rootSessionId }, other.rootTurnId),
			await readFile(from),
		)
		await expect(store.load(other)).rejects.toThrow('root scope mismatch')
	})

	it('validates records from an injected backend and flushes creation before returning', async () => {
		const saved: SessionTokenBudgetSnapshot[] = []
		const store: SessionTokenBudgetStore = {
			load: async () => null,
			save: async (_scope, state) => {
				saved.push(structuredClone(state))
			},
		}
		const opened = await openSessionTokenBudget({ store, scope, limit: 900 })
		expect(saved).toEqual([opened.snapshot()])
		const foreign = SessionTokenBudget.create(900, {
			rootSessionId: scope.rootSessionId,
			rootTurnId: generateTurnId(),
		}).snapshot()
		await expect(
			openSessionTokenBudget({ store: { ...store, load: async () => foreign }, scope }),
		).rejects.toThrow('root scope mismatch')
	})
})
