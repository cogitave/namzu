import {
	DiskSessionLog,
	type ProjectId,
	type SessionId,
	SessionPaths,
	type SessionRecordDraft,
	type TenantId,
	type TurnId,
	generateMessageId,
} from '@namzu/sdk'

/** The token-budget summary a settled turn records, as the SDK's schema admits it. */
export interface StepBudget {
	readonly ownTokens: number
	readonly treeTokens: number
	readonly inFlightRequests: number
	readonly unsettledChildren: number
	readonly poisoned: boolean
	readonly unresolvedRequests?: number
}

export interface ResidentStepLogOptions {
	readonly home: string
	readonly slug: string
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly projectId: ProjectId
	readonly tenantId: TenantId
	/** Settled usage of the turn. Absent leaves the turn open, as a crash mid-step does. */
	readonly totalTokens?: number
	readonly budget?: StepBudget
}

/**
 * Write the session log one resident step leaves behind: `session_started`,
 * the step's `turn_started`, and (unless the step never settled) its
 * `turn_completed`. Written through the SDK's own log, so the chain is real.
 */
export async function writeResidentStepLog(options: ResidentStepLogOptions): Promise<string> {
	const paths = new SessionPaths({ home: options.home, slug: options.slug })
	const log = DiskSessionLog.at(paths, { sessionId: options.sessionId })
	const lease = await log.claim({ holder: 'resident-step-fixture', ttlMs: 60_000 })
	if (!lease) throw new Error('fixture could not claim its session log')
	await log.append(lease, {
		type: 'session_started',
		projectId: options.projectId,
		tenantId: options.tenantId,
		cwd: options.home,
		agent: { id: 'resident', name: 'resident' },
	} as SessionRecordDraft)
	await log.beginTurn(lease, {
		turnId: options.turnId,
		userMessageId: generateMessageId(),
		config: { model: 'm', tokenBudget: 0, maxIterations: 0, timeoutMs: 0 },
		origin: { protocol: 'resident', kind: 'resident-step' },
	})
	if (options.totalTokens !== undefined) {
		const tokens = options.totalTokens
		await log.append(lease, {
			type: 'turn_completed',
			turnId: options.turnId,
			result: '{"kind":"complete","summary":"done"}',
			stopReason: 'end_turn',
			...(options.budget
				? {
						budget: {
							limit: 0,
							reservedTokens: 0,
							remainingTokens: null,
							...options.budget,
						},
					}
				: {}),
			settlement: {
				status: 'completed',
				iterations: 1,
				usage: {
					promptTokens: tokens,
					completionTokens: 0,
					totalTokens: tokens,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
				durationMs: 1,
				resultSource: 'model',
				abandonedTaskIds: [],
				abandonedJobIds: [],
			},
		} as SessionRecordDraft)
	}
	await log.release(lease)
	return paths.sessionLog({ sessionId: options.sessionId })
}
