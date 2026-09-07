import { randomUUID } from 'node:crypto'
import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import { type TokenUsage, accumulateTokenUsage } from '../types/common/index.js'
import type { RunId } from '../types/ids/index.js'
import type { TokenBudgetBinding, TokenBudgetScope } from '../types/run/token-budget-store.js'
import { isEntityId } from '../utils/id.js'

export interface TokenBudgetAccountSnapshot {
	id: string
	parentId?: string
	limit: number
	settled: boolean
	runId?: RunId
	/** Cumulative own usage per run; descendants never appear in this map. */
	usage: Record<string, TokenUsage>
}

export interface TokenBudgetRequestSnapshot {
	id: string
	accountId: string
	runId: RunId
	/** Cumulative request usage already charged to the owning run. */
	usage?: TokenUsage
}

/** Durable authority independent of a message checkpoint's cadence. */
export interface TokenBudgetSnapshot {
	version: 1
	rootAccountId: string
	rootRunId: RunId
	accounts: TokenBudgetAccountSnapshot[]
	requests: TokenBudgetRequestSnapshot[]
	/** Durable receipts make repeated completion delivery a no-op. */
	completedRequests: TokenBudgetRequestSnapshot[]
	poisoned?: boolean
}

export interface TokenBudgetPersistence {
	save(snapshot: TokenBudgetSnapshot): Promise<void>
	readonly scope?: TokenBudgetScope
}

export interface TokenBudgetSummary {
	limit: number
	ownTokens: number
	treeTokens: number
	reservedTokens: number
	/** null means unlimited; unlike Infinity this survives JSON serialization. */
	remainingTokens: number | null
	inFlightRequests: number
	unsettledChildren: number
	/** An unresolved provider call or failed ledger write prevents admission. */
	poisoned: boolean
}

interface SharedLedger {
	rootAccountId: string
	rootRunId: RunId
	accounts: Map<string, TokenBudgetAccountSnapshot>
	requests: Map<string, TokenBudgetRequestSnapshot>
	finishedRequests: Map<string, TokenBudgetRequestSnapshot>
	poisoned: boolean
	persistence?: TokenBudgetPersistence
	writes: Promise<void>
	persistenceError?: unknown
}

interface AccountTotals {
	own: number
	tree: number
	reserved: number
	closed: boolean
}

