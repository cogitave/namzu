import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { type TokenUsage, accumulateTokenUsage } from '../../types/common/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { TurnBudgetBinding } from '../../types/session/turn.js'
import { entityIdPattern } from '../../utils/id-format.js'
import { isEntityId } from '../../utils/id.js'
import { uuidv7 } from '../../utils/uuidv7.js'

/** Version of the token-budget document. Version 1 (keyed by run) is refused, never migrated. */
export const SESSION_TOKEN_BUDGET_VERSION = 2 as const

/**
 * The key of one ledger: the root turn that opened it, in its root session.
 *
 * A child session's turns bind to the key of the root turn that spawned them,
 * a resumed paused turn reuses its key, and a new root turn opens a new
 * ledger with a limit of its own.
 */
export interface SessionTokenBudgetScope {
	readonly rootSessionId: SessionId
	readonly rootTurnId: TurnId
}

/** The turn an account is bound to. */
export interface SessionTokenBudgetTurn {
	sessionId: SessionId
	turnId: TurnId
}

export interface SessionTokenBudgetAccountSnapshot {
	id: string
	parentId?: string
	limit: number
	settled: boolean
	/** The one turn this account spends for; absent until bound. */
	turn?: SessionTokenBudgetTurn
	/** Cumulative own usage, keyed by the bound turn's id; descendants never appear here. */
	usage: Record<string, TokenUsage>
}

export interface SessionTokenBudgetRequestSnapshot {
	id: string
	accountId: string
	turnId: TurnId
	/** Cumulative request usage already charged to the owning turn. */
	usage?: TokenUsage
	/** No reliable final receipt; only explicit reconciliation clears this marker. */
	unresolved?: boolean
}

/**
 * The token-budget document, stored at
 * `<root-session-id>/budgets/<root-turn-id>.json`. Durable authority
 * independent of a checkpoint's cadence.
 */
export interface SessionTokenBudgetSnapshot {
	v: typeof SESSION_TOKEN_BUDGET_VERSION
	kind: 'token-budget'
	rootSessionId: SessionId
	rootTurnId: TurnId
	/** The root account's current limit; 0 is unlimited. Always equal to that account's `limit`. */
	limit: number
	rootAccountId: string
	accounts: SessionTokenBudgetAccountSnapshot[]
	requests: SessionTokenBudgetRequestSnapshot[]
	/** Durable receipts make repeated completion delivery a no-op. */
	completedRequests: SessionTokenBudgetRequestSnapshot[]
	poisoned?: boolean
}

export interface SessionTokenBudgetPersistence {
	save(snapshot: SessionTokenBudgetSnapshot): Promise<void>
}

export interface SessionTokenBudgetSummary {
	limit: number
	ownTokens: number
	treeTokens: number
	reservedTokens: number
	/** null means unlimited; unlike Infinity this survives JSON serialization. */
	remainingTokens: number | null
	inFlightRequests: number
	unsettledChildren: number
	/** This account is blocked by accounting failure or uncertain finite allowance. */
	poisoned: boolean
	/** Unresolved receipts in this subtree, including retained completion records. */
	unresolvedRequests: number
}

/** A token-budget document this release does not read: version 1, another version, or another kind. */
export class SessionTokenBudgetVersionError extends Error {
	override readonly name = 'SessionTokenBudgetVersionError'
}

interface SharedLedger {
	rootAccountId: string
	scope: SessionTokenBudgetScope
	accounts: Map<string, SessionTokenBudgetAccountSnapshot>
	requests: Map<string, SessionTokenBudgetRequestSnapshot>
	finishedRequests: Map<string, SessionTokenBudgetRequestSnapshot>
	poisoned: boolean
	persistence?: SessionTokenBudgetPersistence
	writes: Promise<void>
	persistenceError?: unknown
}

interface AccountTotals {
	own: number
	tree: number
	reserved: number
	closed: boolean
}

const UUID = entityIdPattern()

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

/** An account or request id: any UUID. */
function uuid(value: unknown, name: string): string {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw new Error(`Invalid token budget ${name}: expected a UUID`)
	}
	return value
}

function turnId(value: unknown, name: string): TurnId {
	if (!isEntityId(value, 'turn')) throw new Error(`Invalid token budget ${name}: expected a UUID`)
	return value
}

