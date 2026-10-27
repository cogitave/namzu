import { join } from 'node:path'
import {
	type LearningCycleResult,
	type LearningModel,
	type LearningObservationRecord,
	type LearningProposal,
	SqliteLearningExperienceStore,
	learningExperienceFromCycle,
	proposeLearningCandidate,
	runStoredLearningCycle,
} from '@namzu/sdk'
import {
	COOLDOWN_MS,
	type LearningGeneratorSettings,
	MIN_OBSERVATIONS,
} from './generator-settings.js'
import {
	acquireGeneratorLock,
	dailyTokensLeft,
	localDay,
	readGeneratorState,
	writeGeneratorState,
} from './generator-state.js'
import { openProjectGuidance } from './project-guidance.js'
import { createScenarioEvaluator } from './scenario-evaluator.js'
import {
	SCENARIO_EVALUATOR_REVISION,
	scenarioPlan,
	scenarioProtectedContents,
} from './scenarios.js'
import { SESSION_AGENT_KEY, SESSION_SKILL } from './session-feed.js'
import type { SessionLearningTarget } from './session-store.js'

/** The kind of task the experience library groups cycles by. */
export const GENERATOR_DOMAIN = 'session-guidance'
/** Below this many tokens left today, an automatic cycle would stop before it finished. */
const MIN_CYCLE_TOKENS = 20_000

export type GeneratorSkip =
	| 'disabled'
	| 'no-observations'
	| 'few-observations'
	| 'cooldown'
	| 'daily-cap'
	| 'busy'

export type GeneratorOutcome =
	| { readonly status: 'skipped'; readonly reason: GeneratorSkip }
	| {
			readonly status: 'ran'
			readonly cycle: LearningCycleResult
			readonly proposal: LearningProposal | null
			readonly tokens: number
	  }

export interface GeneratorRunOptions {
	readonly target: SessionLearningTarget
	readonly model: LearningModel
	/**
	 * Names the model route, so a change of route is a change of evaluation
	 * conditions. A function is called only once a cycle is going to run, so a
	 * check that starts nothing never looks the route up.
	 */
	readonly route: string | (() => Promise<string>)
	readonly settings: LearningGeneratorSettings
	/** `automatic` honours the thresholds and the cooldown; `manual` is one cycle on request. */
	readonly mode: 'automatic' | 'manual'
	readonly signal: AbortSignal
	readonly now?: () => number
	readonly progress?: (message: string) => void
}

/** Plain wording for a cycle that did not start. */
export function describeSkip(reason: GeneratorSkip): string {
	switch (reason) {
		case 'disabled':
			return 'Learning is turned off (learningGenerator: false).'
		case 'no-observations':
			return 'Nothing has been kept from conversations in this folder yet, so there is nothing to learn from.'
		case 'few-observations':
			return `Fewer than ${MIN_OBSERVATIONS} new failures or recoveries have been kept since the last cycle.`
		case 'cooldown':
			return 'A cycle ran recently; the next one waits for the pause to end.'
		case 'daily-cap':
			return "Today's learning token allowance is used up."
		case 'busy':
			return 'Another learning cycle is running for this folder.'
	}
}

async function allObservations(
	store: SessionLearningTarget,
): Promise<readonly LearningObservationRecord[]> {
	const all: LearningObservationRecord[] = []
	for (let after = 0; all.length < 500; ) {
		const page = await store.observations({ after, limit: 100 })
		if (!page.length) break
		all.push(...page)
		after = page.at(-1)?.ordinal ?? after
	}
	return all
}

/**
 * One built-in learning cycle for this project. The generator proposes one
 * revision of the project's guidance from what conversations kept and from
 * earlier cycles of the same domain; the cycle checks it with the scenario
 * evaluation (paired verification, protection, a fresh confirmation round) and
 * activates it by exact revision only when both rounds pass. Everything it
 * spends is counted against the cycle allowance and the daily allowance.
 */
