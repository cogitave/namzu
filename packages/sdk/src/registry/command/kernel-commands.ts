import type { HostCommandDescriptor } from '../../types/command/index.js'
import type { TaskStore } from '../../types/task/index.js'

/**
 * The commands whose facts the kernel already owns.
 *
 * A registry with nothing in it is a declaration, and this repo has a rule
 * about those. These two are the ones a host currently has to reach into
 * kernel internals to answer: what work is tracked, and who this run may
 * delegate to. Both were already computed here and had no way out that did
 * not go through a specific host's UI code.
 *
 * Deliberately NOT here: anything that would need a decision the kernel
 * cannot make. `/clear` is about a transcript a host owns, `/login` about
 * credentials a host stores, `/model` about a picker a host draws. Adding
 * them would mean the SDK either rendering or refusing, and both are worse
 * than leaving the command with the host that can actually do it.
 */

export interface KernelCommandOptions {
	/** Absent is a real state — not every run tracks tasks. */
	readonly taskStore?: TaskStore
	readonly allowedAgentIds?: readonly string[]
}

export function kernelHostCommands(options: KernelCommandOptions): HostCommandDescriptor[] {
	return [
		{
			name: 'tasks',
			description: 'List the work this run is tracking.',
			hint: 'id, status, owner and subject for every task in the store',
			async handler() {
				// REFUSED rather than an empty report. "There are no tasks" and
				// "this run has no task store" are different answers, and a host
				// that shows the first for the second gives an operator a
				// confident zero nobody computed.
				if (!options.taskStore) {
					return {
						kind: 'refused',
						reason: 'This run has no task store, so there is nothing to list.',
					}
				}
				const tasks = await options.taskStore.list()
				return {
					kind: 'report',
					title: 'Tasks',
					rows: tasks.map((task) => ({
						id: task.id,
						status: task.status,
						owner: task.owner ?? null,
						subject: task.subject,
					})),
				}
			},
		},
		{
			name: 'agents',
			description: 'List the agents this run may delegate to.',
			hint: 'the roster, as the delegation tools see it',
			handler() {
				// An empty roster IS the answer here, unlike the store above: the
				// question is "who may I call", and "nobody" is a complete and
				// correct reply that a run with delegation off should get.
				return {
					kind: 'report',
					title: 'Agents',
					rows: (options.allowedAgentIds ?? []).map((id) => ({ id })),
				}
			},
		},
	]
}
