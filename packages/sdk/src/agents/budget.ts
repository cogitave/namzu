import { TokenBudget } from '../run/token-budget.js'
import { openTokenBudget } from '../store/run/token-budget-disk.js'
import type { AgentInput, BaseAgentConfig } from '../types/agent/base.js'
import type { RunId } from '../types/ids/index.js'

/** Resolve one authority before a composite agent constructs its scheduler. */
export async function resolveAgentBudget(
	input: AgentInput,
	config: BaseAgentConfig,
	runId: RunId,
): Promise<TokenBudget> {
	if (!Number.isSafeInteger(config.tokenBudget) || config.tokenBudget < 0) {
		throw new Error('Agent token budget must be a nonnegative safe integer')
	}
	if (config.budget) {
		config.budget.bindRun(runId)
		if (
			config.tokenBudget > 0 &&
			(config.budget.limit === 0 || config.tokenBudget < config.budget.limit)
		) {
			config.budget.narrow(config.tokenBudget)
		}
		await config.budget.flush()
		return config.budget
	}
	if (config.parentRunId) {
		throw new Error('A delegated agent requires its inherited token budget authority')
	}
	const { tenantId, projectId, sessionId } = config
	const budget =
		tenantId && projectId && sessionId
			? await openTokenBudget({
					scope: { tenantId, projectId, sessionId, runId },
					limit: config.tokenBudget,
					pathBuilder: config.pathBuilder,
					workingDirectory: input.workingDirectory,
				})
			: TokenBudget.create(config.tokenBudget, runId)
	budget.bindRun(runId)
	await budget.flush()
	return budget
}
