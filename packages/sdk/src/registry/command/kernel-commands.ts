import {
	GoalExistsError,
	GoalNotFoundError,
	GoalSessionNotFoundError,
	GoalTransitionError,
	type SessionGoalStore,
	StaleGoalError,
} from '../../store/goal/index.js'
import type { HostCommandDescriptor } from '../../types/command/index.js'
import type { GoalRef, SessionGoal } from '../../types/goal/index.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { Skill } from '../../types/skills/index.js'
import { isInvocableBy, skillInvocation } from '../../types/skills/index.js'
import type { TaskStore } from '../../types/task/index.js'

/**
 * The commands whose facts the kernel already owns.
 *
 * A registry with nothing in it is a declaration, and this repo has a rule
 * about those. These are facts a host would otherwise have to reach into
 * kernel internals to answer: the current Session goal, tracked work,
 * operator-invocable skills, and the agents this run may delegate to. Each is
 * computed or owned here and should not acquire a second host-specific source.
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
	/**
	 * The run's skills, for the operator-facing half of the listing.
	 *
	 * Absent is a real state: a run with no skills registry has none, which
	 * is different from having none registered.
	 */
	readonly skills?: readonly Skill[]
	/** Exact durable conversation scope behind the direct-human `/goal` command. */
	readonly goal?: GoalCommandScope
}

export interface GoalCommandScope {
	readonly store: SessionGoalStore
	readonly sessionId: SessionId
	readonly tenantId: TenantId
}

const GOAL_USAGE = 'Usage: /goal [<objective>|clear|edit <objective>|pause|resume]'

type ParsedGoalCommand =
	| { readonly kind: 'show' }
	| { readonly kind: 'create'; readonly objective: string }
	| { readonly kind: 'edit'; readonly objective: string }
	| { readonly kind: 'invalid-edit' }
	| { readonly kind: 'pause' }
	| { readonly kind: 'resume' }
	| { readonly kind: 'clear' }

function parseGoalCommand(args: readonly string[]): ParsedGoalCommand {
	const input = args.join(' ').trim()
	if (input.length === 0) return { kind: 'show' }
	const control = input.toLowerCase()
	if (control === 'clear') return { kind: 'clear' }
	if (control === 'pause') return { kind: 'pause' }
	if (control === 'resume') return { kind: 'resume' }
	if (control === 'edit') return { kind: 'invalid-edit' }
	if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
	return { kind: 'create', objective: input }
}

function goalRef(goal: SessionGoal): GoalRef {
	return { id: goal.id, revision: goal.revision }
}

function goalCommands(goal: SessionGoal): string {
	if (goal.phase === 'active') return '/goal edit <objective>, /goal pause, /goal clear'
	if (goal.phase === 'paused' || goal.phase === 'blocked') {
		return '/goal edit <objective>, /goal resume, /goal clear'
	}
	return '/goal <objective>, /goal clear'
}

function renderGoal(title: string, goal: SessionGoal): string {
	return [
		title,
		`Status: ${goal.phase}`,
		...(goal.blockedReason
			? [`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`]
			: []),
		`Objective: ${goal.objective}`,
		'',
		`Commands: ${goalCommands(goal)}`,
	].join('\n')
}

function missingGoal(action: string) {
	return {
		kind: 'refused' as const,
		reason: `No goal is currently set; /goal ${action} requires one. ${GOAL_USAGE}`,
	}
}

async function runGoalCommand(scope: GoalCommandScope | undefined, args: readonly string[]) {
	if (!scope) {
		return {
			kind: 'refused' as const,
			reason: 'Goals need a durable session. This host did not supply one for the current command.',
		}
	}
	const command = parseGoalCommand(args)
	try {
		const current = await scope.store.getGoal(scope.sessionId, scope.tenantId)
		switch (command.kind) {
			case 'show':
				return current
					? { kind: 'ack' as const, message: renderGoal('Goal', current) }
					: {
							kind: 'ack' as const,
							message: `No goal is currently set.\n${GOAL_USAGE}`,
						}
			case 'invalid-edit':
				return {
					kind: 'refused' as const,
					reason: `Goal editing requires a replacement objective.\n${GOAL_USAGE}`,
				}
			case 'create':
				if (current && current.phase !== 'complete') {
					return {
						kind: 'refused' as const,
						reason: `A goal is already ${current.phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
					}
				}
				return {
					kind: 'ack' as const,
					message: renderGoal(
						'Goal created',
						await scope.store.createGoal(
							{ sessionId: scope.sessionId, objective: command.objective },
							scope.tenantId,
						),
					),
				}
			case 'edit':
				if (!current) return missingGoal('edit')
				if (current.phase === 'complete') {
					return {
						kind: 'ack' as const,
						message: renderGoal(
							'Goal created',
							await scope.store.createGoal(
								{ sessionId: scope.sessionId, objective: command.objective },
								scope.tenantId,
							),
						),
					}
				}
				return {
					kind: 'ack' as const,
					message: renderGoal(
						'Goal updated',
						await scope.store.editGoal(scope.sessionId, scope.tenantId, goalRef(current), {
							objective: command.objective,
						}),
					),
				}
			case 'pause':
				if (!current) return missingGoal('pause')
				return {
					kind: 'ack' as const,
					message: renderGoal(
						'Goal paused',
						await scope.store.pauseGoal(scope.sessionId, scope.tenantId, goalRef(current)),
					),
				}
			case 'resume':
				if (!current) return missingGoal('resume')
				return {
					kind: 'ack' as const,
					message: renderGoal(
						'Goal resumed',
						await scope.store.resumeGoal(scope.sessionId, scope.tenantId, goalRef(current)),
					),
				}
			case 'clear':
				if (!current) return { kind: 'ack' as const, message: 'No goal to clear.' }
				await scope.store.clearGoal(scope.sessionId, scope.tenantId, goalRef(current))
				return { kind: 'ack' as const, message: 'Goal cleared.' }
		}
	} catch (error) {
		if (
			error instanceof GoalExistsError ||
			error instanceof GoalNotFoundError ||
			error instanceof GoalTransitionError ||
			error instanceof StaleGoalError
		) {
			return {
				kind: 'refused' as const,
				reason:
					'The goal command is not valid for the current state. Run /goal to view available commands.',
			}
		}
		if (error instanceof GoalSessionNotFoundError) {
			return { kind: 'refused' as const, reason: error.message }
		}
		throw error
	}
}

export function kernelHostCommands(options: KernelCommandOptions): HostCommandDescriptor[] {
	return [
		{
			name: 'goal',
			description: 'Persist or inspect a completion goal for this conversation.',
			hint: '[<objective>|clear|edit <objective>|pause|resume]',
			handler: async ({ args }) => await runGoalCommand(options.goal, args),
		},
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
			name: 'skills',
			description: 'List the skills an operator may invoke.',
			hint: 'name, description and policy for every operator-invocable skill',
			handler() {
				// Operator-invocable only, which is the point of the split: the
				// model's manifest and the operator's menu are different lists
				// drawn from one registry, and a `/skills` that showed
				// model-only guidance would offer an operator something there
				// is no way to run.
				if (!options.skills) {
					return {
						kind: 'refused',
						reason: 'This run has no skills registry, so there is nothing to list.',
					}
				}
				return {
					kind: 'report',
					title: 'Skills',
					rows: options.skills
						.filter((skill) => isInvocableBy(skill, 'operator'))
						.map((skill) => ({
							name: skill.metadata.name,
							description: skill.metadata.description,
							invocation: skillInvocation(skill),
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