export async function runGeneratorCycle(options: GeneratorRunOptions): Promise<GeneratorOutcome> {
	const now = options.now ?? Date.now
	const { settings, target } = options
	if (!settings.enabled && options.mode === 'automatic')
		return { status: 'skipped', reason: 'disabled' }
	const dir = join(target.target.paths.projectDir(), 'learning')
	const state = readGeneratorState(dir)
	const observations = await allObservations(target)
	if (!observations.length) return { status: 'skipped', reason: 'no-observations' }
	const fresh = observations.filter((o) => o.ordinal > state.lastOrdinal)
	if (options.mode === 'automatic') {
		if (fresh.length < MIN_OBSERVATIONS) return { status: 'skipped', reason: 'few-observations' }
		if (state.lastCycleAt !== null && now() - state.lastCycleAt < COOLDOWN_MS)
			return { status: 'skipped', reason: 'cooldown' }
	}
	const left = dailyTokensLeft(state, settings.dailyTokens, now())
	if (left < (options.mode === 'automatic' ? MIN_CYCLE_TOKENS : 1))
		return { status: 'skipped', reason: 'daily-cap' }
	const release = acquireGeneratorLock(dir, now())
	if (!release) return { status: 'skipped', reason: 'busy' }
	try {
		const { paths, tenantId, projectId } = target.target
		const agenda = await openProjectGuidance(paths, tenantId)
		const experience = new SqliteLearningExperienceStore({
			databasePath: join(dir, 'experience.sqlite'),
			scope: {
				tenantId: tenantId as never,
				projectId: projectId as never,
				agentKey: SESSION_AGENT_KEY,
			},
		})
		const route = typeof options.route === 'string' ? options.route : await options.route()
		const plan = scenarioPlan()
		const leakGuard = { protectedContents: scenarioProtectedContents(plan) }
		const lastOrdinal = observations.at(-1)?.ordinal ?? state.lastOrdinal
		// The pause starts now, so a process that dies mid-cycle cannot be restarted in a loop.
		writeGeneratorState(dir, {
			...state,
			lastOrdinal,
			lastCycleAt: now(),
			day: localDay(now()),
			dayTokens: state.day === localDay(now()) ? state.dayTokens : 0,
		})
		const earlier = await experience.retrieve({
			domain: GENERATOR_DOMAIN,
			evaluatorRevision: SCENARIO_EVALUATOR_REVISION,
			leakGuard,
			beforeOrdinal: await experience.nextOrdinal(),
		})
		const kinds = new Map<string, number>()
		for (const o of observations) kinds.set(o.taskKey, (kinds.get(o.taskKey) ?? 0) + 1)
		const trace = [...kinds.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20)
			.map(([key, count]) => `${key}: ${count}`)
			.join('\n')
		let proposal: LearningProposal | null = null
		options.progress?.('Learning · writing a revision of this project’s guidance')
		const cycle = await runStoredLearningCycle(target, {
			skillName: SESSION_SKILL,
			protection: plan.protection,
			agenda,
			leakGuard,
			signal: options.signal,
			resources: { unit: 'tokens', maxUnits: Math.min(settings.cycleTokens, left) },
			failure: {
				evidence: {
					key: `observations:${observations[0]?.ordinal}-${lastOrdinal}`,
					source: 'session-observations',
					reason: `${observations.length} failures and recoveries kept from conversations in this project.`,
				},
				trace,
			},
			generate: async (context) => {
				proposal = await proposeLearningCandidate({
					skillName: SESSION_SKILL,
					baseline: context.baseline,
					observations: observations.slice(-100),
					experience: earlier,
					leakGuard,
					model: options.model,
					signal: context.signal,
					recordUsage: (receipt) => context.recordUsage(receipt),
				})
				if (proposal.status === 'refused') throw new Error(proposal.reason)
				return { candidate: proposal.candidate, usageComplete: proposal.usageComplete }
			},
			evaluate: async (context) => {
				options.progress?.(
					`Learning · checking the revision (${context.stage === 'verification' ? 'first' : 'second'} round)`,
				)
				return createScenarioEvaluator({ plan, model: options.model, route })(context)
			},
		})
		const proposed = proposal as LearningProposal | null
		if (proposed?.status === 'proposed') {
			const entry = learningExperienceFromCycle({
				domain: GENERATOR_DOMAIN,
				evaluatorRevision: SCENARIO_EVALUATOR_REVISION,
				proposal: proposed,
				result: cycle,
				leakGuard,
			})
			if (entry) {
				try {
					await experience.record(entry)
				} catch {
					/* A library that cannot be written costs the next cycle its memory, not this result. */
				}
			}
		}
		const tokens = cycle.consumption.tokens
		const spent = readGeneratorState(dir)
		// A cycle that never reached the model (no connection, a cancel) read nothing:
		// its observations stay unread. The pause still applies, so it cannot loop.
		const unread = tokens === 0 && (cycle.status === 'failed' || cycle.status === 'cancelled')
		writeGeneratorState(dir, {
			...spent,
			lastOrdinal: unread ? state.lastOrdinal : spent.lastOrdinal,
			lastCycleAt: now(),
			day: localDay(now()),
			dayTokens: (spent.day === localDay(now()) ? spent.dayTokens : 0) + tokens,
		})
		return { status: 'ran', cycle, proposal: proposed, tokens }
	} finally {
		release()
	}
}
