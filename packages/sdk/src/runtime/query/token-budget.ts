import { join } from 'node:path'
import type { TokenBudget } from '../../run/token-budget.js'
import { DefaultPathBuilder } from '../../session/workspace/path-builder.js'
import { DiskCheckpointStore } from '../../store/run/checkpoint-disk.js'
import { openTokenBudget } from '../../store/run/token-budget-disk.js'
import type { IterationCheckpoint } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunState } from '../../types/run/state.js'
import { validateTokenBudgetBinding } from '../../types/run/token-budget-store.js'
import type { QueryParams } from './index.js'

/** Resolve one authority before any model request or recovered tool dispatch. */
export async function resolveQueryBudget(
	params: QueryParams,
	runId: RunId,
	selected?: RunState,
): Promise<TokenBudget> {
	let saved: Pick<IterationCheckpoint, 'budgetBinding' | 'budgetAccountId'> | undefined = selected
	if (params.resumeFromCheckpoint && !saved) {
		const paths =
			params.pathBuilder ??
			new DefaultPathBuilder(join(params.workingDirectory ?? process.cwd(), '.namzu'))
		const scope = {
			tenantId: params.tenantId,
			projectId: params.projectId,
			sessionId: params.sessionId,
			runId,
			parentRunId: params.parentRunId,
		}
		const store =
			params.checkpointStore ??
			new DiskCheckpointStore(
				{
					baseDir: join(paths.sessionDir(params.projectId, params.sessionId), 'runs'),
				},
				scope,
			)
		saved = (await store.readCheckpoint(scope, params.resumeFromCheckpoint)) ?? undefined
		if (!saved) throw new Error('Cannot restore a token budget from a missing checkpoint.')
	}
	const schedulerBudget = params.taskScheduler?.budget
	if (params.taskScheduler && !schedulerBudget) {
		throw new Error('A task scheduler must expose its shared token budget account.')
	}
	if (params.budget && schedulerBudget && params.budget !== schedulerBudget) {
		throw new Error('Query and task scheduler must share the same token budget account.')
	}
	const provided = params.budget ?? schedulerBudget
	const binding =
		saved?.budgetBinding === undefined ? undefined : validateTokenBudgetBinding(saved.budgetBinding)
	if (
		binding &&
		saved?.budgetAccountId !== undefined &&
		saved.budgetAccountId !== binding.accountId
	) {
		throw new Error('Checkpoint token budget account references disagree.')
	}
	if (
		binding &&
		(binding.scope.tenantId !== params.tenantId || binding.scope.projectId !== params.projectId)
	) {
		throw new Error('Checkpoint token budget belongs to a different tenant or project.')
	}
	if (binding && binding.scope.runId === runId && binding.scope.sessionId !== params.sessionId) {
		throw new Error('Checkpoint token budget belongs to a different root session.')
	}
	if (provided) {
		const providedBinding = provided.binding
		if (
			providedBinding &&
			(providedBinding.scope.tenantId !== params.tenantId ||
				providedBinding.scope.projectId !== params.projectId ||
				(providedBinding.scope.runId === runId &&
					providedBinding.scope.sessionId !== params.sessionId))
		) {
			throw new Error('Supplied token budget belongs to a different root scope.')
		}
		if (saved?.budgetAccountId && saved.budgetAccountId !== provided.accountId) {
			throw new Error('Resume requires the original token budget account.')
		}
		if (
			binding &&
			(binding.accountId !== provided.accountId || binding.scope.runId !== provided.rootRunId)
		) {
			throw new Error('Checkpoint and supplied token budget authority disagree.')
		}
		if (
			binding &&
			(!providedBinding ||
				binding.scope.tenantId !== providedBinding.scope.tenantId ||
				binding.scope.projectId !== providedBinding.scope.projectId ||
				binding.scope.sessionId !== providedBinding.scope.sessionId ||
				binding.scope.runId !== providedBinding.scope.runId)
		) {
			throw new Error('Checkpoint and supplied token budget root scopes disagree.')
		}
		provided.bindRun(runId)
		narrowToRunLimit(provided, params.runConfig.tokenBudget)
		return provided
	}
	if (saved?.budgetAccountId && !binding) {
		throw new Error(
			'This checkpoint used an in-memory token budget. Supply its current authoritative budget to resume.',
		)
	}
	const budget = await openTokenBudget({
		store: params.tokenBudgetStore,
		pathBuilder: params.pathBuilder,
		workingDirectory: params.workingDirectory,
		scope: binding?.scope ?? {
			tenantId: params.tenantId,
			projectId: params.projectId,
			sessionId: params.sessionId,
			runId,
		},
		limit: binding && binding.scope.runId !== runId ? undefined : params.runConfig.tokenBudget,
		accountId: binding?.accountId,
		requireExisting: binding !== undefined,
	})
	budget.bindRun(runId)
	narrowToRunLimit(budget, params.runConfig.tokenBudget)
	return budget
}

function narrowToRunLimit(budget: TokenBudget, limit: number): void {
	if (limit > 0 && (budget.limit === 0 || limit < budget.limit)) budget.narrow(limit)
}
