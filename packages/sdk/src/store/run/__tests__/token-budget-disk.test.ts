import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import type { TokenBudgetSnapshot } from '../../../run/token-budget.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import type { TokenUsage } from '../../../types/common/index.js'
import {
	type TokenBudgetScope,
	type TokenBudgetStore,
	validateTokenBudgetBinding,
} from '../../../types/run/token-budget-store.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../../utils/id.js'
import { DiskTokenBudgetStore, openTokenBudget } from '../token-budget-disk.js'

let baseDir: string
let scope: TokenBudgetScope
let snapshot: TokenBudgetSnapshot

function usage(totalTokens: number): TokenUsage {
	return {
		promptTokens: totalTokens,
		completionTokens: 0,
		totalTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), 'namzu-token-ledger-'))
	scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		runId: generateRunId(),
	}
	const rootAccountId = generateRunId()
	const childRunId = generateRunId()
	snapshot = {
		version: 1,
		rootAccountId,
		rootRunId: scope.runId,
		accounts: [
			{
				id: rootAccountId,
				limit: 1_000,
				settled: false,
				runId: scope.runId,
				usage: { [scope.runId]: usage(100) },
			},
			{
				id: generateRunId(),
				parentId: rootAccountId,
				limit: 400,
				settled: false,
				runId: childRunId,
				usage: { [childRunId]: usage(150) },
			},
		],
		requests: [],
		completedRequests: [],
	}
})

afterEach(async () => {
	await removeTempDirAsync(baseDir)
})

