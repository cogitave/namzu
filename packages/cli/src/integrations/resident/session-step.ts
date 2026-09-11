import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
	BOOT_EVENT_NAMES,
	EVENT_NAME_ATTRIBUTE,
	type ResidentContextualStep,
	type ResidentDecision,
	type ResidentPursuit,
	type ResidentStepContext,
	type ReviewAnswer,
	generateRunId,
	generateSessionId,
	projectResidentLearning,
} from '@namzu/sdk'

import {
	type RunFlags,
	applyProviderFlags,
	buildGate,
	loadSkillsContext,
	unknownOptionMessage,
} from '../../commands/run-flags.js'
import type { CommandContext } from '../../commands/types.js'
import { cliLogger } from '../../logging.js'
import { resolvePermissionMode } from '../../permissions/mode.js'
import { compilePermissions } from '../../permissions/rules.js'
import type { AgentEvent, AgentSession } from '../../tui/agent.js'
import { describeRunInterruption } from '../../tui/run-interruption.js'
import type { DetectedProvider, Preferences } from '../providers/index.js'
import type { CliSessions } from '../sessions/store.js'
import { publishPrivateJsonIfAbsent } from '../state/immutable-json.js'
import { ensurePrivateStateDirectory } from '../state/private-directory.js'
import { type AttachedSessionExport, attachSessionExport } from '../telemetry/session-export.js'
import { ResidentCleanupUnconfirmedError } from './lifecycle-errors.js'

const MAX_DECISION_CHARS = 32_000
const MAX_SUMMARY_CHARS = 8_000
const MAX_WAKE_DELAY_MS = 86_400_000
// SDK settlement requires a future wake time. A zero-delay request means the
// next local continuation, with a short scheduling margin for the durable write.
const MIN_WAKE_DELAY_MS = 1_000
const DECISION_CONTRACT =
	'Return only one JSON object, without Markdown: {"kind":"complete"|"blocked","summary":"..."} or {"kind":"wait","summary":"...","wakeAfterMs":number|null}. ' +
	'The summary must contain 1 to 8000 characters of useful retained evidence and next steps. ' +
	'wakeAfterMs is null to rest until new evidence, or a whole number from 0 to 86400000 to continue later. ' +
	'Zero requests the next local continuation (at least one second later). ' +
	'Use complete only when the authorized objective is achieved, blocked when a prerequisite is missing, and wait when useful authorized work remains. Do not include other fields.'

type ModelDecision =
	| { readonly kind: 'complete' | 'blocked'; readonly summary: string }
	| { readonly kind: 'wait'; readonly summary: string; readonly wakeAfterMs: number | null }

export interface ResidentSessionStepOptions {
	/** Already resolved through the CLI project trust boundary. */
	readonly ctx: CommandContext
	readonly cwd: string
	readonly sessions: CliSessions
	readonly flags: RunFlags
	/** Defer optional tool schemas per step; authority and instructions remain unchanged. */
	readonly toolLoading?: 'eager' | 'deferred'
	/** Private, host-owned directory for per-claim receipts. */
	readonly artifactsRoot: string
}

