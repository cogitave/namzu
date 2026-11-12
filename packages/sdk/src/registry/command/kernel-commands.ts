import type { SessionGoalActivation } from '../../manager/goal/activation.js'
import {
	GoalExistsError,
	GoalNotFoundError,
	GoalSessionNotFoundError,
	GoalTransitionError,
	type SessionGoalStore,
	StaleGoalError,
} from '../../store/goal/index.js'
import type { HostCommandDescriptor } from '../../types/command/index.js'
import type { GoalConfirmedBy, GoalRef, SessionGoal } from '../../types/goal/index.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { Skill } from '../../types/skills/index.js'
import { isInvocableBy, skillInvocation } from '../../types/skills/index.js'

/**
 * The commands whose facts the kernel already owns.
 *
 * A registry with nothing in it is a declaration, and this repo has a rule
 * about those. These are facts a host would otherwise have to reach into
 * kernel internals to answer: the current Session goal,
 * operator-invocable skills, and the agents this turn may delegate to. Each is
 * computed or owned here and should not acquire a second host-specific source.
 *
 * Deliberately NOT here: anything that would need a decision the kernel
 * cannot make. `/clear` is about a transcript a host owns, `/login` about
 * credentials a host stores, `/model` about a picker a host draws. Adding
 * them would mean the SDK either rendering or refusing, and both are worse
 * than leaving the command with the host that can actually do it.
 */

export interface KernelCommandOptions {
	readonly allowedAgentIds?: readonly string[]
	/**
	 * The turn's skills, for the operator-facing half of the listing.
	 *
	 * Absent is a real state: a turn with no skills registry has none, which
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
	/** Process-local permission for automatic continuation. */
	readonly activation?: SessionGoalActivation
	/** What a goal that does not choose is confirmed by; shown by `/goal status`. Default `model`. */
	readonly defaultConfirmedBy?: GoalConfirmedBy
}

const GOAL_ARGUMENTS =
	'[status|set [--confirmed-by record|model] <objective>|<objective>|edit <objective>|pause|resume|clear]'
const GOAL_USAGE = `Usage: /goal ${GOAL_ARGUMENTS}`

type ParsedGoalCommand =
	| { readonly kind: 'show' }
	| { readonly kind: 'create'; readonly objective: string }
	| { readonly kind: 'invalid-create' }
	| { readonly kind: 'edit'; readonly objective: string }
	| { readonly kind: 'invalid-edit' }
	| { readonly kind: 'pause' }
	| { readonly kind: 'resume' }
	| { readonly kind: 'clear' }

function parseGoalCommand(args: readonly string[]): ParsedGoalCommand {
	const input = args.join(' ').trim()
	if (input.length === 0) return { kind: 'show' }
	const control = input.toLowerCase()
	if (control === 'status') return { kind: 'show' }
	if (control === 'set') return { kind: 'invalid-create' }
	if (/^set(?=\s)/iu.test(input)) return { kind: 'create', objective: input.slice(3).trim() }
	if (control === 'clear') return { kind: 'clear' }
	if (control === 'pause') return { kind: 'pause' }
	if (control === 'resume') return { kind: 'resume' }
	if (control === 'edit') return { kind: 'invalid-edit' }
	if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
	return { kind: 'create', objective: input }
}

type ConfirmedByFlag =
	| {
			readonly kind: 'ok'
			readonly args: readonly string[]
			readonly confirmedBy?: GoalConfirmedBy
	  }
	| { readonly kind: 'invalid' }

/**
 * Takes `--confirmed-by <model|record>` (or `=`) out of the arguments, but only
 * where a flag stands: at the front, right after `set`, or closing the command. In the middle the words
 * belong to the objective, so a goal about the flag itself keeps its text.
 */
function takeConfirmedBy(args: readonly string[]): ConfirmedByFlag {
	const head: string[] = []
	let i = 0
	if ((args[0] ?? '').toLowerCase() === 'set') {
		head.push(args[0] ?? '')
		i = 1
	}
	let found: GoalConfirmedBy | undefined
	for (; i < args.length; i++) {
		const arg = args[i] ?? ''
		let value: string
		if (arg === '--confirmed-by') {
			value = args[i + 1] ?? ''
			i++
		} else if (arg.startsWith('--confirmed-by=')) {
			value = arg.slice('--confirmed-by='.length)
		} else {
			break
		}
		if (value !== 'model' && value !== 'record') return { kind: 'invalid' }
		found = value
	}
	let tail = args.slice(i)
	// A flag may also close the command; in the middle its words are the objective's.
	const last = tail[tail.length - 1] ?? ''
	const beforeLast = tail[tail.length - 2] ?? ''
	let closing: string | undefined
	if (last.startsWith('--confirmed-by=')) {
		closing = last.slice('--confirmed-by='.length)
		tail = tail.slice(0, -1)
	} else if (beforeLast === '--confirmed-by') {
		closing = last
		tail = tail.slice(0, -2)
	}
	if (closing !== undefined) {
		if (closing !== 'model' && closing !== 'record') return { kind: 'invalid' }
		found = closing
	}
	return { kind: 'ok', args: [...head, ...tail], ...(found ? { confirmedBy: found } : {}) }
}

function goalRef(goal: SessionGoal): GoalRef {
	return { id: goal.id, revision: goal.revision }
}

function goalCommands(goal: SessionGoal, armed: boolean): string {
	if (goal.phase === 'active') {
		return `${armed ? '' : '/goal resume, '}/goal edit <objective>, /goal pause, /goal clear`
	}
	if (goal.phase === 'paused' || goal.phase === 'blocked') {
		return '/goal edit <objective>, /goal resume, /goal clear'
	}
	return '/goal set <objective>, /goal clear'
}