describe('a root token ledger survives a process boundary', () => {
	it('settles a restored child once and never charges its durable completed request twice', async () => {
		const root = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			limit: 1_000,
		})
		root.recordUsage(usage(100))
		const child = root.reserve(400)
		child.bindRun(generateRunId())
		const request = await child.beginRequest()
		await child.finishRequest(request, usage(150))
		const accountId = child.binding!.accountId
		const restored = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			requireExisting: true,
		})
		expect(restored.remaining).toBe(500)
		const restoredChild = restored.account(accountId)
		await restoredChild.finishRequest(request, usage(150))
		restoredChild.settle(150)
		restoredChild.settle(150)
		await restored.flush()
		const final = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			requireExisting: true,
		})
		expect(final.treeTokens).toBe(250)
		expect(final.remaining).toBe(750)
	})

	it('preserves partial usage and refuses further calls after transport loss and cold reopen', async () => {
		const root = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			limit: 1_000,
		})
		const request = await root.beginRequest()
		await root.failRequest(request, usage(70))
		const restored = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			requireExisting: true,
		})
		expect(restored.ownTokens).toBe(70)
		expect(restored.remaining).toBe(0)
		await expect(restored.beginRequest()).rejects.toThrow()
		expect(restored.snapshot().requests).toEqual([
			{ id: request, accountId: restored.binding!.accountId, runId: scope.runId, usage: usage(70) },
		])
	})

	it('persists explicit host reconciliation and never clears unresolved sibling spend', async () => {
		const root = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			limit: 1_000,
		})
		const child = root.reserve(400)
		child.bindRun(generateRunId())
		const rootRequest = await root.beginRequest()
		const childRequest = await child.beginRequest()
		await root.failRequest(rootRequest, usage(70))
		await child.failRequest(childRequest, usage(30))
		const restored = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			requireExisting: true,
		})
		await restored.reconcileRequest(rootRequest, usage(90))
		expect(restored.snapshot().poisoned).toBe(true)
		await expect(restored.beginRequest()).rejects.toThrow()
		await restored.account(child.accountId).reconcileRequest(childRequest, usage(50))
		const reconciled = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			requireExisting: true,
		})
		expect(reconciled.snapshot().poisoned).toBeUndefined()
		expect(reconciled.treeTokens).toBe(140)
		expect(reconciled.remaining).toBe(510)
		const next = await reconciled.beginRequest()
		await reconciled.finishRequest(next, usage(10))
		expect(reconciled.treeTokens).toBe(150)
	})

	it('reopens own spend and outstanding child grants without a checkpoint', async () => {
		await new DiskTokenBudgetStore({ baseDir }).save(scope, snapshot)
		const reopened = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			limit: 1_000,
			requireExisting: true,
		})
		expect(reopened.snapshot()).toEqual(snapshot)
		expect(reopened.binding).toEqual({ scope, accountId: snapshot.rootAccountId })
	})

	it('restores a child account from the root ledger without comparing child cap to root cap', async () => {
		await new DiskTokenBudgetStore({ baseDir }).save(scope, snapshot)
		const child = snapshot.accounts[1]!
		const reopened = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			accountId: child.id,
			requireExisting: true,
		})
		expect(reopened.binding).toEqual({ scope, accountId: child.id })
		expect(reopened.snapshot().accounts).toEqual(snapshot.accounts)
	})

	it('retains unresolved request evidence and poisons new admission after reopening', async () => {
		const child = snapshot.accounts[1]!
		const pending: TokenBudgetSnapshot = {
			...snapshot,
			requests: [{ id: generateRunId(), accountId: child.id, runId: child.runId! }],
		}
		await new DiskTokenBudgetStore({ baseDir }).save(scope, pending)
		const reopened = await openTokenBudget({
			store: new DiskTokenBudgetStore({ baseDir }),
			scope,
			requireExisting: true,
		})
		expect(reopened.snapshot().poisoned).toBe(true)
		expect(reopened.snapshot().requests).toEqual(pending.requests)
		expect(reopened.snapshot().accounts).toEqual(pending.accounts)
	})

	it('does not mint a new allowance if a checkpoint references a missing ledger or account', async () => {
		const store = new DiskTokenBudgetStore({ baseDir })
		await expect(
			openTokenBudget({ store, scope, limit: 1_000, requireExisting: true }),
		).rejects.toThrow('missing')
		expect(await store.load(scope)).toBeNull()
		await store.save(scope, snapshot)
		await expect(
			openTokenBudget({ store, scope, accountId: generateRunId(), requireExisting: true }),
		).rejects.toThrow()
		expect(await store.load(scope)).toEqual(snapshot)
	})

	it('rejects cap changes and mismatched root attribution without overwriting the record', async () => {
		const store = new DiskTokenBudgetStore({ baseDir })
		await store.save(scope, snapshot)
		await expect(openTokenBudget({ store, scope, limit: 2_000 })).rejects.toThrow('limit mismatch')
		await expect(store.load({ ...scope, tenantId: generateTenantId() })).rejects.toThrow(
			'scope mismatch',
		)
		await expect(store.load({ ...scope, projectId: generateProjectId() })).rejects.toThrow(
			'scope mismatch',
		)
		await expect(store.load({ ...scope, sessionId: generateSessionId() })).rejects.toThrow(
			'scope mismatch',
		)
		await expect(store.save(scope, { ...snapshot, rootRunId: generateRunId() })).rejects.toThrow()
		expect(await new DiskTokenBudgetStore({ baseDir }).load(scope)).toEqual(snapshot)
	})

	it('validates records from an injected backend and flushes initial creation before returning', async () => {
		const saved: TokenBudgetSnapshot[] = []
		const store: TokenBudgetStore = {
			load: async () => null,
			save: async (_scope, state) => {
				saved.push(structuredClone(state))
			},
		}
		const opened = await openTokenBudget({ store, scope, limit: 900 })
		expect(saved).toEqual([opened.snapshot()])
		await expect(
			openTokenBudget({
				store: { ...store, load: async () => ({ ...snapshot, rootRunId: generateRunId() }) },
				scope,
			}),
		).rejects.toThrow()
	})

	it('uses the same canonical session runs path for the default opener and direct store', async () => {
		const pathBuilder = new DefaultPathBuilder(baseDir)
		const opened = await openTokenBudget({ scope, limit: 800, pathBuilder })
		const store = new DiskTokenBudgetStore({
			baseDir: join(pathBuilder.sessionDir(scope.projectId, scope.sessionId), 'runs'),
		})
		expect(await store.load(scope)).toEqual(opened.snapshot())
	})
})

