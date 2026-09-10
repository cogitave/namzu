import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
	TokenBudget,
	type TokenBudgetSnapshot,
	validateTokenBudgetSnapshot,
} from '../../run/token-budget.js'
import { DefaultPathBuilder, type PathBuilder } from '../../session/workspace/path-builder.js'
import type { TokenUsage } from '../../types/common/index.js'
import type { TokenBudgetScope, TokenBudgetStore } from '../../types/run/token-budget-store.js'
import { temporaryPathFor } from '../../utils/atomic-write.js'
import { asProjectId, asRunId, asSessionId, asTenantId } from '../../utils/id.js'

interface BudgetRecord {
	readonly version: 1
	readonly scope: TokenBudgetScope
	readonly snapshot: TokenBudgetSnapshot
}

export interface DiskTokenBudgetStoreConfig {
	/** Root session's runs directory, shared by every account in a tree. */
	readonly baseDir: string
}

/**
 * Canonical ledger beside the root run, independent of checkpoint pruning.
 *
 * Writes from this instance are serialized and use private atomic sidecars.
 * New directories are mode 0700 and files are mode 0600. This is a single
 * writer store; atomic replacement does not provide a distributed lease.
 */
export class DiskTokenBudgetStore implements TokenBudgetStore {
	private readonly writes = new Map<string, Promise<void>>()

	constructor(private readonly config: DiskTokenBudgetStoreConfig) {}

	private path(scope: TokenBudgetScope): string {
		validateScope(scope)
		return join(this.config.baseDir, scope.runId, 'token-budget.json')
	}

	async load(scope: TokenBudgetScope): Promise<TokenBudgetSnapshot | null> {
		const path = this.path(scope)
		await this.writes.get(path)
		return this.read(path, scope)
	}

	async save(scope: TokenBudgetScope, snapshot: TokenBudgetSnapshot): Promise<void> {
		const path = this.path(scope)
		const checkedScope = validateScope(scope)
		const checkedSnapshot = validateSnapshotScope(snapshot, checkedScope)
		const previous = this.writes.get(path) ?? Promise.resolve()
		const writing = previous
			.catch(() => undefined)
			.then(async () => {
				const existing = await this.read(path, checkedScope)
				if (existing) assertSameRoot(existing, checkedSnapshot)
				await mkdir(dirname(path), { recursive: true, mode: 0o700 })
				const temporary = temporaryPathFor(path)
				const record: BudgetRecord = {
					version: 1,
					scope: checkedScope,
					snapshot: checkedSnapshot,
				}
				try {
					await writeFile(temporary, `${JSON.stringify(record)}\n`, {
						encoding: 'utf8',
						flag: 'wx',
						mode: 0o600,
					})
					await rename(temporary, path)
				} catch (error) {
					await unlink(temporary).catch(() => undefined)
					throw error
				}
			})
		this.writes.set(path, writing)
		try {
			await writing
		} finally {
			if (this.writes.get(path) === writing) this.writes.delete(path)
		}
	}

