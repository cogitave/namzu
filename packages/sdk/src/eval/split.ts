import { createHash } from 'node:crypto'
import { EvalUsageError } from './bootstrap.js'
import type { EvalSplit } from './types.js'

/**
 * Which tasks a harness setting may be chosen on, and which it is judged on.
 *
 * A setting tuned against some tasks and then judged on the same tasks has been
 * shown to fit them, and nothing more. Every task belongs to one of two splits:
 * `tune`, the tasks to choose settings on, and `held-out`, the tasks to judge
 * the choice on. The split of a task is a function of its identity and a fixed
 * seed, so the same task is in the same split on every machine, in every run,
 * whoever runs it. A suite may state a task's split itself, and that wins.
 */
export type TaskSplit = 'tune' | 'held-out'

/** What `namzu eval --split` selects. */
export type SplitFilter = TaskSplit | 'all'

export const SPLIT_FILTERS: readonly SplitFilter[] = ['tune', 'held-out', 'all']

/** The seed of the assignment. Fixed in the kernel and written into every report. */
export const TASK_SPLIT_SEED = 'namzu-eval-split-1'

/** The share of tasks assigned to `held-out`, written into every report. */
export const HELD_OUT_FRACTION = 0.5

export const TASK_SPLIT_ALGORITHM =
	'sha256(seed, suite, task) as a fraction; held-out when below the share'

/** The id of a task: its suite and its case name, which is unique within the suite. */
export function taskId(suite: string, name: string): string {
	return `${suite}/${name}`
}

/** The split a seeded hash assigns to a task, whatever a suite declares. */
export function hashedSplit(suite: string, name: string): TaskSplit {
	const digest = createHash('sha256')
		.update(`${TASK_SPLIT_SEED}\u0000${suite}\u0000${name}`)
		.digest()
	// Six bytes: 48 bits, exact in a double.
	const fraction = digest.readUIntBE(0, 6) / 2 ** 48
	return fraction < HELD_OUT_FRACTION ? 'held-out' : 'tune'
}

/**
 * The split of a task. A declared split wins; `development`, the name a case
 * declares for the tasks a harness was shaped against, is `tune`.
 */
export function assignSplit(
	suite: string,
	name: string,
	declared?: EvalSplit,
): { split: TaskSplit; declared: boolean } {
	if (declared === 'held-out') return { split: 'held-out', declared: true }
	if (declared === 'development') return { split: 'tune', declared: true }
	return { split: hashedSplit(suite, name), declared: false }
}

export function validateSplitFilter(value: string | undefined): SplitFilter {
	if (value === undefined) return 'all'
	if (!SPLIT_FILTERS.includes(value as SplitFilter)) {
		throw new EvalUsageError(
			`split must be "tune", "held-out" or "all"; received ${JSON.stringify(value)}`,
		)
	}
	return value as SplitFilter
}

/** The tasks a suite ran, and how they were assigned. Written into the suite's report. */
export interface ReportTaskSplit {
	/** What the run asked for. */
	readonly requested: SplitFilter
	readonly seed: typeof TASK_SPLIT_SEED
	/** The share of tasks assigned to `held-out` when a suite does not say. */
	readonly heldOutFraction: number
	/** The tasks that ran, in the suite's order, each with its split. */
	readonly tasks: readonly {
		readonly id: string
		readonly split: TaskSplit
		readonly declared: boolean
	}[]
}