describe('durable token records refuse damage', () => {
	it('requires measured completion receipts before clearing a poisoned ledger', async () => {
		const store = new DiskTokenBudgetStore({ baseDir })
		const request = { id: generateRunId(), accountId: snapshot.rootAccountId, runId: scope.runId }
		const pending = { ...snapshot, poisoned: true, requests: [request] }
		await store.save(scope, pending)
		await expect(store.save(scope, { ...pending, poisoned: false })).rejects.toThrow(
			'unresolved requests',
		)
		await expect(store.save(scope, { ...snapshot, completedRequests: [request] })).rejects.toThrow(
			'without a completion receipt',
		)
		await expect(store.save(scope, snapshot)).rejects.toThrow('without a completion receipt')
		expect(await new DiskTokenBudgetStore({ baseDir }).load(scope)).toEqual(pending)
		const reconciled = {
			...snapshot,
			completedRequests: [{ ...request, usage: usage(100) }],
		}
		await store.save(scope, reconciled)
		expect(await new DiskTokenBudgetStore({ baseDir }).load(scope)).toEqual(reconciled)
	})

	it('retains request ownership until an atomic durable completion receipt replaces it', async () => {
		const store = new DiskTokenBudgetStore({ baseDir })
		const request = { id: generateRunId(), accountId: snapshot.rootAccountId, runId: scope.runId }
		await store.save(scope, { ...snapshot, requests: [request] })
		await expect(store.save(scope, snapshot)).rejects.toThrow('without a completion receipt')
		const completed = { ...snapshot, completedRequests: [request] }
		await store.save(scope, completed)
		await expect(store.save(scope, snapshot)).rejects.toThrow('completion receipt')
		expect(await new DiskTokenBudgetStore({ baseDir }).load(scope)).toEqual(completed)
	})

	it('serializes own writes and snapshots caller data before an asynchronous save', async () => {
		const store = new DiskTokenBudgetStore({ baseDir })
		const first = structuredClone(snapshot)
		const second = structuredClone(snapshot)
		second.accounts[0]!.usage[scope.runId] = usage(200)
		const writes = [store.save(scope, first), store.save(scope, second)]
		first.accounts[0]!.usage[scope.runId] = usage(0)
		second.accounts[0]!.usage[scope.runId] = usage(0)
		await Promise.all(writes)
		const loaded = await new DiskTokenBudgetStore({ baseDir }).load(scope)
		expect(loaded?.accounts[0]?.usage[scope.runId]?.totalTokens).toBe(200)
	})

	it('refuses a stale snapshot that reduces spend or drops a child grant', async () => {
		const store = new DiskTokenBudgetStore({ baseDir })
		await store.save(scope, snapshot)
		const resetSpend = structuredClone(snapshot)
		resetSpend.accounts[0]!.usage[scope.runId] = usage(0)
		await expect(store.save(scope, resetSpend)).rejects.toThrow('reduce recorded')
		await expect(
			store.save(scope, { ...snapshot, accounts: [snapshot.accounts[0]!] }),
		).rejects.toThrow('remove an existing')
		expect(await new DiskTokenBudgetStore({ baseDir }).load(scope)).toEqual(snapshot)
	})

	it('leaves no sidecars and uses owner-only permissions for new records and directories', async () => {
		await new DiskTokenBudgetStore({ baseDir }).save(scope, snapshot)
		const directory = join(baseDir, scope.runId)
		expect(await readdir(directory)).toEqual(['token-budget.json'])
		if (process.platform !== 'win32') {
			expect((await stat(directory)).mode & 0o777).toBe(0o700)
			expect((await stat(join(directory, 'token-budget.json'))).mode & 0o777).toBe(0o600)
		}
	})

	it.each(['broken JSON', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1 })])(
		'refuses malformed or future records: %s',
		async (damaged) => {
			const store = new DiskTokenBudgetStore({ baseDir })
			await store.save(scope, snapshot)
			const path = join(baseDir, scope.runId, 'token-budget.json')
			await writeFile(path, damaged)
			await expect(new DiskTokenBudgetStore({ baseDir }).load(scope)).rejects.toThrow()
			await expect(openTokenBudget({ store, scope, limit: 1_000 })).rejects.toThrow()
			expect(await readFile(path, 'utf8')).toBe(damaged)
		},
	)

	it('validates and copies checkpoint budget references', () => {
		const binding = { scope, accountId: snapshot.rootAccountId }
		const checked = validateTokenBudgetBinding(binding)
		expect(checked).toEqual(binding)
		expect(checked.scope).not.toBe(scope)
		for (const value of [null, {}, { scope, accountId: '../escape' }, { ...binding, scope: {} }]) {
			expect(() => validateTokenBudgetBinding(value)).toThrow()
		}
	})
})