	private async read(path: string, scope: TokenBudgetScope): Promise<TokenBudgetSnapshot | null> {
		let text: string
		try {
			text = await readFile(path, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
		const raw: unknown = JSON.parse(text)
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			throw new Error('Invalid token budget record')
		}
		const record = raw as Partial<BudgetRecord>
		if (record.version !== 1) throw new Error('Unsupported token budget record version')
		if (!record.scope) throw new Error('Token budget record is missing its root scope')
		const storedScope = validateScope(record.scope)
		if (!sameScope(scope, storedScope)) throw new Error('Token budget root scope mismatch')
		return validateSnapshotScope(record.snapshot, scope)
	}
}

export interface OpenTokenBudgetOptions {
	readonly store?: TokenBudgetStore
	readonly scope: TokenBudgetScope
	/** Required for a new root. Existing roots can reopen without changing their cap. */
	readonly limit?: number
	readonly pathBuilder?: PathBuilder
	readonly workingDirectory?: string
	readonly accountId?: string
	/** A checkpoint binding must never create a fresh ledger if its record is gone. */
	readonly requireExisting?: boolean
}

/** Open the latest authority; a checkpoint only selects an existing account. */
export async function openTokenBudget(options: OpenTokenBudgetOptions): Promise<TokenBudget> {
	const scope = validateScope(options.scope)
	const pathBuilder =
		options.pathBuilder ??
		new DefaultPathBuilder(join(options.workingDirectory ?? process.cwd(), '.namzu'))
	const store =
		options.store ??
		new DiskTokenBudgetStore({
			baseDir: join(pathBuilder.sessionDir(scope.projectId, scope.sessionId), 'runs'),
		})
	const persistence = {
		scope,
		save: (snapshot: TokenBudgetSnapshot) => store.save(scope, snapshot),
	}
	const saved = await store.load(scope)
	let budget: TokenBudget
	if (saved === null) {
		if (options.requireExisting || options.accountId !== undefined) {
			throw new Error('The token budget ledger required by this run is missing')
		}
		if (options.limit === undefined)
			throw new Error('A new token budget requires an explicit limit')
		budget = TokenBudget.create(options.limit, scope.runId, persistence)
	} else {
		const snapshot = validateSnapshotScope(saved, scope)
		if (options.limit !== undefined && rootLimit(snapshot) !== options.limit) {
			throw new Error('Token budget root limit mismatch')
		}
		budget = TokenBudget.restore(snapshot, persistence)
	}
	const account = options.accountId === undefined ? budget : budget.account(options.accountId)
	await budget.flush()
	return account
}

function validateScope(scope: TokenBudgetScope): TokenBudgetScope {
	return {
		tenantId: asTenantId(scope.tenantId),
		projectId: asProjectId(scope.projectId),
		sessionId: asSessionId(scope.sessionId),
		runId: asRunId(scope.runId),
	}
}

function sameScope(left: TokenBudgetScope, right: TokenBudgetScope): boolean {
	return (
		left.tenantId === right.tenantId &&
		left.projectId === right.projectId &&
		left.sessionId === right.sessionId &&
		left.runId === right.runId
	)
}

function validateSnapshotScope(snapshot: unknown, scope: TokenBudgetScope): TokenBudgetSnapshot {
	const checked = validateTokenBudgetSnapshot(snapshot)
	if (checked.rootRunId !== scope.runId) throw new Error('Token budget root run mismatch')
	return checked
}

function rootLimit(snapshot: TokenBudgetSnapshot): number {
	const account = snapshot.accounts.find((account) => account.id === snapshot.rootAccountId)
	if (!account) throw new Error('Token budget root account is missing')
	return account.limit
}

function assertSameRoot(before: TokenBudgetSnapshot, after: TokenBudgetSnapshot): void {
	if (before.rootAccountId !== after.rootAccountId) {
		throw new Error('Cannot replace an existing token budget with a different root')
	}
	const reconciled = before.poisoned && !after.poisoned
	if (reconciled && after.requests.length > 0) {
		throw new Error('Cannot reopen a token budget with unresolved requests')
	}
	const accounts = new Map(after.accounts.map((account) => [account.id, account]))
	for (const previous of before.accounts) {
		const current = accounts.get(previous.id)
		if (
			!current ||
			(previous.limit > 0 && (current.limit === 0 || current.limit > previous.limit)) ||
			current.parentId !== previous.parentId ||
			(previous.runId !== undefined && current.runId !== previous.runId) ||
			(previous.settled && !current.settled)
		) {
			throw new Error('Cannot replace or remove an existing token budget account')
		}
		for (const [runId, spent] of Object.entries(previous.usage)) {
			const recorded = current.usage[runId]
			if (!usageAtLeast(recorded, spent)) {
				throw new Error('Cannot reduce recorded token budget usage')
			}
		}
	}
	const receipts = new Map(after.completedRequests.map((request) => [request.id, request]))
	for (const previous of before.completedRequests) {
		const current = receipts.get(previous.id)
		if (
			!current ||
			current.accountId !== previous.accountId ||
			current.runId !== previous.runId ||
			!usageAtLeast(current.usage, previous.usage)
		) {
			throw new Error('Cannot remove or replace a token budget completion receipt')
		}
	}
	const active = new Map(after.requests.map((request) => [request.id, request]))
	for (const previous of before.requests) {
		const current = active.get(previous.id) ?? receipts.get(previous.id)
		if (
			!current ||
			current.accountId !== previous.accountId ||
			current.runId !== previous.runId ||
			(previous.unresolved === true &&
				current.unresolved !== true &&
				(active.has(previous.id) || current.usage === undefined)) ||
			(reconciled && current.usage === undefined) ||
			!usageAtLeast(current.usage, previous.usage)
		) {
			throw new Error(
				'Cannot forget an unresolved token budget request without a completion receipt',
			)
		}
	}
}

function usageAtLeast(current: TokenUsage | undefined, previous: TokenUsage | undefined): boolean {
	if (previous === undefined) return true
	if (current === undefined) return false
	return Object.entries(previous).every(
		([field, amount]) =>
			typeof amount !== 'number' || (current[field as keyof TokenUsage] ?? 0) >= amount,
	)
}
