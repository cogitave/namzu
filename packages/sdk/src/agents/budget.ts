import { resolveNamzuHome } from '../session/home.js'
import { SessionPaths, ensureProject } from '../session/paths.js'
import {
	DiskSessionTokenBudgetStore,
	InMemorySessionTokenBudgetStore,
	SessionTokenBudget,
	type SessionTokenBudgetStore,
	openSessionTokenBudget,
} from '../store/budget/index.js'
import { InMemorySessionLog } from '../store/session-log/index.js'
import type { AgentInput, BaseAgentConfig } from '../types/agent/base.js'
import type { SessionId, TurnId } from '../types/ids/index.js'

/** The turn a composite agent is about to run, which its ledger is keyed by. */
export interface AgentTurn {
	readonly sessionId: SessionId
	readonly turnId: TurnId
}

/**
 * Held per in-memory session log, so every turn of one in-memory session
 * finds its ledgers in the same place and nothing reaches the disk.
 */
const inMemoryLedgers = new WeakMap<InMemorySessionLog, InMemorySessionTokenBudgetStore>()

/**
 * Where a root turn's ledger lives when the agent was handed none:
 *
 * - beside an in-memory session log with no `paths`: in memory, held for
 *   that log;
 * - otherwise on disk, at `<session-id>/budgets/<turn-id>.json` in the
 *   project the config's `paths` (or the working directory under
 *   `NAMZU_HOME`) names.
 */
async function ledgerStore(
	input: AgentInput,
	config: BaseAgentConfig,
): Promise<SessionTokenBudgetStore> {
	const log = config.sessionLog
	if (log instanceof InMemorySessionLog && config.paths === undefined) {
		let store = inMemoryLedgers.get(log)
		if (!store) {
			store = new InMemorySessionTokenBudgetStore()
			inMemoryLedgers.set(log, store)
		}
		return store
	}
	if (config.paths) return new DiskSessionTokenBudgetStore({ paths: config.paths })
	const home = resolveNamzuHome()
	const project = await ensureProject({ home, cwd: input.workingDirectory })
	return new DiskSessionTokenBudgetStore({
		paths: new SessionPaths({ home, slug: project.slug }),
	})
}

/**
 * Resolve one authority before a composite agent constructs its scheduler.
 *
 * An inherited budget (a delegated child's reservation, or a host's) is bound
 * to this turn with `bindTurn`, so its spend is attributed to the child
 * session's turn while it stays keyed by the root turn that opened the
 * ledger. A root turn opens a ledger of its own, keyed by
 * `(sessionId, turnId)`: a new turn gets a new ledger and its own limit.
 */
export async function resolveAgentBudget(
	input: AgentInput,
	config: BaseAgentConfig,
	turn: AgentTurn,
): Promise<SessionTokenBudget> {
	if (!Number.isSafeInteger(config.tokenBudget) || config.tokenBudget < 0) {
		throw new Error('Agent token budget must be a nonnegative safe integer')
	}
	if (config.budget) {
		config.budget.bindTurn(turn.sessionId, turn.turnId)
		if (
			config.tokenBudget > 0 &&
			(config.budget.limit === 0 || config.tokenBudget < config.budget.limit)
		) {
			config.budget.narrow(config.tokenBudget)
		}
		await config.budget.flush()
		return config.budget
	}
	if (config.parentSessionId) {
		throw new Error('A delegated agent requires its inherited token budget authority')
	}
	const scope = { rootSessionId: turn.sessionId, rootTurnId: turn.turnId }
	const budget =
		config.tenantId && config.projectId && config.sessionId
			? await openSessionTokenBudget({
					scope,
					limit: config.tokenBudget,
					store: await ledgerStore(input, config),
				})
			: SessionTokenBudget.create(config.tokenBudget, scope)
	budget.bindTurn(turn.sessionId, turn.turnId)
	await budget.flush()
	return budget
}
