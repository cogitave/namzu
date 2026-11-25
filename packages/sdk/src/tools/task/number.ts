import { isClaimableTaskStore } from '../../store/task/file.js'
import type { TaskStore } from '../../types/task/index.js'

/**
 * The number a task of a shared (team) list is shown under: its place in the list, lowest id first,
 * from 1. A team's screens say `#2`, not a UUID, and this is the same count. A list only one session
 * uses has no numbers; there the id stays the only handle.
 */
export async function taskNumbers(store: TaskStore): Promise<ReadonlyMap<string, number>> {
	if (!isClaimableTaskStore(store)) return new Map()
	const tasks = await store.list()
	const ids = tasks.map((task) => String(task.id)).sort(byId)
	return new Map(ids.map((id, index) => [id, index + 1]))
}

function byId(a: string, b: string): number {
	const left = Number(a)
	const right = Number(b)
	if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right
	return a < b ? -1 : a > b ? 1 : 0
}

/** The id the model needs, set apart so a screen can leave it out. */
const ID_TAIL = /^(Task (?:created: )?#\d+) \(id [^)]*\)/

/**
 * A task tool's receipt as a person reads it: the handle the model needs to call the next tool is
 * dropped where the receipt already names the task by its number.
 */
export function plainTaskReceipt(output: string): string {
	return output.replace(ID_TAIL, '$1')
}
