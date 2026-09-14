import { z } from 'zod'
import type { HarnessComparison } from './harness-verification.js'

/** Host-selected preservation tasks, fixed before generation and disjoint across rounds. */
export interface HarnessProtectionPlan {
	readonly verification: readonly string[]
	readonly confirmation: readonly string[]
}

/** Recorded preservation evidence, not a guarantee about untested tasks. */
export interface HarnessProtectionCheck {
	readonly status: 'passed' | 'failed' | 'inconclusive'
	readonly missingTasks: readonly string[]
	readonly unprovenTasks: readonly string[]
	readonly regressedTasks: readonly string[]
}

const tasks = z
	.array(
		z
			.string()
			.min(1)
			.max(256)
			.refine((s) => s.trim() === s),
	)
	.min(1)
	.max(63)
const planSchema = z
	.object({ verification: tasks, confirmation: tasks })
	.strict()
	.superRefine((plan, ctx) => {
		const all = [...plan.verification, ...plan.confirmation]
		if (new Set(all).size !== all.length)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Protection tasks must be unique and fresh across rounds.',
			})
	})

/** Internal validated immutable admission snapshot. */
export function normalizeHarnessProtection(input: HarnessProtectionPlan): HarnessProtectionPlan {
	if (input === undefined || input === null)
		throw new Error(
			'Declare protection.verification and protection.confirmation task IDs before resident learning or promotion.',
		)
	const plan = planSchema.parse(input)
	return Object.freeze({
		verification: Object.freeze(plan.verification),
		confirmation: Object.freeze(plan.confirmation),
	})
}

/** Internal: both baseline trials must succeed before preservation can be established. */
export function checkHarnessProtection(
	report: HarnessComparison,
	tasks: readonly string[],
): HarnessProtectionCheck {
	const missingTasks: string[] = []
	const unprovenTasks: string[] = []
	const regressedTasks: string[] = []
	for (const id of tasks) {
		const task = report.tasks.find((t) => t.taskId === id)
		if (!task) missingTasks.push(id)
		else if (task.trials !== 2 || task.status === 'inconclusive' || task.baselinePasses !== 2)
			unprovenTasks.push(id)
		else if (task.candidatePasses !== 2 || report.regressions.includes(id)) regressedTasks.push(id)
		else if (report.unresolved.includes(id)) unprovenTasks.push(id)
	}
	return {
		status: regressedTasks.length
			? 'failed'
			: missingTasks.length || unprovenTasks.length
				? 'inconclusive'
				: 'passed',
		missingTasks,
		unprovenTasks,
		regressedTasks,
	}
}
