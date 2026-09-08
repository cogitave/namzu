import type { CaseResult } from './types.js'

/** A host-owned outcome, with enough identity to check pairing and cite its trace. */
export interface HarnessTrial {
	taskId: string
	trial: number
	/** Environment/seed/model/limits fingerprint. Equal within a pair, fresh in confirmation. */
	conditions: string
	trajectoryId: string
	result: CaseResult
}

export interface HarnessAttribution {
	taskId: string
	effect: 'improvement' | 'regression' | 'unresolved'
	reason: string
	baselineTrajectories: readonly string[]
	candidateTrajectories: readonly string[]
}

export interface HarnessVerificationBatch {
	baselineRevision: string
	candidateRevision: string
	baseline: readonly HarnessTrial[]
	candidate: readonly HarnessTrial[]
	/** Supplied by an independent trace reviewer, never inferred from scores alone. */
	attributions: readonly HarnessAttribution[]
}

export type HarnessBehaviorStatus =
	| 'recovered'
	| 'stable-success'
	| 'regressed'
	| 'still-failing'
	| 'mixed'
	| 'inconclusive'

export interface HarnessTaskComparison {
	taskId: string
	status: HarnessBehaviorStatus
	baselinePasses: number
	candidatePasses: number
	trials: number
}

export interface HarnessComparison {
	tasks: readonly HarnessTaskComparison[]
	/** Paired trial pass-rate difference, not held-out pass@1 or causal evidence. */
	passRateDelta: number | null
	positiveEvidence: readonly string[]
	regressions: readonly string[]
	unresolved: readonly string[]
	/** Actual recorded consumption from BOTH sides, including unsuccessful runs. */
	usage: { rollouts: number; tokens: number; costUsd: number; durationMs: number }
}

function nonempty(value: string): boolean {
	return typeof value === 'string' && value.trim().length > 0
}

function key(trial: HarnessTrial): string {
	return JSON.stringify([trial.taskId, trial.trial])
}

function indexTrials(trials: readonly HarnessTrial[]): Map<string, HarnessTrial> {
	const result = new Map<string, HarnessTrial>()
	const traces = new Set<string>()
	for (const trial of trials) {
		if (
			!nonempty(trial.taskId) ||
			!nonempty(trial.conditions) ||
			!nonempty(trial.trajectoryId) ||
			!Number.isSafeInteger(trial.trial) ||
			trial.trial < 0
		)
			throw new Error(
				'A harness trial needs a task, nonnegative trial index, conditions and trajectory ID.',
			)
		if (result.has(key(trial)) || traces.has(trial.trajectoryId))
			throw new Error('Duplicate harness trial or trajectory ID.')
		result.set(key(trial), trial)
		traces.add(trial.trajectoryId)
	}
	return result
}

function measured(trial: HarnessTrial): boolean {
	const { result } = trial
	const scores = Object.values(result.scores)
	return (
		!result.run.error &&
		(result.status === 'passed' || result.status === 'failed') &&
		scores.length > 0 &&
		scores.every((s) => !s.unavailable && Number.isFinite(s.score) && s.score >= 0 && s.score <= 1)
	)
}