function count(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid token budget ${name}: expected a nonnegative safe integer`)
	}
	return value
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`Invalid token budget ${name}: expected an object`)
	}
	return value as Record<string, unknown>
}

function id(value: unknown, name: string): string {
	if (!isEntityId(value, 'run')) throw new Error(`Invalid token budget ${name}: expected a UUID`)
	return value
}

function usageValue(value: unknown): TokenUsage {
	const source = object(value, 'usage')
	const usage: TokenUsage = {
		promptTokens: count(source.promptTokens, 'promptTokens'),
		completionTokens: count(source.completionTokens, 'completionTokens'),
		totalTokens: count(source.totalTokens, 'totalTokens'),
		cachedTokens: count(source.cachedTokens, 'cachedTokens'),
		cacheWriteTokens: count(source.cacheWriteTokens, 'cacheWriteTokens'),
		...(source.reasoningTokens === undefined
			? {}
			: { reasoningTokens: count(source.reasoningTokens, 'reasoningTokens') }),
	}
	// A partial usage frame may understate its total; never lose a component.
	usage.totalTokens = Math.max(
		usage.totalTokens,
		count(usage.promptTokens + usage.completionTokens, 'usage component sum'),
	)
	return usage
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
	return usageValue(accumulateTokenUsage(left, right))
}

function maxUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
	return usageValue({
		promptTokens: Math.max(left.promptTokens, right.promptTokens),
		completionTokens: Math.max(left.completionTokens, right.completionTokens),
		totalTokens: Math.max(left.totalTokens, right.totalTokens),
		cachedTokens: Math.max(left.cachedTokens, right.cachedTokens),
		cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
		...(left.reasoningTokens === undefined && right.reasoningTokens === undefined
			? {}
			: { reasoningTokens: Math.max(left.reasoningTokens ?? 0, right.reasoningTokens ?? 0) }),
	})
}

/** Validate the whole tree, then return a defensive, JSON-safe snapshot. */
export function validateTokenBudgetSnapshot(value: unknown): TokenBudgetSnapshot {
	const source = object(value, 'snapshot')
	if (source.version !== 1) throw new Error('Unsupported token budget snapshot version')
	const rootAccountId = id(source.rootAccountId, 'rootAccountId')
	if (!isEntityId(source.rootRunId, 'run')) throw new Error('Invalid token budget rootRunId')
	if (
		!Array.isArray(source.accounts) ||
		!Array.isArray(source.requests) ||
		!Array.isArray(source.completedRequests)
	) {
		throw new Error('Invalid token budget accounts or requests')
	}
	if (source.poisoned !== undefined && typeof source.poisoned !== 'boolean') {
		throw new Error('Invalid token budget poisoned flag')
	}
	const runOwners = new Map<string, string>()
	const accounts = source.accounts.map((raw): TokenBudgetAccountSnapshot => {
		const account = object(raw, 'account')
		const accountId = id(account.id, 'account id')
		if (typeof account.settled !== 'boolean') throw new Error('Invalid token budget settled flag')
		const limit = count(account.limit, 'limit')
		if (accountId !== rootAccountId && limit === 0) {
			throw new Error('A child token budget must have a positive limit')
		}
		const usage: Record<string, TokenUsage> = {}
		for (const [runId, rawUsage] of Object.entries(object(account.usage, 'account usage'))) {
			id(runId, 'usage run id')
			if (runOwners.has(runId)) throw new Error('A run belongs to more than one token budget')
			runOwners.set(runId, accountId)
			usage[runId] = usageValue(rawUsage)
		}
		if (account.runId !== undefined) {
			const runId = id(account.runId, 'bound run id')
			if (!Object.hasOwn(usage, runId) || Object.keys(usage).length !== 1) {
				throw new Error('Bound token budget run has no usage watermark')
			}
		} else if (Object.keys(usage).length !== 0) {
			throw new Error('Unbound token budget cannot contain usage')
		}
		return {
			id: accountId,
			...(account.parentId === undefined ? {} : { parentId: id(account.parentId, 'parent id') }),
			limit,
			settled: account.settled,
			...(account.runId === undefined ? {} : { runId: account.runId as RunId }),
			usage,
		}
	})
	const byId = new Map(accounts.map((account) => [account.id, account]))
	if (byId.size !== accounts.length) throw new Error('Duplicate token budget account')
	const root = byId.get(rootAccountId)
	if (!root || root.parentId !== undefined || !Object.hasOwn(root.usage, source.rootRunId)) {
		throw new Error('Invalid token budget root account')
	}
	for (const account of accounts) {
		const visited = new Set<string>()
		let cursor: TokenBudgetAccountSnapshot | undefined = account
		while (cursor.id !== rootAccountId) {
			if (visited.has(cursor.id)) throw new Error('Cycle in token budget accounts')
			visited.add(cursor.id)
			cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
			if (!cursor) throw new Error('Disconnected token budget account')
		}
	}
	const requestIds = new Set<string>()
	const parseRequest = (raw: unknown): TokenBudgetRequestSnapshot => {
		const request = object(raw, 'request')
		const requestId = id(request.id, 'request id')
		const accountId = id(request.accountId, 'request account id')
		if (!isEntityId(request.runId, 'run')) throw new Error('Invalid token budget request run id')
		if (requestIds.has(requestId)) throw new Error('Duplicate token budget request')
		requestIds.add(requestId)
		if (!byId.has(accountId) || runOwners.get(request.runId) !== accountId) {
			throw new Error('Token budget request has no owning run')
		}
		return {
			id: requestId,
			accountId,
			runId: request.runId,
			...(request.usage === undefined ? {} : { usage: usageValue(request.usage) }),
		}
	}
	const requests = source.requests.map(parseRequest)
	const completedRequests = source.completedRequests.map(parseRequest)
	const requestAccounts = new Set<string>()
	for (const request of requests) {
		if (requestAccounts.has(request.accountId))
			throw new Error('Multiple requests on one token budget account')
		requestAccounts.add(request.accountId)
	}
	const measuredByRun = new Map<string, TokenUsage>()
	for (const request of [...requests, ...completedRequests]) {
		if (request.usage === undefined) continue
		const measured = addUsage(
			measuredByRun.get(request.runId) ?? { ...EMPTY_TOKEN_USAGE },
			request.usage,
		)
		measuredByRun.set(request.runId, measured)
		const account = byId.get(request.accountId)
		const own = account?.usage[request.runId]
		if (
			!own ||
			measured.totalTokens > own.totalTokens ||
			measured.promptTokens > own.promptTokens ||
			measured.completionTokens > own.completionTokens
		) {
			throw new Error('Request usage exceeds its owning run watermark')
		}
	}
	// Account sums must also remain representable, including malicious snapshots
	// with individually valid counters whose sum exceeds safe integer arithmetic.
	let aggregate = { ...EMPTY_TOKEN_USAGE }
	for (const account of accounts) {
		for (const usage of Object.values(account.usage)) aggregate = addUsage(aggregate, usage)
	}
	const children = new Map<string, TokenBudgetAccountSnapshot[]>()
	for (const account of accounts) {
		if (account.parentId === undefined) continue
		const siblings = children.get(account.parentId) ?? []
		siblings.push(account)
		children.set(account.parentId, siblings)
	}
	function checkReservations(account: TokenBudgetAccountSnapshot): {
		tree: number
		closed: boolean
	} {
		const descendants = (children.get(account.id) ?? []).map((child) => ({
			child,
			measured: checkReservations(child),
		}))
		count(
			descendants.reduce(
				(sum, { child, measured }) =>
					sum + (measured.closed ? 0 : Math.max(0, child.limit - measured.tree)),
				0,
			),
			'reserved allowance',
		)
		return {
			tree:
				Object.values(account.usage).reduce((sum, usage) => sum + usage.totalTokens, 0) +
				descendants.reduce((sum, { measured }) => sum + measured.tree, 0),
			closed:
				account.settled &&
				!requestAccounts.has(account.id) &&
				descendants.every(({ measured }) => measured.closed),
		}
	}
	checkReservations(root)
	return {
		version: 1,
		rootAccountId,
		rootRunId: source.rootRunId,
		accounts,
		requests,
		completedRequests,
		...(source.poisoned === undefined ? {} : { poisoned: source.poisoned }),
	}
}

/**
 * One conserved authority for a run and all of its descendants.
 *
 * A child's unused reservation is unavailable to its parent and siblings.
 * Measured spend replaces that reservation, including overshoot debt. Provider
 * usage is known after a request: this enforces admission, not an exact upper
 * bound on the tokens an already admitted request can report.
 */
export class TokenBudget {
	private constructor(
		private readonly ledger: SharedLedger,
		readonly accountId: string,
	) {}

	static create(
		limit: number,
		rootRunId: RunId,
		persistence?: TokenBudgetPersistence,
	): TokenBudget {
		count(limit, 'limit')
		id(rootRunId, 'root run id')
		const accountId = randomUUID()
		const budget = new TokenBudget(
			{
				rootAccountId: accountId,
				rootRunId,
				accounts: new Map([
					[
						accountId,
						{
							id: accountId,
							limit,
							settled: false,
							runId: rootRunId,
							usage: { [rootRunId]: { ...EMPTY_TOKEN_USAGE } },
						},
					],
				]),
				requests: new Map(),
				finishedRequests: new Map(),
				poisoned: false,
				persistence,
				writes: Promise.resolve(),
			},
			accountId,
		)
		budget.persist()
		return budget
	}

	static restore(snapshot: TokenBudgetSnapshot, persistence?: TokenBudgetPersistence): TokenBudget {
		const state = validateTokenBudgetSnapshot(snapshot)
		return new TokenBudget(
			{
				rootAccountId: state.rootAccountId,
				rootRunId: state.rootRunId,
				accounts: new Map(state.accounts.map((account) => [account.id, account])),
				requests: new Map(state.requests.map((request) => [request.id, request])),
				finishedRequests: new Map(state.completedRequests.map((request) => [request.id, request])),
				poisoned: state.poisoned === true || state.requests.length > 0,
				persistence,
				writes: Promise.resolve(),
			},
			state.rootAccountId,
		)
	}

	get limit(): number {
		return this.node.limit
	}
	get runId(): RunId | undefined {
		return this.node.runId
	}
	get rootRunId(): RunId {
		return this.ledger.rootRunId
	}
	get binding(): TokenBudgetBinding | undefined {
		const scope = this.ledger.persistence?.scope
		return scope ? { scope: { ...scope }, accountId: this.accountId } : undefined
	}
	get ownUsage(): TokenUsage {
		return Object.values(this.node.usage).reduce(addUsage, { ...EMPTY_TOKEN_USAGE })
	}
	get ownTokens(): number {
		return this.ownUsage.totalTokens
	}
	get treeTokens(): number {
		return this.totals(this.node).tree
	}
	/** This account's request is still awaiting its final receipt; descendants are independent. */
	get hasInFlightRequest(): boolean {
		return this.hasRequest(this.node)
	}

	get remaining(): number {
		if (this.ledger.poisoned || this.node.settled) return 0
		let cursor = this.node
		let available = this.free(cursor)
		while (cursor.parentId !== undefined) {
			const branch = this.totals(cursor)
			const held = branch.closed ? 0 : Math.max(0, cursor.limit - branch.tree)
			cursor = this.requireAccount(cursor.parentId)
			// A sibling's overshoot reduces this branch's promise. A parent's
			// zero unreserved space alone does not exhaust its reserved child.
			available = Math.min(available, this.free(cursor) + held)
		}
		return Math.max(0, available)
	}

	account(accountId: string): TokenBudget {
		if (!this.descendants(this.node).has(accountId))
			throw new Error('Token budget account is outside this subtree')
		return new TokenBudget(this.ledger, accountId)
	}

	findRun(runId: RunId): TokenBudget | undefined {
		const descendants = this.descendants(this.node)
		const account = [...this.ledger.accounts.values()].find(
			(node) => descendants.has(node.id) && Object.hasOwn(node.usage, runId),
		)
		return account ? this.account(account.id) : undefined
	}

	bindRun(runId: RunId): void {
		id(runId, 'bound run id')
		const owner = [...this.ledger.accounts.values()].find((node) =>
			Object.hasOwn(node.usage, runId),
		)
		if (owner && owner.id !== this.accountId)
			throw new Error('Run already belongs to another token budget')
		if (this.node.runId !== undefined && this.node.runId !== runId)
			throw new Error('Token budget run binding is immutable')
		if (this.node.settled && this.node.runId !== runId) throw new Error('Token budget is settled')
		this.node.runId = runId
		this.node.usage[runId] ??= { ...EMPTY_TOKEN_USAGE }
		this.persist()
	}

	reserve(tokens: number): TokenBudget {
		count(tokens, 'reservation')
		if (this.hasRequest(this.node)) throw new Error('Token budget has an in-flight request')
		if (tokens === 0 || tokens > this.remaining)
			throw new Error('Token budget cannot reserve the requested tokens')
		count(this.totals(this.node).reserved + tokens, 'reserved allowance')
		const accountId = randomUUID()
		this.ledger.accounts.set(accountId, {
			id: accountId,
			parentId: this.accountId,
			limit: tokens,
			settled: false,
			usage: {},
		})
		this.persist()
		return this.account(accountId)
	}

	/** Narrow the entire subtree; already measured spend and reservations remain. */
	narrow(limit: number): void {
		count(limit, 'limit')
		// Numeric run configuration uses zero for "no additional limit". It
		// cannot remove an inherited finite authority.
		if (limit === 0 || limit === this.limit) return
		if (this.limit !== 0 && limit > this.limit)
			throw new Error('Token budget cannot widen its limit')
		this.node.limit = limit
		this.persist()
	}

	/** Reconcile a cumulative OWN run counter; a completion is not another spend. */
	recordUsage(usage: TokenUsage, runId: RunId | undefined = this.runId): void {
		const previous = this.requireOwnUsage(runId)
		const next = maxUsage(previous, usageValue(usage))
		this.checkAggregateReplacement(previous, next)
		if (runId === undefined) throw new Error('Token budget run is not bound')
		this.node.usage[runId] = next
		this.persist()
	}

	async beginRequest(): Promise<string> {
		if (this.ledger.poisoned) throw new Error('Token budget has unresolved spend')
		if (this.node.settled) throw new Error('Token budget is settled')
		if (this.remaining <= 0) throw new Error('Token budget is exhausted')
		const runId = this.runId
		if (runId === undefined) throw new Error('Token budget run is not bound')
		// Requests on different child scopes may run concurrently. The same
		// account cannot promise its unmeasured allowance twice.
		if (this.hasRequest(this.node)) throw new Error('Token budget has an in-flight request')
		const requestId = randomUUID()
		this.ledger.requests.set(requestId, { id: requestId, accountId: this.accountId, runId })
		this.persist()
		await this.flush()
		return requestId
	}

	async finishRequest(requestId: string, usage: TokenUsage): Promise<void> {
		if (this.hasReceipt(requestId)) return this.flush()
		const request = this.requireRequest(requestId)
		try {
			this.recordRequestUsage(request, usage)
		} catch (error) {
			this.ledger.poisoned = true
			this.persist()
			await this.flush()
			throw error
		}
		this.ledger.requests.delete(requestId)
		this.ledger.finishedRequests.set(requestId, request)
		this.persist()
		await this.flush()
	}

	/** Unknown spend cannot be converted into a refund, even after cancellation. */
	async failRequest(requestId: string, usage?: TokenUsage): Promise<void> {
		if (this.hasReceipt(requestId)) return this.flush()
		const request = this.requireRequest(requestId)
		this.ledger.poisoned = true
		try {
			if (usage !== undefined) this.recordRequestUsage(request, usage)
		} catch (error) {
			this.persist()
			await this.flush()
			throw error
		}
		this.persist()
		await this.flush()
	}

	/**
	 * Explicit host recovery after obtaining the provider's final usage receipt.
	 * Ordinary completion never reopens an uncertain ledger. Reconciliation can
	 * do so only after every outstanding request has a measured receipt and all
	 * accounting writes succeeded; it never resets usage or settled accounts.
	 */
	async reconcileRequest(requestId: string, usage: TokenUsage): Promise<void> {
		const measured = usageValue(usage)
		if (this.hasReceipt(requestId)) {
			const receipt = this.ledger.finishedRequests.get(requestId)
			if (!receipt) throw new Error('Unknown token budget receipt')
			// A recovered receipt may contain more usage than an earlier report.
			// Preserve that evidence even though ordinary duplicate completion is
			// a no-op. Repeating this same receipt still charges nothing twice.
			this.recordRequestUsage(receipt, measured)
			this.persist()
			await this.flush()
		} else {
			await this.finishRequest(requestId, measured)
		}
		if (this.ledger.requests.size === 0 && this.ledger.persistenceError === undefined) {
			this.ledger.poisoned = false
			this.persist()
			await this.flush()
		}
	}

	settle(ownTotalTokens?: number): void {
		if (ownTotalTokens !== undefined) {
			count(ownTotalTokens, 'settled own tokens')
			if (ownTotalTokens > this.ownTokens) {
				if (this.runId === undefined)
					throw new Error('Unbound token budget cannot settle nonzero usage')
				const previous = this.requireOwnUsage(this.runId)
				this.recordUsage({
					...previous,
					totalTokens: previous.totalTokens + ownTotalTokens - this.ownTokens,
				})
			}
		}
		this.node.settled = true
		this.persist()
	}

	summary(): TokenBudgetSummary {
		const totals = this.totals(this.node)
		const descendants = this.descendants(this.node)
		return {
			limit: this.limit,
			ownTokens: totals.own,
			treeTokens: totals.tree,
			reservedTokens: totals.reserved,
			remainingTokens: Number.isFinite(this.remaining) ? this.remaining : null,
			inFlightRequests: [...this.ledger.requests.values()].filter((request) =>
				descendants.has(request.accountId),
			).length,
			unsettledChildren: this.children(this.node).filter((child) => !this.totals(child).closed)
				.length,
			poisoned: this.ledger.poisoned,
		}
	}

	snapshot(): TokenBudgetSnapshot {
		return structuredClone({
			version: 1,
			rootAccountId: this.ledger.rootAccountId,
			rootRunId: this.rootRunId,
			accounts: [...this.ledger.accounts.values()],
			requests: [...this.ledger.requests.values()],
			completedRequests: [...this.ledger.finishedRequests.values()],
			...(this.ledger.poisoned ? { poisoned: true } : {}),
		})
	}

	async flush(): Promise<void> {
		await this.ledger.writes
		if (this.ledger.persistenceError !== undefined) throw this.ledger.persistenceError
	}

	private get node(): TokenBudgetAccountSnapshot {
		return this.requireAccount(this.accountId)
	}
	private requireAccount(accountId: string): TokenBudgetAccountSnapshot {
		const account = this.ledger.accounts.get(accountId)
		if (!account) throw new Error('Unknown token budget account')
		return account
	}
	private requireOwnUsage(runId: RunId | undefined): TokenUsage {
		const usage = runId === undefined ? undefined : this.node.usage[runId]
		if (!usage) throw new Error('Token budget run is not bound')
		return usage
	}
	private hasReceipt(requestId: string): boolean {
		const receipt = this.ledger.finishedRequests.get(requestId)
		if (receipt && receipt.accountId !== this.accountId)
			throw new Error('Token budget receipt belongs to another account')
		return receipt !== undefined
	}
	private recordRequestUsage(request: TokenBudgetRequestSnapshot, usage: TokenUsage): void {
		const observed = request.usage ?? { ...EMPTY_TOKEN_USAGE }
		const measured = maxUsage(observed, usageValue(usage))
		const delta: TokenUsage = {
			promptTokens: measured.promptTokens - observed.promptTokens,
			completionTokens: measured.completionTokens - observed.completionTokens,
			totalTokens: measured.totalTokens - observed.totalTokens,
			cachedTokens: measured.cachedTokens - observed.cachedTokens,
			cacheWriteTokens: measured.cacheWriteTokens - observed.cacheWriteTokens,
			...(measured.reasoningTokens === undefined
				? {}
				: { reasoningTokens: measured.reasoningTokens - (observed.reasoningTokens ?? 0) }),
		}
		const previous = this.requireOwnUsage(request.runId)
		const next = addUsage(previous, delta)
		this.checkAggregateReplacement(previous, next)
		this.node.usage[request.runId] = next
		request.usage = measured
	}
	private children(node: TokenBudgetAccountSnapshot): TokenBudgetAccountSnapshot[] {
		return [...this.ledger.accounts.values()].filter((account) => account.parentId === node.id)
	}
	private descendants(node: TokenBudgetAccountSnapshot): Set<string> {
		return new Set([
			node.id,
			...this.children(node).flatMap((child) => [...this.descendants(child)]),
		])
	}
	private hasRequest(node: TokenBudgetAccountSnapshot): boolean {
		return [...this.ledger.requests.values()].some((request) => request.accountId === node.id)
	}
	private totals(node: TokenBudgetAccountSnapshot): AccountTotals {
		const children = this.children(node).map((child) => ({ child, totals: this.totals(child) }))
		const own = Object.values(node.usage).reduce((sum, usage) => sum + usage.totalTokens, 0)
		return {
			own,
			tree: own + children.reduce((sum, { totals }) => sum + totals.tree, 0),
			reserved: children.reduce(
				(sum, { child, totals }) =>
					sum + (totals.closed ? 0 : Math.max(0, child.limit - totals.tree)),
				0,
			),
			closed:
				node.settled && !this.hasRequest(node) && children.every(({ totals }) => totals.closed),
		}
	}
	private free(node: TokenBudgetAccountSnapshot): number {
		if (node.limit === 0) return Number.POSITIVE_INFINITY
		const totals = this.totals(node)
		return node.limit - totals.tree - totals.reserved
	}
	private requireRequest(requestId: string): TokenBudgetRequestSnapshot {
		const request = this.ledger.requests.get(requestId)
		if (!request || request.accountId !== this.accountId)
			throw new Error('Unknown token budget request')
		return request
	}
	private checkAggregateReplacement(previous: TokenUsage, next: TokenUsage): void {
		count(
			this.totals(this.requireAccount(this.ledger.rootAccountId)).tree -
				previous.totalTokens +
				next.totalTokens,
			'tree usage',
		)
	}
	private persist(): void {
		if (!this.ledger.persistence) return
		const snapshot = this.snapshot()
		const persistence = this.ledger.persistence
		this.ledger.writes = this.ledger.writes.then(async () => {
			if (this.ledger.persistenceError !== undefined) return
			try {
				await persistence.save(snapshot)
			} catch (error) {
				this.ledger.persistenceError = error ?? new Error('Token budget persistence failed')
				this.ledger.poisoned = true
			}
		})
	}
}
