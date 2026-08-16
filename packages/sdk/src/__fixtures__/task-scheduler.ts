import type { TaskHandle, TaskScheduler } from '../types/agent/scheduler.js'
import type { TaskId } from '../types/ids/index.js'

/**
 * A `TaskScheduler` a test can hand to the runtime without implementing the
 * five methods it does not exercise.
 *
 * The tests that needed this were passing two-method object literals through
 * `as never`, which is a cast that disables checking on the WHOLE argument
 * rather than on the part that is genuinely absent. So the stub matched the
 * interface at the moment it was written and nothing re-checked it after —
 * exactly the way a fixture drifts from the production shape it stands in
 * for (`docs/conventions/fixture-must-match-production.md`).
 *
 * The unsupplied methods THROW rather than returning a plausible empty
 * value. A stub that quietly answers `undefined`/`[]` lets a test keep
 * passing after the code under test starts calling it, and the assertion
 * that then holds is about the stub, not about the kernel. Throwing turns
 * that same event into a failure naming the method.
 */
export function stubTaskScheduler(overrides: Partial<TaskScheduler>): TaskScheduler {
	const unsupported = (method: string): never => {
		throw new Error(`stubTaskScheduler: this test did not supply ${method}()`)
	}

	return {
		createTask: () => unsupported('createTask'),
		waitForTask: () => unsupported('waitForTask'),
		continueTask: () => unsupported('continueTask'),
		cancelTask: () => unsupported('cancelTask'),
		getTask: (_taskId: TaskId): TaskHandle | undefined => unsupported('getTask'),
		listTasks: () => unsupported('listTasks'),
		onTaskCompleted: () => unsupported('onTaskCompleted'),
		...overrides,
	}
}
