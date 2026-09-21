import type { TurnId } from '../../types/ids/index.js'
import { type Task, isTerminalTaskStatus } from '../../types/task/index.js'

/** The turn a task view is drawn for. */
export interface TaskContextScope {
	/** The turn being run. */
	readonly turnId: TurnId
	/**
	 * When that turn started (epoch milliseconds). A resumed turn keeps the
	 * time it first started, so a task it closed before parking still counts.
	 */
	readonly turnStartedAt: number
}

/**
 * The tasks a turn is shown (spec §4.5): every open task, whichever turn
 * created it, and the tasks closed during this turn. A task closed in an
 * earlier turn is left out — the list is durable per session, and without
 * this every finished item of every earlier turn would be re-read into each
 * new one.
 *
 * A task counts as closed in this turn when it reached a terminal status at
 * or after `turnStartedAt`, or when this turn created it (it cannot have
 * closed before it existed). Order is kept.
 */
export function selectTaskContext(tasks: readonly Task[], scope: TaskContextScope): Task[] {
	return tasks.filter(
		(task) =>
			!isTerminalTaskStatus(task.status) ||
			task.turnId === scope.turnId ||
			(task.completedAt !== undefined && task.completedAt >= scope.turnStartedAt),
	)
}