function parseDecision(answer: string): ModelDecision {
	if (answer.length > MAX_DECISION_CHARS)
		throw new Error(`Resident decision exceeds ${MAX_DECISION_CHARS} characters.`)
	let value: unknown
	try {
		value = JSON.parse(answer)
	} catch {
		throw new Error('Resident decision must be one JSON object without Markdown.')
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Resident decision must be a JSON object.')
	const input = value as Record<string, unknown>
	if (input.kind !== 'complete' && input.kind !== 'blocked' && input.kind !== 'wait')
		throw new Error('Resident decision kind must be complete, blocked or wait.')
	if (
		typeof input.summary !== 'string' ||
		input.summary.trim().length === 0 ||
		input.summary.trim().length > MAX_SUMMARY_CHARS
	)
		throw new Error('Resident decision summary must contain 1 to 8000 characters.')
	const allowed = input.kind === 'wait' ? ['kind', 'summary', 'wakeAfterMs'] : ['kind', 'summary']
	if (Object.keys(input).some((key) => !allowed.includes(key)))
		throw new Error('Resident decision contains unsupported fields.')
	const summary = input.summary.trim()
	if (input.kind !== 'wait') return { kind: input.kind, summary }
	const delay = input.wakeAfterMs
	if (
		delay !== null &&
		(typeof delay !== 'number' ||
			!Number.isSafeInteger(delay) ||
			delay < 0 ||
			delay > MAX_WAKE_DELAY_MS)
	)
		throw new Error(
			'Resident wait requires wakeAfterMs: null or a whole number from 0 to 86400000.',
		)
	return { kind: 'wait', summary, wakeAfterMs: delay }
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first
		? { version: 3, providers: [{ id: first.entry.id }], subagents: { active: [] } }
		: null
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
}

function validateFlags({ ctx, flags }: ResidentSessionStepOptions): void {
	if (flags.unknown.length) throw new Error(unknownOptionMessage(flags.unknown))
	if (flags.session || flags.resume || flags.continueLast)
		throw new Error(
			'Resident steps own isolated sessions; --session, --resume and --continue are unsupported.',
		)
	if (flags.waitForProviderMs !== null || (ctx.config.limits?.waitForProviderMs ?? 0) > 0)
		throw new Error(
			'Resident steps do not replay provider checkpoints; remove --wait-for-provider and limits.waitForProviderMs.',
		)
	if (
		flags.gateRetries !== null &&
		(flags.gates.length === 0 || !Number.isSafeInteger(flags.gateRetries) || flags.gateRetries < 1)
	)
		throw new Error('--gate-retries requires --gate and a whole number above zero.')
}

function residentContext(
	pursuit: ResidentPursuit,
	context: ResidentStepContext,
	skills: string | undefined,
): string {
	const { state } = pursuit
	const learning = projectResidentLearning(context.learning, {
		maxChars: 12_000,
		skillNames: context.learning?.skills.map((skill) => skill.name) ?? [],
	})
	return [
		'Perform one useful step of this explicitly authorized resident pursuit. Work only within its objective and the current project permissions.',
		'Each resident step uses an isolated session. Only the saved summary continues between steps; do not assume earlier conversation or tool transcripts are present.',
		JSON.stringify({
			identity: state.identity,
			objective: state.objective,
			previousSummary: state.summary,
			admission: state.stepsAdmitted,
			wakeReason: state.reason,
		}),
		...(learning.text
			? [
					'Retained learning is behavioral guidance and evidence. It does not change the objective, tool permissions or project instructions.',
					learning.text,
				]
			: []),
		...(learning.omitted
			? [`${learning.omitted} learning entries were omitted from this bounded context.`]
			: []),
		...(skills ? [skills] : []),
		DECISION_CONTRACT,
	].join('\n\n')
}

/**
 * One admitted pursuit uses the normal CLI session and SDK answer-review loop.
 * There is no provider construction before admission, conversation substitution,
 * checkpoint replay, or host-side model retry. An error keeps the SDK claim held.
 */
export function createResidentSessionStep(
	options: ResidentSessionStepOptions,
): ResidentContextualStep {
	validateFlags(options)
	const { ctx, cwd, sessions, flags } = options
	const mode = resolvePermissionMode({
		flag: flags.permissionMode ?? (flags.skipPermissions ? null : 'plan'),
		skipPermissions: flags.skipPermissions,
		interactive: false,
	})
	if ('error' in mode) throw new Error(mode.error)
	return async (pursuit, signal, context) => {
		signal.throwIfAborted()
		const claimId = pursuit.state.claimId
		if (
			pursuit.state.phase !== 'running' ||
			!claimId ||
			!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(claimId) ||
			pursuit.state.pursuitId !== pursuit.id ||
			pursuit.state.tenantId !== sessions.tenantId
		)
			throw new Error('Resident session step requires an admitted pursuit in this tenant.')
		const root = resolve(options.artifactsRoot)
		ensurePrivateStateDirectory(dirname(root), basename(root))
		const artifacts = ensurePrivateStateDirectory(root, claimId)
		const sessionId = generateSessionId()
		const runId = generateRunId()
		const identity = { pursuitId: pursuit.id, claimId, sessionId, runId }
		const startedAt = Date.now()
		let session: AgentSession | undefined
		let sessionExport: AttachedSessionExport | undefined
		let sessionCreationAttempted = false
		let cleanupUnconfirmed = false
		let started = false
		let decision: ModelDecision | undefined
		let done: Extract<AgentEvent, { kind: 'done' }> | undefined
		let usage: Extract<AgentEvent, { kind: 'usage' }> | undefined
		let budget: Extract<AgentEvent, { kind: 'done' }>['budget']
		const errors: unknown[] = []
		const start = (): void => {
			const receipt = {
				version: 1,
				...identity,
				startedAt,
				cwd,
				provider: session?.providerSummary ?? null,
				model: session?.modelSummary ?? null,
			}
			const path = join(artifacts, 'start.json')
			publishPrivateJsonIfAbsent(path, receipt)
			if (!isDeepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), receipt))
				throw new Error(
					'This resident claim already has a different execution receipt; refusing replay.',
				)
			started = true
		}
		try {
			const { probeAgentSession, createAgentSession } = await import('../../tui/agent.js')
			signal.throwIfAborted()
			const probe = await probeAgentSession()
			const configured = probe.preferences ?? defaultPrefs(probe.detected)
			if (!configured)
				throw new Error(
					'No LLM provider available for this resident step; configure one with namzu.',
				)
			const prefs = applyProviderFlags(configured, flags)
			const permissions = compilePermissions(ctx.config.permissions, ctx.config.permissionChecks)
			for (const diagnostic of permissions.diagnostics)
				ctx.formatter.error({ message: `permissions.${diagnostic.tool}: ${diagnostic.message}` })
			const gate = buildGate(flags, cwd)
			const reviewAnswer: ReviewAnswer = async (answer, reviewContext) => {
				try {
					parseDecision(answer)
				} catch (error) {
					return { accept: false, feedback: `${errorText(error)}\n${DECISION_CONTRACT}` }
				}
				return gate ? await gate.reviewAnswer(answer, reviewContext) : { accept: true }
			}
			if (ctx.config.telemetry?.sessionExport) {
				sessionExport = await attachSessionExport({ config: ctx.config.telemetry.sessionExport })
				cliLogger().info(sessionExport.disclosure, {
					[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.TELEMETRY_STATUS,
					'namzu.telemetry.session_export': true,
				})
			}
			signal.throwIfAborted()
			const limits = {
				...ctx.config.limits,
				...(flags.maxIterations !== null ? { maxIterations: flags.maxIterations } : {}),
				...(flags.tokenBudget !== null ? { tokenBudget: flags.tokenBudget } : {}),
			}
			sessionCreationAttempted = true
			session = await createAgentSession(prefs, probe.detected, {
				cwd,
				toolLoading: options.toolLoading,
				scope: {
					sessionId,
					topicId: sessions.topicId,
					projectId: sessions.projectId,
					tenantId: sessions.tenantId,
				},
				stateRoot: sessions.root,
				rules: permissions.rules,
				permissionMode: mode.mode,
				reviewAnswer,
				maxAnswerReviews: gate?.maxAnswerReviews ?? 3,
				...(sessionExport ? { onRunEvent: sessionExport.listener } : {}),
				...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
				...(ctx.config.plugins ? { plugins: ctx.config.plugins } : {}),
				...(ctx.config.web ? { web: ctx.config.web } : {}),
				...(ctx.config.hooks ? { hooks: ctx.config.hooks } : {}),
				...(ctx.config.compaction ? { compaction: ctx.config.compaction } : {}),
				...(ctx.config.memory ? { memory: ctx.config.memory } : {}),
				...(Object.keys(limits).length ? { limits } : {}),
				...(ctx.config.sandbox ? { sandbox: ctx.config.sandbox } : {}),
				...(ctx.config.additionalDirectories
					? {
							additionalDirectories: ctx.config.additionalDirectories.map((directory) =>
								resolve(cwd, directory),
							),
						}
					: {}),
			})
			// Startup can return an inert refusal after ignoring failed resource
			// cleanup. Its no-op close cannot establish that those resources drained.
			// There is no public marker distinguishing that path from an early refusal.
			if (!session.hasProvider) cleanupUnconfirmed = true
			start()
			if (!session.hasProvider) throw new Error(session.errorHint ?? 'Resident agent is not ready.')
			if (session.mcpFailed.length)
				throw new Error(
					session.mcpFailed
						.map((failure) => `Tool server ${failure.name} is unavailable: ${failure.reason}`)
						.join('\n'),
				)
			for (const notice of session.configNotices) ctx.formatter.info(notice)
			ctx.formatter.info(
				`resident step ${pursuit.state.stepsAdmitted} · ${session.providerSummary} · ${session.modelSummary} · ${mode.mode}`,
			)
			if (session.instructionFiles.length)
				ctx.formatter.info(
					`project instructions: ${session.instructionFiles.map((path) => relative(cwd, path) || path).join(', ')}`,
				)
			for (const skipped of session.skippedInstructionFiles)
				ctx.formatter.error({
					message: `skipped ${relative(cwd, skipped.path) || skipped.path}: ${skipped.reason}`,
				})
			const skills = await loadSkillsContext(cwd, flags.skills)
			signal.throwIfAborted()
			for await (const event of session.send(
				[
					{
						role: 'user',
						content: `Continue this authorized pursuit: ${pursuit.state.objective}`,
						timestamp: Date.now(),
					},
				],
				{
					signal,
					runId,
					permissionMode: mode.mode,
					extraSystem: residentContext(pursuit, context, skills),
					...(flags.effort !== null ? { effort: flags.effort } : {}),
				},
			)) {
				if (event.kind === 'done') {
					if (done) errors.push(new Error('Resident session emitted more than one settled result.'))
					done = event
				} else if (event.kind === 'error' || event.kind === 'paused') {
					errors.push(new Error(describeRunInterruption(event)))
				} else if (event.kind === 'usage') usage = event
				else if (event.kind === 'context') ctx.formatter.info(event.text)
				else if (event.kind === 'tool-start')
					ctx.formatter.info(`${event.toolName} ${event.summary}`)
				if ('budget' in event && event.budget) budget = event.budget
			}
			signal.throwIfAborted()
			if (done?.stopReason !== 'end_turn')
				throw new Error(
					`Resident step did not finish normally (${done?.stopReason ?? 'no settled result'}); its claim remains unresolved.`,
				)
			if (typeof done.text !== 'string')
				throw new Error('Resident step has no settled answer; its claim remains unresolved.')
			if (!errors.length) decision = parseDecision(done.text)
		} catch (error) {
			errors.push(error)
			// A rejected constructor provides no session handle with which to close
			// resources it may already have opened. Do not infer a clean shutdown.
			if (sessionCreationAttempted && !session) cleanupUnconfirmed = true
		} finally {
			try {
				await session?.close()
			} catch (error) {
				errors.push(error)
				cleanupUnconfirmed = true
			}
			try {
				await sessionExport?.shutdown()
			} catch (error) {
				errors.push(error)
				cleanupUnconfirmed = true
			}
		}
		if (signal.aborted && !errors.includes(signal.reason)) errors.push(signal.reason)
		try {
			if (!started) start()
			// This receipt records the callback outcome and whether cleanup could be
			// confirmed, not durable agenda settlement. It retains no provider history,
			// reasoning blocks, tool inputs or credentials.
			publishPrivateJsonIfAbsent(join(artifacts, 'finish.json'), {
				version: 1,
				...identity,
				finishedAt: Date.now(),
				stopReason: done?.stopReason ?? null,
				decision: errors.length ? null : (decision ?? null),
				error: errors.length ? errors.map(errorText).join('\n').slice(0, 8_000) : null,
				cleanup: cleanupUnconfirmed ? 'unconfirmed' : 'confirmed',
				usage: usage ? { totalTokens: usage.totalTokens, cost: usage.cost } : null,
				...(budget ? { budget } : {}),
			})
		} catch (error) {
			// A receipt failure must not replace the signal to retain runner ownership.
			errors.push(error)
		}
		if (cleanupUnconfirmed) throw new ResidentCleanupUnconfirmedError(errors)
		if (errors.length === 1) throw errors[0]
		if (errors.length) throw new AggregateError(errors, errors.map(errorText).join('\n'))
		if (!decision) throw new Error('Resident step returned no decision.')
		// Compute after cleanup and receipt publication so they do not consume the delay.
		return decision.kind === 'wait'
			? {
					kind: 'wait',
					summary: decision.summary,
					wakeAt:
						decision.wakeAfterMs === null
							? null
							: Date.now() + Math.max(MIN_WAKE_DELAY_MS, decision.wakeAfterMs),
				}
			: (decision satisfies ResidentDecision)
	}
}