function renderGoal(
	title: string,
	goal: SessionGoal,
	armed: boolean,
	defaultConfirmedBy: GoalConfirmedBy = 'model',
): string {
	return [
		title,
		`Status: ${goal.phase}`,
		...(goal.confirmedBy === 'record' ||
		(goal.confirmedBy === undefined && defaultConfirmedBy === 'record')
			? ['Confirmed by: the record of the work']
			: []),
		`Automatic continuation: ${armed ? 'enabled' : 'paused'}`,
		`Automatic turns: ${goal.roundsAdmitted} / ${goal.maxGoalRounds}`,
		...(goal.blockedReason
			? [`Blocker: ${goal.blockedReason.code}: ${goal.blockedReason.message}`]
			: []),
		`Objective: ${goal.objective}`,
		'',
		`Commands: ${goalCommands(goal, armed)}`,
	].join('\n')
}

function renderScopedGoal(title: string, goal: SessionGoal, scope: GoalCommandScope): string {
	return renderGoal(
		title,
		goal,
		scope.activation?.isArmed(scope.sessionId, goal) ?? false,
		scope.defaultConfirmedBy,
	)
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
	const flag = takeConfirmedBy(args)
	if (flag.kind === 'invalid') {
		return {
			kind: 'refused' as const,
			reason: `--confirmed-by takes record or model.\n${GOAL_USAGE}`,
		}
	}
	const command = parseGoalCommand(flag.args)
	if (flag.confirmedBy !== undefined && command.kind !== 'create') {
		return {
			kind: 'refused' as const,
			reason: `--confirmed-by is chosen when a goal is set.\n${GOAL_USAGE}`,
		}
	}
	try {
		const current = await scope.store.getGoal(scope.sessionId, scope.tenantId)
		switch (command.kind) {
			case 'show':
				return current
					? { kind: 'ack' as const, message: renderScopedGoal('Goal', current, scope) }
					: {
							kind: 'ack' as const,
							message: `No goal is currently set.\n${GOAL_USAGE}`,
						}
			case 'invalid-create':
				return {
					kind: 'refused' as const,
					reason: `Setting a goal requires an objective.\n${GOAL_USAGE}`,
				}
			case 'invalid-edit':
				return {
					kind: 'refused' as const,
					reason: `Goal editing requires a replacement objective.\n${GOAL_USAGE}`,
				}
			case 'create': {
				if (current && current.phase !== 'complete') {
					return {
						kind: 'refused' as const,
						reason: `A goal is already ${current.phase}. Use /goal edit <objective> to change it or /goal clear before replacing it.`,
					}
				}
				const created = await scope.store.createGoal(
					{
						sessionId: scope.sessionId,
						objective: command.objective,
						...(flag.confirmedBy !== undefined ? { confirmedBy: flag.confirmedBy } : {}),
					},
					scope.tenantId,
				)
				scope.activation?.arm(created)
				return {
					kind: 'ack' as const,
					message: renderScopedGoal('Goal created', created, scope),
				}
			}
			case 'edit': {
				if (!current) return missingGoal('edit')
				if (current.phase === 'complete') {
					const replacement = await scope.store.createGoal(
						{ sessionId: scope.sessionId, objective: command.objective },
						scope.tenantId,
					)
					scope.activation?.arm(replacement)
					return {
						kind: 'ack' as const,
						message: renderScopedGoal('Goal created', replacement, scope),
					}
				}
				const wasArmed = scope.activation?.isArmed(scope.sessionId, current) ?? false
				const edited = await scope.store.editGoal(
					scope.sessionId,
					scope.tenantId,
					goalRef(current),
					{ objective: command.objective },
				)
				if (wasArmed) scope.activation?.arm(edited)
				return {
					kind: 'ack' as const,
					message: renderScopedGoal('Goal updated', edited, scope),
				}
			}
			case 'pause': {
				if (!current) return missingGoal('pause')
				const paused = await scope.store.pauseGoal(
					scope.sessionId,
					scope.tenantId,
					goalRef(current),
				)
				scope.activation?.disarm(scope.sessionId)
				return {
					kind: 'ack' as const,
					message: renderScopedGoal('Goal paused', paused, scope),
				}
			}
			case 'resume': {
				if (!current) return missingGoal('resume')
				if (current.phase === 'active') {
					scope.activation?.arm(current)
					return {
						kind: 'ack' as const,
						message: renderScopedGoal('Goal resumed', current, scope),
					}
				}
				const resumed = await scope.store.resumeGoal(
					scope.sessionId,
					scope.tenantId,
					goalRef(current),
				)
				scope.activation?.arm(resumed)
				return {
					kind: 'ack' as const,
					message: renderScopedGoal('Goal resumed', resumed, scope),
				}
			}
			case 'clear': {
				if (!current) {
					scope.activation?.disarm(scope.sessionId)
					return { kind: 'ack' as const, message: 'No goal to clear.' }
				}
				await scope.store.clearGoal(scope.sessionId, scope.tenantId, goalRef(current))
				scope.activation?.disarm(scope.sessionId)
				return { kind: 'ack' as const, message: 'Goal cleared.' }
			}
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
			hint: GOAL_ARGUMENTS,
			handler: async ({ args }) => await runGoalCommand(options.goal, args),
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
						reason: 'This turn has no skills registry, so there is nothing to list.',
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
			description: 'List the agents this turn may delegate to.',
			hint: 'the roster, as the delegation tools see it',
			handler() {
				// An empty roster IS the answer here, unlike the store above: the
				// question is "who may I call", and "nobody" is a complete and
				// correct reply that a turn with delegation off should get.
				return {
					kind: 'report',
					title: 'Agents',
					rows: (options.allowedAgentIds ?? []).map((id) => ({ id })),
				}
			},
		},
	]
}
