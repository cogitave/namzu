import { lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import {
	type DiskResidentAgenda,
	type LearningCycleOptions,
	type LearningCycleSummary,
	type LearningDiscoveryOptions,
	type LearningObservationRecord,
	type SqliteLearningStore,
	runStoredLearningCycle,
	runStoredLearningFromObservations,
} from '@namzu/sdk'
import { Command } from 'commander'
import { EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import { openProjectGuidance } from '../integrations/learning/project-guidance.js'
import { SESSION_AGENT_KEY } from '../integrations/learning/session-feed.js'
import { sessionLearningStore } from '../integrations/learning/session-store.js'
import { residentLearningStore } from '../integrations/resident/learning-storage.js'
import { lookupResident } from '../integrations/resident/storage.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { resolveWorkingDirectory } from './exec-flags.js'
import type { CommandHandlerArgs } from './types.js'

const line = (value: string) => stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ')
const preview = (value: string) => {
	const chars = Array.from(line(value))
	return chars.length > 240
		? `${chars.slice(0, 240).join('')}… (full text: --format json)`
		: chars.join('')
}
const integer = (value: string) => {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error('Expected a nonnegative safe integer.')
	return Number(value)
}

export function learningSummary(row: LearningCycleSummary): string {
	const usage = row.result?.consumption ?? {
		...row.recordedUsage,
		unfinishedStages: 1,
	}
	const review = row.result?.review
	const comparisons = (
		[
			['Verification', review?.verification],
			['Confirmation', review?.confirmation],
		] as const
	).flatMap(([label, round]) => {
		if (!round?.tasks.length) return []
		const total = round.tasks.reduce((n, t) => n + t.trials, 0)
		const baseline = round.tasks.reduce((n, t) => n + t.baselinePasses, 0)
		const candidate = round.tasks.reduce((n, t) => n + t.candidatePasses, 0)
		const protection =
			review?.protection?.[label === 'Verification' ? 'verification' : 'confirmation']
		return [
			`  ${label}: baseline ${baseline}/${total} → candidate ${candidate}/${total}`,
			...(protection
				? [
						`    Protected tasks: ${protection.status}${protection.missingTasks.length ? ` · ${protection.missingTasks.length} missing` : ''}${protection.unprovenTasks.length ? ` · ${protection.unprovenTasks.length} unproven` : ''}${protection.regressedTasks.length ? ` · ${protection.regressedTasks.length} regressed` : ''}`,
					]
				: []),
		]
	})
	return [
		`${row.cycleId} · ${row.status} · ${line(row.skillName ?? 'preflight')}`,
		`  ${usage.tokens} recorded tokens${usage.unknownTokens || usage.unfinishedStages ? ' · incomplete' : ''} · ${usage.unknownCosts || usage.unfinishedStages ? 'price incomplete or unknown' : `$${usage.costUsd.toFixed(4)}`}`,
		...(!row.result
			? ['  No final receipt; recorded state does not establish a live executor.']
			: []),
		...(row.result ? [`  ${line(row.result.reason)}`] : []),
		...comparisons,
	].join('\n')
}

function observationText(observations: readonly LearningObservationRecord[]): string {
	return observations
		.map((o) =>
			[
				`${o.ordinal} · ${line(o.skillName)} · ${o.outcome}${o.usageComplete ? '' : ' · usage unresolved'}`,
				`  ${line(o.taskKey)} · ${line(o.evaluatorRevision)}`,
				`  ${preview(o.evidence.reason)}`,
				`  ${o.attemptedCycleId ? `Experiment: ${o.attemptedCycleId}` : 'No experiment claimed'}`,
			].join('\n'),
		)
		.join('\n\n')
}

/** Where one experiment reads its observations and activates its result. */
interface LearnSubject {
	readonly cwd: string
	readonly tenantId: string
	readonly projectId: string
	readonly agentKey: string
	readonly agenda: Pick<DiskResidentAgenda, 'read' | 'promoteSkill'>
	openStore(): SqliteLearningStore | null
}

const residentSubject = (
	resident: NonNullable<Awaited<ReturnType<typeof lookupResident>>>,
): LearnSubject => ({
	cwd: resident.cwd,
	tenantId: resident.tenantId,
	projectId: resident.projectId,
	agentKey: resident.agentKey,
	agenda: resident.agenda,
	openStore: () => residentLearningStore(resident),
})

/** This project's own conversations: observations in, guidance out, no resident. */
async function openSessionSubject(cwd: string): Promise<LearnSubject | null> {
	const store = await sessionLearningStore(cwd, false)
	if (!store) return null
	const { paths, tenantId, projectId } = store.target
	return {
		cwd: await realpath(resolve(cwd)),
		tenantId,
		projectId,
		agentKey: SESSION_AGENT_KEY,
		agenda: await openProjectGuidance(paths, tenantId),
		openStore: () => store,
	}
}

/** Explicit host modules follow the existing eval command's executable-suite convention. */
export async function runLearningCommand({ ctx, rawArgs }: CommandHandlerArgs): Promise<number> {
	const execute = rawArgs[0] === 'learn'
	const parser = new Command()
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {} })
		.allowExcessArguments(false)
		.argument(execute ? '<experiment.learning.js>' : '[cycle-id]')
		.option('--cwd <path>')
		.option('--agent <name>', 'Resident name', 'default')
	if (execute)
		parser
			.option('--trust')
			.option(
				'--sessions',
				"Learn from the failures conversations in this folder kept, into this project's own guidance (no resident needed)",
			)
	else
		parser
			.option('--events')
			.option('--observations', "Inspect a resident's host-scored learning observations")
			.option(
				'--sessions',
				'Inspect the failures conversations in this folder kept (no resident needed)',
			)
			.option('--after <sequence>', '', integer)
			.option('--before <ordinal>', '', integer)
			.option('--limit <count>', '', integer)
	try {
		parser.parse(rawArgs.slice(1), { from: 'user' })
	} catch (error) {
		ctx.formatter.error({ message: String(error) })
		return EXIT_USAGE
	}
	const flags = parser.opts<{
		cwd?: string
		agent: string
		trust?: boolean
		events?: boolean
		observations?: boolean
		sessions?: boolean
		after?: number
		before?: number
		limit?: number
	}>()
	const target = resolveWorkingDirectory(flags.cwd ?? null)
	if ('error' in target) {
		ctx.formatter.error({ message: target.error })
		return EXIT_USAGE
	}
	const controller = new AbortController()
	const interrupt = () =>
		controller.abort(new Error('Learning experiment interrupted by the operator.'))
	try {
		if (!execute && flags.sessions) {
			if (parser.args[0] || flags.events || flags.before !== undefined || flags.observations)
				throw new Error(
					'--sessions uses --after and --limit, without a cycle ID, --events, --before or --observations.',
				)
			const store = await sessionLearningStore(target.cwd)
			const observations = store
				? await store.observations({ after: flags.after, limit: flags.limit })
				: []
			ctx.formatter.print({
				text: observations.length
					? observationText(observations)
					: 'No conversation observations recorded.',
				observations,
				nextAfter: observations.at(-1)?.ordinal ?? flags.after ?? 0,
			})
			return 0
		}
		const sessionSubject = execute && flags.sessions ? await openSessionSubject(target.cwd) : null
		if (execute && flags.sessions && !sessionSubject) {
			ctx.formatter.print({
				text: 'No conversation observations are recorded for this folder yet, so there is nothing to learn from.',
				result: null,
			})
			return EXIT_USAGE
		}
		const resident = sessionSubject ? null : await lookupResident(target.cwd, flags.agent)
		if (!sessionSubject && !resident) {
			ctx.formatter.print({
				text: 'No resident exists here. Use namzu resident add <objective> first.',
				cycles: [],
			})
			return execute ? EXIT_USAGE : 0
		}
		if (!execute) {
			if (!resident) throw new Error('A resident is required to inspect its experiments.')
			const id = parser.args[0]
			if (flags.observations) {
				if (id || flags.events || flags.before !== undefined)
					throw new Error(
						'--observations uses --after and --limit, without a cycle ID, --events or --before.',
					)
				const store = residentLearningStore(resident, true)
				const observations = store
					? await store.observations({ after: flags.after, limit: flags.limit })
					: []
				ctx.formatter.print({
					text: observations.length
						? observationText(observations)
						: 'No learning observations recorded.',
					observations,
					nextAfter: observations.at(-1)?.ordinal ?? flags.after ?? 0,
				})
				return 0
			}
			if ((flags.events || flags.after !== undefined) && !id)
				throw new Error('--events and --after require a cycle ID.')
			if (flags.after !== undefined && !flags.events) throw new Error('--after requires --events.')
			if (id && flags.before !== undefined) throw new Error('--before applies to the cycle list.')
			const store = residentLearningStore(resident, true)
			if (!store) {
				ctx.formatter.print({
					text: 'No learning experiments recorded.',
					cycles: [],
				})
				return 0
			}
			if (id) {
				const cycle = await store.get(id)
				if (!cycle) throw new Error('Learning cycle is not retained here.')
				const artifacts = await store.artifacts(id)
				const events = flags.events
					? await store.events(id, { after: flags.after, limit: flags.limit })
					: undefined
				ctx.formatter.print({
					text: [
						learningSummary(cycle),
						...artifacts.map((a) => `  ${line(a.name)} · ${a.bytes} bytes · ${a.hash}`),
						...(events?.map(
							(e) => `  ${e.sequence} · ${e.kind}${e.stage ? ` · ${e.stage}` : ''}`,
						) ?? []),
					].join('\n'),
					cycle,
					artifacts,
					...(events ? { events, nextAfter: events.at(-1)?.sequence ?? flags.after ?? 0 } : {}),
				})
			} else {
				const cycles = await store.list({
					before: flags.before,
					limit: flags.limit,
				})
				ctx.formatter.print({
					text: cycles.length
						? cycles.map(learningSummary).join('\n\n')
						: 'No learning experiments recorded.',
					cycles,
					nextBefore: cycles.at(-1)?.ordinal ?? null,
				})
			}
			return 0
		}
		const subject = sessionSubject ?? (resident ? residentSubject(resident) : null)
		if (!subject) throw new Error('Nothing to learn into.')
		const trust = decideHeadlessTrust({
			cwd: subject.cwd,
			trustFlag: flags.trust === true,
		})
		if (!trust.allowed) {
			ctx.formatter.error({
				message: trust.message ?? 'Resident directory is not trusted.',
			})
			return EXIT_UNTRUSTED
		}
		if (trust.cwd !== subject.cwd)
			throw new Error('Execution directory changed its canonical path.')
		const agenda = await subject.agenda.read()
		if (!agenda || agenda.paused || agenda.pursuits.some((p) => p.state.phase === 'running'))
			throw new Error('Learning requires an unpaused resident with no running pursuits.')
		const file = resolve(target.cwd, parser.args[0])
		if (!file.endsWith('.learning.js') && !file.endsWith('.learning.mjs'))
			throw new Error('Choose an explicit .learning.js or .learning.mjs host module.')
		const entry = lstatSync(file)
		if (!entry.isFile() || entry.isSymbolicLink())
			throw new Error('Learning experiment must be a regular host module, without a symbolic link.')
		process.on('SIGINT', interrupt)
		process.on('SIGTERM', interrupt)
		controller.signal.throwIfAborted()
		ctx.formatter.info(`Learning experiment: ${line(file)}`)
		const module = await import(pathToFileURL(file).href)
		if (typeof module.default !== 'function')
			throw new Error('Learning module must default-export a host factory.')
		const store = subject.openStore()
		if (!store) throw new Error('Learning storage is unavailable.')
		const options = (await module.default({
			cwd: subject.cwd,
			tenantId: subject.tenantId,
			projectId: subject.projectId,
			agentKey: subject.agentKey,
			signal: controller.signal,
			store,
		})) as
			| Omit<LearningCycleOptions, 'agenda' | 'signal' | 'record'>
			| Omit<LearningDiscoveryOptions, 'agenda' | 'signal'>
		controller.signal.throwIfAborted()
		const explore = options.explore
		const execution = {
			...options,
			agenda: subject.agenda,
			signal: controller.signal,
			...(explore
				? {
						explore: async (
							context: Parameters<NonNullable<LearningCycleOptions['explore']>>[0],
						) => {
							ctx.formatter.info(`Learning · ${line(context.skillName)} · exploring environment`)
							return explore(context)
						},
					}
				: {}),
			generate: async (context: Parameters<LearningCycleOptions['generate']>[0]) => {
				ctx.formatter.info(`Learning · ${line(context.skillName)} · generating guidance`)
				return options.generate(context)
			},
			evaluate: async (context: Parameters<LearningCycleOptions['evaluate']>[0]) => {
				ctx.formatter.info(`Learning · ${context.stage}`)
				return options.evaluate(context)
			},
		}
		const discovery =
			'evaluators' in execution ? await runStoredLearningFromObservations(store, execution) : null
		const result =
			'evaluators' in execution ? discovery?.cycle : await runStoredLearningCycle(store, execution)
		if (!result) {
			ctx.formatter.print({
				text: 'No eligible unattempted learning observation for the current skills and evaluators.',
				result: null,
			})
			return 0
		}
		let saved: LearningCycleSummary | null = null
		try {
			saved = await store.get(result.cycleId)
		} catch (error) {
			ctx.formatter.error({
				message: `Result received; journal inspection failed: ${String(error)}`,
			})
		}
		ctx.formatter.print({
			text: [
				saved
					? learningSummary({ ...saved, status: result.status, result })
					: `${result.cycleId} · ${result.status}: ${line(result.reason)}`,
				...(!result.auditComplete
					? [
							'The journal is incomplete. Inspect the exact skill evidence before retrying; do not replay the experiment automatically.',
						]
					: []),
			].join('\n'),
			result,
			journal: saved,
			databasePath: store.databasePath,
		})
		return result.status === 'activated' && result.auditComplete
			? 0
			: result.status === 'cancelled'
				? 130
				: ['rejected', 'inconclusive'].includes(result.status)
					? 2
					: 1
	} catch (error) {
		ctx.formatter.error({
			message: error instanceof Error ? error.message : String(error),
		})
		return controller.signal.aborted ? 130 : 1
	} finally {
		process.off('SIGINT', interrupt)
		process.off('SIGTERM', interrupt)
	}
}
