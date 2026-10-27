import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { EXIT_USAGE } from '../exit-codes.js'
import { describeSkip, runGeneratorCycle } from '../integrations/learning/generator-run.js'
import { resolveGeneratorSettings } from '../integrations/learning/generator-settings.js'
import {
	describeUndoRefusal,
	listLearnedGuidance,
	undoLearnedGuidance,
} from '../integrations/learning/guidance-history.js'
import { openProjectGuidance } from '../integrations/learning/project-guidance.js'
import { sessionLearningStore } from '../integrations/learning/session-store.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { contextLogging, createStderrSink, installCliLogging } from '../logging.js'
import { learningSummary } from './learning.js'
import type { CommandContext } from './types.js'

const line = (value: string) => stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ')
const excerpt = (value: string, max = 100) => {
	const chars = Array.from(line(value))
	return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first
		? { version: 3, providers: [{ id: first.entry.id }], subagents: { active: [] } }
		: null
}

const NOTHING =
	'No failures or recoveries have been kept from conversations in this folder yet, so there is nothing to learn from.'

/** `namzu learn --list`: what Namzu learned for this folder and which revision is active. */
export async function listLearned(ctx: CommandContext, cwd: string): Promise<number> {
	const target = await sessionLearningStore(cwd, false)
	if (!target) {
		ctx.formatter.print({ text: 'Nothing has been learned for this folder yet.', revisions: [] })
		return 0
	}
	const agenda = await openProjectGuidance(target.target.paths, target.target.tenantId)
	const { active, revisions } = await listLearnedGuidance(target, agenda)
	ctx.formatter.print({
		text: revisions.length
			? [
					active
						? 'Conversations here start with the learned guidance marked active.'
						: 'No learned guidance is active.',
					...revisions.map(
						(r) =>
							`${r.cycleId} · ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} · ${r.active ? 'active' : 'replaced'}\n  ${excerpt(r.description)}`,
					),
					'Undo the active one with `namzu learn --undo`.',
				].join('\n')
			: 'Nothing has been learned for this folder yet.',
		revisions,
		active,
	})
	return 0
}

/** `namzu learn --undo [cycle-id]`: restore the guidance an activation replaced. */
export async function undoLearned(
	ctx: CommandContext,
	cwd: string,
	cycleId: string | undefined,
): Promise<number> {
	const target = await sessionLearningStore(cwd, false)
	if (!target) {
		ctx.formatter.print({ text: 'Nothing has been learned for this folder yet.', result: null })
		return EXIT_USAGE
	}
	const agenda = await openProjectGuidance(target.target.paths, target.target.tenantId)
	const outcome = await undoLearnedGuidance(target, agenda, cycleId)
	if (outcome.status === 'refused') {
		ctx.formatter.print({ text: describeUndoRefusal(outcome.reason), result: outcome })
		return EXIT_USAGE
	}
	ctx.formatter.print({
		text: `Restored the guidance this folder had before ${outcome.revision.cycleId}${outcome.restored === 'none' ? ' (none, so conversations start without learned guidance)' : ''}.`,
		result: outcome,
	})
	return 0
}

/** `namzu learn` with no module: run one built-in cycle now, by hand. */
export async function learnNow(ctx: CommandContext, cwd: string): Promise<number> {
	const controller = new AbortController()
	const interrupt = () => controller.abort(new Error('Learning was interrupted.'))
	const target = await sessionLearningStore(resolve(cwd), false)
	if (!target) {
		ctx.formatter.print({ text: NOTHING, result: null })
		return 0
	}
	// The CLI owns stderr: a live sink at the level --verbose/--quiet named.
	const logging = contextLogging(ctx)
	installCliLogging(createStderrSink(logging.format), logging.level)
	const { probeAgentSession, createAgentSession } = await import('../tui/agent.js')
	const probe = await probeAgentSession()
	const prefs = probe.preferences ?? defaultPrefs(probe.detected)
	if (!prefs) {
		ctx.formatter.error({
			message:
				'No model provider is available. Set a credential or run `namzu` to choose one, then try again.',
		})
		return 1
	}
	const session = await createAgentSession(prefs, probe.detected, {
		cwd: await realpath(resolve(cwd)),
		ephemeral: true,
		...(ctx.config.smallModel ? { smallModel: ctx.config.smallModel } : {}),
	})
	process.on('SIGINT', interrupt)
	process.on('SIGTERM', interrupt)
	try {
		if (!session.hasProvider || !session.learning) {
			ctx.formatter.error({
				message: session.errorHint ?? 'Namzu could not reach a model to learn with.',
			})
			return 1
		}
		const outcome = await runGeneratorCycle({
			target,
			model: session.learning.model,
			route: await session.learning.route(controller.signal),
			settings: resolveGeneratorSettings(ctx.config.learningGenerator),
			mode: 'manual',
			signal: controller.signal,
			progress: (message) => ctx.formatter.info(message),
		})
		if (outcome.status === 'skipped') {
			ctx.formatter.print({ text: describeSkip(outcome.reason), result: outcome })
			return 0
		}
		const { cycle } = outcome
		const saved = await target.get(cycle.cycleId).catch(() => null)
		ctx.formatter.print({
			text: [
				saved
					? learningSummary({ ...saved, status: cycle.status, result: cycle })
					: `${cycle.cycleId} · ${cycle.status}: ${line(cycle.reason)}`,
				...(cycle.status === 'activated'
					? ['Conversations in this folder now start with it. Undo with `namzu learn --undo`.']
					: []),
			].join('\n'),
			result: cycle,
			tokens: outcome.tokens,
		})
		return cycle.status === 'activated' && cycle.auditComplete
			? 0
			: cycle.status === 'cancelled'
				? 130
				: ['rejected', 'inconclusive'].includes(cycle.status)
					? 2
					: 1
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return controller.signal.aborted ? 130 : 1
	} finally {
		process.off('SIGINT', interrupt)
		process.off('SIGTERM', interrupt)
		await session.close()
	}
}