function sessionId(value: unknown, name: string): SessionId {
	if (!isEntityId(value, 'session'))
		throw new Error(`Invalid token budget ${name}: expected a UUID`)
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

/** Refuse a document of another version or kind by name, before its shape is read. */
function checkVersion(source: Record<string, unknown>): void {
	if (source.v === SESSION_TOKEN_BUDGET_VERSION && source.kind === 'token-budget') return
	if (source.version === 1) {
		throw new SessionTokenBudgetVersionError(
			'Token budget snapshot version 1 (keyed by run) is not read by this release. Ledgers are now keyed by (rootSessionId, rootTurnId), snapshot version 2. Settle or abandon the parked run with the release that wrote it before upgrading; a new turn opens a new ledger.',
		)
	}
	if (source.kind !== 'token-budget') {
		throw new SessionTokenBudgetVersionError(
			`Not a token-budget document: kind ${JSON.stringify(source.kind)}.`,
		)
	}
	throw new SessionTokenBudgetVersionError(
		`Unsupported token budget snapshot version ${JSON.stringify(source.v)}; this release reads version ${SESSION_TOKEN_BUDGET_VERSION}.`,
	)
}

/** Validate the whole tree, then return a defensive, JSON-safe snapshot. */
export function validateSessionTokenBudgetSnapshot(value: unknown): SessionTokenBudgetSnapshot {
	const source = object(value, 'snapshot')
	checkVersion(source)
	const rootSessionId = sessionId(source.rootSessionId, 'rootSessionId')
	const rootTurnId = turnId(source.rootTurnId, 'rootTurnId')
	const rootAccountId = uuid(source.rootAccountId, 'rootAccountId')
	const limit = count(source.limit, 'limit')
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
	const turnOwners = new Map<string, string>()
	const accounts = source.accounts.map((raw): SessionTokenBudgetAccountSnapshot => {
		const account = object(raw, 'account')
		const accountId = uuid(account.id, 'account id')
		if (typeof account.settled !== 'boolean') throw new Error('Invalid token budget settled flag')
		const accountLimit = count(account.limit, 'limit')
		const usage: Record<string, TokenUsage> = {}
		for (const [owner, rawUsage] of Object.entries(object(account.usage, 'account usage'))) {
			turnId(owner, 'usage turn id')
			if (turnOwners.has(owner)) throw new Error('A turn belongs to more than one token budget')
			turnOwners.set(owner, accountId)
			usage[owner] = usageValue(rawUsage)
		}
		let turn: SessionTokenBudgetTurn | undefined
		if (account.turn !== undefined) {
			const bound = object(account.turn, 'bound turn')
			turn = {
				sessionId: sessionId(bound.sessionId, 'bound session id'),
				turnId: turnId(bound.turnId, 'bound turn id'),
			}
			if (!Object.hasOwn(usage, turn.turnId) || Object.keys(usage).length !== 1) {
				throw new Error('Bound token budget turn has no usage watermark')
			}
		} else if (Object.keys(usage).length !== 0) {
			throw new Error('Unbound token budget cannot contain usage')
		}
		return {
			id: accountId,
			...(account.parentId === undefined ? {} : { parentId: uuid(account.parentId, 'parent id') }),
			limit: accountLimit,
			settled: account.settled,
			...(turn === undefined ? {} : { turn }),
			usage,
		}
	})
	const byId = new Map(accounts.map((account) => [account.id, account]))
	if (byId.size !== accounts.length) throw new Error('Duplicate token budget account')
	const root = byId.get(rootAccountId)
	if (
		!root ||
		root.parentId !== undefined ||
		root.turn?.sessionId !== rootSessionId ||
		root.turn.turnId !== rootTurnId
	) {
		throw new Error('Invalid token budget root account')
	}
	if (root.limit !== limit) throw new Error('Token budget limit disagrees with its root account')
	for (const account of accounts) {
		const visited = new Set<string>()
		let cursor: SessionTokenBudgetAccountSnapshot | undefined = account
		while (cursor.id !== rootAccountId) {
			if (visited.has(cursor.id)) throw new Error('Cycle in token budget accounts')
			visited.add(cursor.id)
			cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
			if (!cursor) throw new Error('Disconnected token budget account')
		}
	}
	const requestIds = new Set<string>()
	const parseRequest = (raw: unknown): SessionTokenBudgetRequestSnapshot => {
		const request = object(raw, 'request')
		const requestId = uuid(request.id, 'request id')
		const accountId = uuid(request.accountId, 'request account id')
		if (request.unresolved !== undefined && typeof request.unresolved !== 'boolean')
			throw new Error('Invalid unresolved request marker')
		const owner = turnId(request.turnId, 'request turn id')
		if (requestIds.has(requestId)) throw new Error('Duplicate token budget request')
		requestIds.add(requestId)
		if (!byId.has(accountId) || turnOwners.get(owner) !== accountId) {
			throw new Error('Token budget request has no owning turn')
		}
		return {
			id: requestId,
			accountId,
			turnId: owner,
			...(request.usage === undefined ? {} : { usage: usageValue(request.usage) }),
			...(request.unresolved === true ? { unresolved: true } : {}),
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
	const measuredByTurn = new Map<string, TokenUsage>()
	for (const request of [...requests, ...completedRequests]) {
		if (request.usage === undefined) continue
		const measured = addUsage(
			measuredByTurn.get(request.turnId) ?? { ...EMPTY_TOKEN_USAGE },
			request.usage,
		)
		measuredByTurn.set(request.turnId, measured)
		const own = byId.get(request.accountId)?.usage[request.turnId]
		if (
			!own ||
			measured.totalTokens > own.totalTokens ||
			measured.promptTokens > own.promptTokens ||
			measured.completionTokens > own.completionTokens
		) {
			throw new Error('Request usage exceeds its owning turn watermark')
		}
	}
	// Account sums must also remain representable, including malicious snapshots
	// with individually valid counters whose sum exceeds safe integer arithmetic.
	let aggregate = { ...EMPTY_TOKEN_USAGE }
	for (const account of accounts) {
		for (const usage of Object.values(account.usage)) aggregate = addUsage(aggregate, usage)
	}
	const children = new Map<string, SessionTokenBudgetAccountSnapshot[]>()
	for (const account of accounts) {
		if (account.parentId === undefined) continue
		const siblings = children.get(account.parentId) ?? []
		siblings.push(account)
		children.set(account.parentId, siblings)
	}
	function checkReservations(account: SessionTokenBudgetAccountSnapshot): {
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
		v: SESSION_TOKEN_BUDGET_VERSION,
		kind: 'token-budget',
		rootSessionId,
		rootTurnId,
		limit,
		rootAccountId,
		accounts,
		requests,
		completedRequests,
		...(source.poisoned === undefined ? {} : { poisoned: source.poisoned }),
	}
}

/**
 * One conserved token authority for a root turn and every child session
 * turn it spawns, keyed by `(rootSessionId, rootTurnId)`.
 *
 * A child's unused reservation is unavailable to its parent and siblings.
 * Measured spend replaces that reservation, including overshoot debt.
 * Provider usage is known after a request: this enforces admission, not an
 * exact upper bound on the tokens an already admitted request can report.
 */
export class SessionTokenBudget {
	private constructor(
		private readonly ledger: SharedLedger,
		readonly accountId: string,
	) {}

	static create(
		limit: number,
		scope: SessionTokenBudgetScope,
		persistence?: SessionTokenBudgetPersistence,
	): SessionTokenBudget {
		count(limit, 'limit')
		const rootSessionId = sessionId(scope.rootSessionId, 'root session id')
		const rootTurnId = turnId(scope.rootTurnId, 'root turn id')
		const accountId = uuidv7()
		const budget = new SessionTokenBudget(
			{
				rootAccountId: accountId,
				scope: { rootSessionId, rootTurnId },
				accounts: new Map([
					[
						accountId,
						{
							id: accountId,
							limit,
							settled: false,
							turn: { sessionId: rootSessionId, turnId: rootTurnId },
							usage: { [rootTurnId]: { ...EMPTY_TOKEN_USAGE } },
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

	static restore(
		snapshot: SessionTokenBudgetSnapshot,
		persistence?: SessionTokenBudgetPersistence,
	): SessionTokenBudget {
		const state = validateSessionTokenBudgetSnapshot(snapshot)
		return new SessionTokenBudget(
			{
				rootAccountId: state.rootAccountId,
				scope: { rootSessionId: state.rootSessionId, rootTurnId: state.rootTurnId },
				accounts: new Map(state.accounts.map((account) => [account.id, account])),
				requests: new Map(
					state.requests.map((request) => [request.id, { ...request, unresolved: true }]),
				),
				finishedRequests: new Map(state.completedRequests.map((request) => [request.id, request])),
				poisoned: state.poisoned === true,
				persistence,
				writes: Promise.resolve(),
			},
			state.rootAccountId,
		)
	}

	get limit(): number {
		return this.node.limit
	}
	/** The turn this account spends for, when bound. */
	get turn(): SessionTokenBudgetTurn | undefined {
		const turn = this.node.turn
		return turn ? { ...turn } : undefined
	}
	get turnId(): TurnId | undefined {
		return this.node.turn?.turnId
	}
	/** The ledger's key. */
	get scope(): SessionTokenBudgetScope {
		return { ...this.ledger.scope }
	}
	/**
	 * The checkpoint reference to this account, when the ledger is persisted.
	 * A ledger with no persistence has nothing a later process could reopen,
	 * so it has no binding.
	 */
	get binding(): TurnBudgetBinding | undefined {
		return this.ledger.persistence ? { ...this.ledger.scope, accountId: this.accountId } : undefined
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
		if (this.admissionBlocked() || this.node.settled) return 0
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

	account(accountId: string): SessionTokenBudget {
		if (!this.descendants(this.node).has(accountId))
			throw new Error('Token budget account is outside this subtree')
		return new SessionTokenBudget(this.ledger, accountId)
	}

	findTurn(turn: TurnId): SessionTokenBudget | undefined {
		const descendants = this.descendants(this.node)
		const account = [...this.ledger.accounts.values()].find(
			(node) => descendants.has(node.id) && Object.hasOwn(node.usage, turn),
		)
		return account ? this.account(account.id) : undefined
	}

	/** Bind this account to the one turn it spends for. Idempotent; a binding never changes. */
	bindTurn(session: SessionId, turn: TurnId): void {
		sessionId(session, 'bound session id')
		turnId(turn, 'bound turn id')
		const owner = [...this.ledger.accounts.values()].find((node) => Object.hasOwn(node.usage, turn))
		if (owner && owner.id !== this.accountId)
			throw new Error('Turn already belongs to another token budget')
		const bound = this.node.turn
		if (bound !== undefined && (bound.turnId !== turn || bound.sessionId !== session))
			throw new Error('Token budget turn binding is immutable')
		if (this.node.settled && bound === undefined) throw new Error('Token budget is settled')
		this.node.turn = { sessionId: session, turnId: turn }
		this.node.usage[turn] ??= { ...EMPTY_TOKEN_USAGE }
		this.persist()
	}

	reserve(tokens: number): SessionTokenBudget {
		count(tokens, 'reservation')
		if (this.hasRequest(this.node)) throw new Error('Token budget has an in-flight request')
		if ((tokens === 0 && this.remaining !== Number.POSITIVE_INFINITY) || tokens > this.remaining)
			throw new Error('Token budget cannot reserve the requested tokens')
		count(this.totals(this.node).reserved + tokens, 'reserved allowance')
		const accountId = uuidv7()
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
		// Numeric configuration uses zero for "no additional limit". It cannot
		// remove an inherited finite authority.
		if (limit === 0 || limit === this.limit) return
		if (this.limit !== 0 && limit > this.limit)
			throw new Error('Token budget cannot widen its limit')
		this.node.limit = limit
		this.persist()
	}

	/** Reconcile a cumulative OWN turn counter; a completion is not another spend. */
	recordUsage(usage: TokenUsage, turn: TurnId | undefined = this.turnId): void {
		const previous = this.requireOwnUsage(turn)
		const next = maxUsage(previous, usageValue(usage))
		this.checkAggregateReplacement(previous, next)
		this.node.usage[turn as TurnId] = next
		this.persist()
	}

	async beginRequest(): Promise<string> {
		if (this.admissionBlocked())
			throw new Error('Token budget has unresolved spend or an accounting failure')
		if (this.node.settled) throw new Error('Token budget is settled')
		if (this.remaining <= 0) throw new Error('Token budget is exhausted')
		const turn = this.turnId
		if (turn === undefined) throw new Error('Token budget turn is not bound')
		// Requests on different child scopes may run concurrently. The same
		// account cannot promise its unmeasured allowance twice.
		if (this.hasRequest(this.node)) throw new Error('Token budget has an in-flight request')
		const requestId = uuidv7()
		this.ledger.requests.set(requestId, { id: requestId, accountId: this.accountId, turnId: turn })
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
		request.unresolved = true
		try {
			if (usage !== undefined) this.recordRequestUsage(request, usage)
		} catch (error) {
			this.ledger.poisoned = true
			this.persist()
			await this.flush()
			throw error
		}
		this.persist()
		await this.flush()
	}

	/**
	 * Explicit host recovery after obtaining the provider's final usage receipt.
	 * Ordinary completion never clears uncertainty. Reconciliation resolves this
	 * request after its receipt is persisted; other uncertain requests continue
	 * to constrain their shared finite allowances. Usage and settlement are retained.
	 */
	async reconcileRequest(requestId: string, usage: TokenUsage): Promise<void> {
		const measured = usageValue(usage)
		if (this.hasReceipt(requestId)) {
			const receipt = this.ledger.finishedRequests.get(
				requestId,
			) as SessionTokenBudgetRequestSnapshot
			// A recovered receipt may contain more usage than an earlier report.
			// Preserve that evidence even though ordinary duplicate completion is
			// a no-op. Repeating this same receipt still charges nothing twice.
			this.recordRequestUsage(receipt, measured)
			this.persist()
			await this.flush()
		} else {
			await this.finishRequest(requestId, measured)
		}
		const receipt = this.ledger.finishedRequests.get(requestId)
		if (receipt) receipt.unresolved = false
		this.persist()
		await this.flush()
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
				if (this.turnId === undefined)
					throw new Error('Unbound token budget cannot settle nonzero usage')
				const previous = this.requireOwnUsage(this.turnId)
				this.recordUsage({
					...previous,
					totalTokens: previous.totalTokens + ownTotalTokens - this.ownTokens,
				})
			}
		}
		this.node.settled = true
		this.persist()
	}

	summary(): SessionTokenBudgetSummary {
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
			poisoned: this.admissionBlocked(),
			unresolvedRequests: this.uncertainRequests().filter((request) =>
				descendants.has(request.accountId),
			).length,
		}
	}

	snapshot(): SessionTokenBudgetSnapshot {
		return structuredClone({
			v: SESSION_TOKEN_BUDGET_VERSION,
			kind: 'token-budget' as const,
			rootSessionId: this.ledger.scope.rootSessionId,
			rootTurnId: this.ledger.scope.rootTurnId,
			limit: this.requireAccount(this.ledger.rootAccountId).limit,
			rootAccountId: this.ledger.rootAccountId,
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

	private uncertainRequests(): SessionTokenBudgetRequestSnapshot[] {
		return [...this.ledger.requests.values(), ...this.ledger.finishedRequests.values()].filter(
			(request) => request.unresolved === true,
		)
	}
	private admissionBlocked(): boolean {
		if (this.ledger.poisoned || this.ledger.persistenceError !== undefined) return true
		const uncertain = this.uncertainRequests()
		if (uncertain.length === 0) return false
		// An account cannot resume its own uncertain request, even without a cap.
		if (uncertain.some((request) => request.accountId === this.accountId)) return true
		let cursor = this.node
		for (;;) {
			if (cursor.limit > 0) {
				const descendants = this.descendants(cursor)
				if (uncertain.some((request) => descendants.has(request.accountId))) return true
			}
			if (cursor.parentId === undefined) return false
			cursor = this.requireAccount(cursor.parentId)
		}
	}

	private get node(): SessionTokenBudgetAccountSnapshot {
		return this.requireAccount(this.accountId)
	}
	private requireAccount(accountId: string): SessionTokenBudgetAccountSnapshot {
		const account = this.ledger.accounts.get(accountId)
		if (!account) throw new Error('Unknown token budget account')
		return account
	}
	private requireOwnUsage(turn: TurnId | undefined): TokenUsage {
		const usage = turn === undefined ? undefined : this.node.usage[turn]
		if (!usage) throw new Error('Token budget turn is not bound')
		return usage
	}
	private hasReceipt(requestId: string): boolean {
		const receipt = this.ledger.finishedRequests.get(requestId)
		if (receipt && receipt.accountId !== this.accountId)
			throw new Error('Token budget receipt belongs to another account')
		return receipt !== undefined
	}
	private recordRequestUsage(request: SessionTokenBudgetRequestSnapshot, usage: TokenUsage): void {
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
		const previous = this.requireOwnUsage(request.turnId)
		const next = addUsage(previous, delta)
		this.checkAggregateReplacement(previous, next)
		this.node.usage[request.turnId] = next
		request.usage = measured
	}
	private children(node: SessionTokenBudgetAccountSnapshot): SessionTokenBudgetAccountSnapshot[] {
		return [...this.ledger.accounts.values()].filter((account) => account.parentId === node.id)
	}
	private descendants(node: SessionTokenBudgetAccountSnapshot): Set<string> {
		return new Set([
			node.id,
			...this.children(node).flatMap((child) => [...this.descendants(child)]),
		])
	}
	private hasRequest(node: SessionTokenBudgetAccountSnapshot): boolean {
		return [...this.ledger.requests.values()].some((request) => request.accountId === node.id)
	}
	private totals(node: SessionTokenBudgetAccountSnapshot): AccountTotals {
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
	private free(node: SessionTokenBudgetAccountSnapshot): number {
		if (node.limit === 0) return Number.POSITIVE_INFINITY
		const totals = this.totals(node)
		return node.limit - totals.tree - totals.reserved
	}
	private requireRequest(requestId: string): SessionTokenBudgetRequestSnapshot {
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