/** HarnessLens Table 6 comparison plus explicit, trace-linked attribution. No model calls. */
export function compareHarnessTrials(batch: HarnessVerificationBatch): HarnessComparison {
	if (
		!nonempty(batch.baselineRevision) ||
		!nonempty(batch.candidateRevision) ||
		batch.baselineRevision === batch.candidateRevision
	)
		throw new Error('Distinct baseline and candidate revisions are required.')
	const baseline = indexTrials(batch.baseline)
	const candidate = indexTrials(batch.candidate)
	if (!baseline.size || baseline.size !== candidate.size)
		throw new Error('Complete paired trials are required.')
	const baselineTraces = new Set(batch.baseline.map((t) => t.trajectoryId))
	if (batch.candidate.some((t) => baselineTraces.has(t.trajectoryId)))
		throw new Error('Baseline and candidate must have distinct trajectories.')
	const groups = new Map<string, HarnessTrial[]>()
	for (const [id, before] of baseline) {
		const after = candidate.get(id)
		if (!after || before.conditions !== after.conditions)
			throw new Error('Harness trial conditions do not match.')
		const group = groups.get(before.taskId) ?? []
		group.push(before)
		groups.set(before.taskId, group)
	}
	const tasks: HarnessTaskComparison[] = []
	for (const [taskId, before] of groups) {
		if (new Set(before.map((t) => t.conditions)).size !== before.length)
			throw new Error('Repeated trials need distinct controlled conditions.')
		const after = before.map((t) => candidate.get(key(t)) as HarnessTrial)
		const b = before.filter((t) => t.result.status === 'passed').length
		const c = after.filter((t) => t.result.status === 'passed').length
		const status: HarnessBehaviorStatus = ![...before, ...after].every(measured)
			? 'inconclusive'
			: b === 0 && c > 0
				? 'recovered'
				: b > 0 && c === after.length
					? 'stable-success'
					: b > 0 && c === 0
						? 'regressed'
						: b === 0 && c === 0
							? 'still-failing'
							: 'mixed'
		tasks.push({ taskId, status, baselinePasses: b, candidatePasses: c, trials: before.length })
	}
	const positive = new Set<string>()
	const regressions = new Set<string>()
	const unresolved = new Set(
		tasks.filter((t) => t.status === 'inconclusive' || t.status === 'mixed').map((t) => t.taskId),
	)
	// Conservative Namzu policy: even an unattributed observed regression blocks promotion.
	for (const task of tasks) if (task.status === 'regressed') regressions.add(task.taskId)
	for (const evidence of batch.attributions) {
		const task = tasks.find((t) => t.taskId === evidence.taskId)
		const cites = (ids: readonly string[], trials: readonly HarnessTrial[]) =>
			ids.length > 0 &&
			ids.every((id) => trials.some((t) => t.taskId === evidence.taskId && t.trajectoryId === id))
		if (
			!task ||
			!nonempty(evidence.reason) ||
			!cites(evidence.baselineTrajectories, batch.baseline) ||
			!cites(evidence.candidateTrajectories, batch.candidate) ||
			!['improvement', 'regression', 'unresolved'].includes(evidence.effect)
		)
			throw new Error('Attribution must explain and cite both sides of an existing task.')
		if (evidence.effect === 'regression') regressions.add(task.taskId)
		else if (evidence.effect === 'unresolved') unresolved.add(task.taskId)
		else if (
			task.status === 'recovered' ||
			(task.status === 'stable-success' && task.candidatePasses > task.baselinePasses)
		)
			positive.add(task.taskId)
	}
	const usage = { rollouts: baseline.size * 2, tokens: 0, costUsd: 0, durationMs: 0 }
	for (const trial of [...batch.baseline, ...batch.candidate]) {
		const values = [
			trial.result.run.totalTokens,
			trial.result.run.totalCostUsd,
			trial.result.run.durationMs,
		]
		if (values.some((n) => !Number.isFinite(n) || n < 0))
			throw new Error('Invalid recorded harness usage.')
		usage.tokens += trial.result.run.totalTokens
		usage.costUsd += trial.result.run.totalCostUsd
		usage.durationMs += trial.result.run.durationMs
	}
	return {
		tasks,
		positiveEvidence: [...positive],
		regressions: [...regressions],
		unresolved: [...unresolved],
		usage,
		passRateDelta: tasks.some((t) => t.status === 'inconclusive')
			? null
			: tasks.reduce((sum, t) => sum + t.candidatePasses - t.baselinePasses, 0) / baseline.size,
	}
}

export interface HarnessReview {
	decision: 'accept' | 'reject' | 'inconclusive'
	reason: string
	verification: HarnessComparison
	confirmation?: HarnessComparison
}

/**
 * Evaluate recorded evidence; never applies a patch. Requires at least five tasks,
 * exactly two trials per task, and a same-size confirmation with at most two reused tasks.
 * Hosts own isolated execution, task selection, scoring and independent trace review.
 */
export function reviewHarnessCandidate(
	verification: HarnessVerificationBatch,
	confirmation?: HarnessVerificationBatch,
): HarnessReview {
	const first = compareHarnessTrials(verification)
	const second = confirmation ? compareHarnessTrials(confirmation) : undefined
	const result = (decision: HarnessReview['decision'], reason: string): HarnessReview => ({
		decision,
		reason,
		verification: first,
		...(second ? { confirmation: second } : {}),
	})
	const sufficient = (report: HarnessComparison) =>
		report.tasks.length >= 5 && report.tasks.every((t) => t.trials === 2)
	if (!sufficient(first))
		return result(
			'inconclusive',
			'Verification requires at least five distinct tasks and two paired trials per task.',
		)
	if (first.regressions.length || second?.regressions.length)
		return result('reject', 'Observed or attributed regression blocks promotion.')
	if (first.unresolved.length || second?.unresolved.length)
		return result('inconclusive', 'Incomplete or ambiguous behavioral evidence.')
	if (!first.positiveEvidence.length)
		return result(
			'reject',
			'A metric increase or preservation alone is not attributable improvement.',
		)
	if (!confirmation || !second)
		return result('inconclusive', 'A complete fresh confirmation round is required.')
	if (
		verification.baselineRevision !== confirmation.baselineRevision ||
		verification.candidateRevision !== confirmation.candidateRevision
	)
		return result('inconclusive', 'Revisions changed between verification and confirmation.')
	const firstTasks = new Set(first.tasks.map((t) => t.taskId))
	if (
		!sufficient(second) ||
		second.tasks.length !== first.tasks.length ||
		second.tasks.filter((t) => firstTasks.has(t.taskId)).length > 2
	)
		return result(
			'inconclusive',
			'Confirmation must use the same batch size with at most two reused tasks.',
		)
	const conditions = new Set(verification.baseline.map((t) => t.conditions))
	const traces = new Set(
		[...verification.baseline, ...verification.candidate].map((t) => t.trajectoryId),
	)
	if (
		confirmation.baseline.some((t) => conditions.has(t.conditions)) ||
		[...confirmation.baseline, ...confirmation.candidate].some((t) => traces.has(t.trajectoryId))
	)
		return result('inconclusive', 'Confirmation requires fresh conditions and trajectories.')
	if (!second.positiveEvidence.length || second.passRateDelta === null || second.passRateDelta <= 0)
		return result(
			'reject',
			'Confirmation needs attributable improvement and a positive primary-metric difference.',
		)
	return result(
		'accept',
		'Both rounds support improvement without observed regression; confirmation improves the paired pass rate.',
	)
}
