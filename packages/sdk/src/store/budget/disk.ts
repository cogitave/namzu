import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionPaths } from '../../session/paths.js'
import type { TokenUsage } from '../../types/common/index.js'
import { temporaryPathFor } from '../../utils/atomic-write.js'
import { asSessionId, asTurnId } from '../../utils/id.js'
import {
	SessionTokenBudget,
	type SessionTokenBudgetScope,
	type SessionTokenBudgetSnapshot,
	validateSessionTokenBudgetSnapshot,
} from './ledger.js'

/**
 * Durable storage for one token ledger per `(rootSessionId, rootTurnId)`.
 *
 * A root turn and every child session turn under it share one writer. Save
 * atomically replaces a complete record and refuses one that would lose
 * spend, a receipt or an account (a stale save); a missing record is null and
 * a corrupt or foreign one throws. Exclusive ownership across processes is
 * the session lease's job, not this store's.
 */
export interface SessionTokenBudgetStore {
	load(scope: SessionTokenBudgetScope): Promise<SessionTokenBudgetSnapshot | null>
	save(scope: SessionTokenBudgetScope, snapshot: SessionTokenBudgetSnapshot): Promise<void>
}

export interface DiskSessionTokenBudgetStoreOptions {
	/** The project whose root sessions hold the ledgers. */
	readonly paths: SessionPaths
}

/**
 * {@link SessionTokenBudgetStore} at `<root-session-id>/budgets/<root-turn-id>.json`.
 *
 * The file is the snapshot itself (`kind: 'token-budget'`, `v: 2`). Writes
 * from this instance are serialised per ledger and go through a private
 * sidecar and a rename. New directories are mode 0700 and files 0600.
 */
export class DiskSessionTokenBudgetStore implements SessionTokenBudgetStore {
	readonly #paths: SessionPaths
	readonly #writes = new Map<string, Promise<void>>()

	constructor(options: DiskSessionTokenBudgetStoreOptions) {
		this.#paths = options.paths
	}

	#path(scope: SessionTokenBudgetScope): string {
		const checked = validateBudgetScope(scope)
		return this.#paths.budgetFile({ sessionId: checked.rootSessionId }, checked.rootTurnId)
	}

	async load(scope: SessionTokenBudgetScope): Promise<SessionTokenBudgetSnapshot | null> {
		const path = this.#path(scope)
		await this.#writes.get(path)?.catch(() => undefined)
		return this.#read(path, validateBudgetScope(scope))
	}

	async save(scope: SessionTokenBudgetScope, snapshot: SessionTokenBudgetSnapshot): Promise<void> {
		const path = this.#path(scope)
		const checkedScope = validateBudgetScope(scope)
		const checked = validateSnapshotScope(snapshot, checkedScope)
		const previous = this.#writes.get(path) ?? Promise.resolve()
		const writing = previous
			.catch(() => undefined)
			.then(async () => {
				const existing = await this.#read(path, checkedScope)
				if (existing) assertSameRoot(existing, checked)
				await mkdir(dirname(path), { recursive: true, mode: 0o700 })
				const temporary = temporaryPathFor(path)
				try {
					await writeFile(temporary, `${JSON.stringify(checked)}\n`, {
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
		this.#writes.set(path, writing)
		try {
			await writing
		} finally {
			if (this.#writes.get(path) === writing) this.#writes.delete(path)
		}
	}

	async #read(
		path: string,
		scope: SessionTokenBudgetScope,
	): Promise<SessionTokenBudgetSnapshot | null> {
		let text: string
		try {
			text = await readFile(path, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
		return validateSnapshotScope(JSON.parse(text), scope)
	}
}

export interface OpenSessionTokenBudgetOptions {
	readonly store: SessionTokenBudgetStore
	readonly scope: SessionTokenBudgetScope
	/**
	 * Required for a new ledger. Reopening an existing ledger with a
	 * different limit is refused: a new limit belongs to a new root turn,
	 * which opens a ledger of its own.
	 */
	readonly limit?: number
	/** Open this account of the ledger (a checkpoint's binding) instead of the root. */
	readonly accountId?: string
	/** A checkpoint binding must never create a fresh ledger if its record is gone. */
	readonly requireExisting?: boolean
}

/** Open the latest authority for a root turn; a checkpoint only selects an existing account. */
export async function openSessionTokenBudget(
	options: OpenSessionTokenBudgetOptions,
): Promise<SessionTokenBudget> {
	const scope = validateBudgetScope(options.scope)
	const store = options.store
	const persistence = {
		save: (snapshot: SessionTokenBudgetSnapshot) => store.save(scope, snapshot),
	}
	const saved = await store.load(scope)
	let budget: SessionTokenBudget
	if (saved === null) {
		if (options.requireExisting || options.accountId !== undefined) {
			throw new Error('The token budget ledger required by this turn is missing')
		}
		if (options.limit === undefined)
			throw new Error('A new token budget requires an explicit limit')
		budget = SessionTokenBudget.create(options.limit, scope, persistence)
	} else {
		const snapshot = validateSnapshotScope(saved, scope)
		if (options.limit !== undefined && snapshot.limit !== options.limit) {
			throw new Error('Token budget root limit mismatch')
		}
		budget = SessionTokenBudget.restore(snapshot, persistence)
	}
	const account = options.accountId === undefined ? budget : budget.account(options.accountId)
	await budget.flush()
	return account
}

/** Validate both ids of a ledger key, so neither can reach a path or a map key unchecked. */
export function validateBudgetScope(scope: SessionTokenBudgetScope): SessionTokenBudgetScope {
	return { rootSessionId: asSessionId(scope.rootSessionId), rootTurnId: asTurnId(scope.rootTurnId) }
}

/** @internal Validate a snapshot and check it is the ledger of `scope` (the owner check). */
export function validateSnapshotScope(
	snapshot: unknown,
	scope: SessionTokenBudgetScope,
): SessionTokenBudgetSnapshot {
	const checked = validateSessionTokenBudgetSnapshot(snapshot)
	if (checked.rootSessionId !== scope.rootSessionId || checked.rootTurnId !== scope.rootTurnId) {
		throw new Error('Token budget root scope mismatch')
	}
	return checked
}

/**
 * @internal Refuse a save that would replace the ledger with another root,
 * or lose an account, spend, a receipt or an unresolved request: a stale
 * writer's snapshot. Shared with the in-memory store so the two refuse alike.
 */
export function assertSameRoot(
	before: SessionTokenBudgetSnapshot,
	after: SessionTokenBudgetSnapshot,
): void {
	if (before.rootAccountId !== after.rootAccountId) {
		throw new Error('Cannot replace an existing token budget with a different root')
	}
	const reconciled = before.poisoned === true && after.poisoned !== true
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
			(previous.turn !== undefined &&
				(current.turn?.turnId !== previous.turn.turnId ||
					current.turn.sessionId !== previous.turn.sessionId)) ||
			(previous.settled && !current.settled)
		) {
			throw new Error('Cannot replace or remove an existing token budget account')
		}
		for (const [turn, spent] of Object.entries(previous.usage)) {
			if (!usageAtLeast(current.usage[turn], spent)) {
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
			current.turnId !== previous.turnId ||
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
			current.turnId !== previous.turnId ||
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
