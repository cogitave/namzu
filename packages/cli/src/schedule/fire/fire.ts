/**
 * `namzu schedule __fire`: one scheduled run, as a headless turn in the
 * job's folder. Started only by the daemon (or `schedule run-now` without
 * one), never by hand, and not listed in help.
 *
 * It composes what `exec` composes — trust, the project's config, a new
 * conversation, `createAgentSession`, `send`, the provider wait — without
 * sharing `exec`'s runner: `exec` resolves `prompt` into `auto` because
 * nobody can answer, and a scheduled run must do the opposite. Here every
 * batch that would reach a person is HELD (`SendOptions.reviewHold`): the
 * turn parks durably, the run records `awaiting-approval`, and the operator
 * answers later in the TUI.
 *
 * Checks before any model call, each ending the run as `blocked-config` with
 * zero tokens spent: the job still exists at the revision the daemon
 * claimed, is active and still matches its confirmation; the folder is the
 * canonical folder trust was granted for and can be listed; the project's
 * code-executing config is the one confirmed; every permission rule compiles;
 * the pinned provider has a credential in the service's environment.
 *
 * The child's own watchdog enforces the wall clock: the kernel's turn
 * timeout first, then, a minute later, it releases its session lease and
 * exits. The daemon never kills a run by a pid it read from disk.
 */

import { hostname } from 'node:os'
import { TurnCancelled, asSessionId, describeSchedule, releaseHeldSessionLeases } from '@namzu/sdk'
import { pauseWait } from '../../commands/provider-wait.js'
import type { CommandContext } from '../../commands/types.js'
import { readPermissionLayers } from '../../config/load.js'
import { resolveTrustedProjectContext } from '../../config/trusted-project-context.js'
import { summaryOf } from '../../integrations/notifications/desktop/sanitize.js'
import type { Preferences, ProviderId } from '../../integrations/providers/index.js'
import {
	closeSessions,
	openSessions,
	setTitle,
	startConversation,
} from '../../integrations/sessions/store.js'
import { cliLogger, createStderrSink, installCliLogging } from '../../logging.js'
import type { AgentEvent } from '../../tui/agent.js'
import { describeTurnInterruption, retryAfterMs } from '../../tui/turn-interruption.js'
import { readDaemonEnv } from '../env.js'
import { checkJobFolder, folderReadable } from '../folder.js'
import type { SchedulePaths } from '../paths.js'
import { compileJobPolicy } from '../policy.js'
import { computeProjectDigest, projectDigestChanges } from '../store/digest.js'
import { confirmationHolds, readJob } from '../store/jobs.js'
import type {
	ScheduleJob,
	ScheduleRunResult,
	ScheduleRunStatus,
	ScheduleRunTrigger,
} from '../types.js'
import { writeRunResult } from './result.js'
import { unattendedNote } from './unattended-note.js'

export const HOLD_REASON = 'Scheduled run: waiting for the operator to approve'
/** How long past the turn's own timeout the child waits before it stops itself. */
export const WATCHDOG_GRACE_MS = 60_000

export interface FireArgs {
	readonly jobId: string
	readonly runId: string
	readonly key: string
	readonly revision: number
	readonly trigger: ScheduleRunTrigger
	readonly scheduledFor?: string
	readonly daemonEpoch?: string
}

export function parseFireArgs(argv: readonly string[]): FireArgs | { error: string } {
	const get = (name: string): string | undefined => {
		const at = argv.indexOf(`--${name}`)
		return at >= 0 ? argv[at + 1] : undefined
	}
	const jobId = get('job')
	const runId = get('run')
	const key = get('key')
	const revision = Number(get('revision'))
	const trigger = (get('trigger') ?? 'scheduled') as ScheduleRunTrigger
	if (!jobId || !runId || !key || !Number.isSafeInteger(revision)) {
		return { error: '__fire needs --job, --run, --key and --revision' }
	}
	if (!['scheduled', 'late', 'catch-up', 'manual'].includes(trigger)) {
		return { error: `__fire: unknown trigger ${trigger}` }
	}
	const scheduledFor = get('scheduled-for')
	const daemonEpoch = get('epoch')
	return {
		jobId,
		runId,
		key,
		revision,
		trigger,
		...(scheduledFor ? { scheduledFor } : {}),
		...(daemonEpoch ? { daemonEpoch } : {}),
	}
}

/** Where a credential came from, in words, and whether it is another program's. */
function credentialSource(source: { kind: string; envName?: string; path?: string }): {
	text: string
	borrowed: boolean
} {
	switch (source.kind) {
		case 'env':
			return { text: `environment variable ${source.envName ?? ''}`.trim(), borrowed: false }
		case 'claude-file':
			return { text: `Claude Code's sign-in (${source.path ?? ''})`, borrowed: true }
		case 'codex-file':
			return { text: `Codex's sign-in (${source.path ?? ''})`, borrowed: true }
		case 'gemini-file':
			return { text: `Gemini CLI's sign-in (${source.path ?? ''})`, borrowed: true }
		case 'stored':
			return { text: `namzu's credential store (${source.path ?? ''})`, borrowed: false }
		case 'keychain':
			return { text: 'the system keychain', borrowed: true }
		default:
			return { text: source.kind, borrowed: false }
	}
}

export const BORROWED_CREDENTIAL_WARNING =
	"This run used another program's sign-in. Refreshing it here can race that program's own refresh; store a credential with `namzu login` or daemon.env for unattended runs."

export interface FireDependencies {
	/** The environment the service gave this process; read, never modified. */
	readonly env?: NodeJS.ProcessEnv
	/** Test seam: the agent module. */
	readonly agent?: Pick<
		typeof import('../../tui/agent.js'),
		'probeAgentSession' | 'createAgentSession'
	>
	/** Test seam: stop the process after the watchdog grace. */
	readonly exit?: (code: number) => void
	readonly now?: () => Date
	/** Test seam: how long past the turn timeout the watchdog waits. */
	readonly graceMs?: number
	/** Test seam: leave the process's logging as it is. */
	readonly keepLogging?: boolean
}

/**
 * Run one fire. Returns the exit code; the result file is the record. Exit
 * codes follow `exec`: 0 completed or parked, 1 failed, 64 usage, 75 the
 * provider stayed unavailable, 77 the folder is not trusted for this job.
 */
export async function runFire(
	ctx: CommandContext,
	paths: SchedulePaths,
	args: FireArgs,
	deps: FireDependencies = {},
): Promise<number> {
	const now = deps.now ?? (() => new Date())
	const startedAt = now().toISOString()
	if (!deps.keepLogging) installCliLogging(createStderrSink('json'), 'info')
	const log = cliLogger()
	let sessionId: string | undefined
	let projectSlug: string | undefined
	let turnId: string | undefined
	const warnings: string[] = []
	const found: { credential?: string } = {}
	const base = (): Omit<ScheduleRunResult, 'status' | 'exitCode'> => ({
		v: 1,
		kind: 'schedule-run-result',
		runId: args.runId,
		jobId: args.jobId,
		startedAt,
		...(sessionId ? { sessionId } : {}),
		...(projectSlug ? { projectSlug } : {}),
		...(turnId ? { turnId } : {}),
		...(found.credential ? { credentialSource: found.credential } : {}),
		...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
	})
	// Once the watchdog has recorded the wall clock, nothing after it rewrites the result.
	let settledByWatchdog = false
	const finish = (
		status: ScheduleRunStatus,
		exitCode: number,
		extra: Partial<ScheduleRunResult> = {},
	): number => {
		if (settledByWatchdog) return 1
		writeRunResult(paths, { ...base(), status, exitCode, endedAt: now().toISOString(), ...extra })
		log.info('scheduled run finished', {
			'namzu.schedule.job_id': args.jobId,
			'namzu.schedule.run_id': args.runId,
			'namzu.schedule.status': status,
		})
		return exitCode
	}
	const blocked = (reason: string, exitCode = 1): number =>
		finish('blocked-config', exitCode, { reason })

	writeRunResult(paths, { ...base(), status: 'running', exitCode: 0 })

	// ── the job, as claimed ───────────────────────────────────────────────
	let job: ScheduleJob | undefined
	try {
		job = readJob(paths, args.jobId)
	} catch (error) {
		return blocked(error instanceof Error ? error.message : String(error))
	}
	if (!job) return blocked('the job was removed before the run started')
	if (job.revision !== args.revision) {
		return blocked(
			`job changed: revision ${job.revision}, the run was claimed for ${args.revision}`,
		)
	}
	if (job.state !== 'active') return blocked(`the job is ${job.state}`)
	if (!confirmationHolds(job)) {
		return blocked(
			`job changed outside namzu since it was confirmed; run namzu schedule confirm ${job.name}`,
		)
	}

	// ── the folder, as trusted ────────────────────────────────────────────
	const folder = checkJobFolder(job.folder.path, { namzuHome: paths.home })
	if (!folder.ok) return blocked(folder.reason, 77)
	if (folder.canonical !== job.folder.canonical || job.trust?.canonical !== folder.canonical) {
		return blocked(
			`folder moved or replaced: ${job.folder.path} is now ${folder.canonical}, the job was confirmed for ${job.folder.canonical}`,
			77,
		)
	}
	const readable = folderReadable(folder.canonical)
	if (!readable.ok) return blocked(readable.reason)
	const changed = projectDigestChanges(job.projectDigest, computeProjectDigest(folder.canonical))
	if (changed.length > 0) {
		return blocked(
			`project config changed since the job was confirmed (${changed.join(', ')}); run namzu schedule confirm ${job.name}`,
		)
	}

	// ── what the run may do ───────────────────────────────────────────────
	let projectCtx: CommandContext
	let layers: ReturnType<typeof readPermissionLayers>
	try {
		projectCtx = resolveTrustedProjectContext(ctx, folder.canonical)
		layers = readPermissionLayers({ cwd: folder.canonical, env: deps.env ?? process.env })
	} catch (error) {
		return blocked(
			`config cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const policy = compileJobPolicy(job.permissions, { layers, namzuHome: paths.home })
	if (policy.diagnostics.length > 0) {
		// A rule someone believes is in force and that would be dropped is
		// worse than not running.
		return blocked(`permission rules do not compile: ${policy.diagnostics.join('; ')}`)
	}

	// ── the provider, as the service sees it ──────────────────────────────
	const daemonEnv = readDaemonEnv(paths.daemonEnv)
	warnings.push(...daemonEnv.warnings)
	const discoveryEnv = { ...(deps.env ?? process.env), ...daemonEnv.values }
	const agent = deps.agent ?? (await import('../../tui/agent.js'))
	const probe = await agent.probeAgentSession({ env: discoveryEnv })
	const detected = probe.detected.find((d) => d.entry.id === job.model.provider)
	if (!detected) {
		return blocked(
			`no credential for ${job.model.provider} in the scheduler's environment; run namzu login, or put the key in ${paths.daemonEnv}`,
		)
	}
	const source = credentialSource(detected.source as { kind: string })
	found.credential = source.text
	if (source.borrowed) warnings.push(BORROWED_CREDENTIAL_WARNING)
	const prefs: Preferences = {
		version: 3,
		providers: [
			{
				id: job.model.provider as ProviderId,
				...(job.model.model ? { model: job.model.model } : {}),
			},
		],
		subagents: { active: [] },
	}

	// ── the conversation ──────────────────────────────────────────────────
	let sessions: Awaited<ReturnType<typeof openSessions>>
	try {
		sessions = await openSessions(folder.canonical, { stateRoot: paths.home })
		projectSlug = sessions.slug
		sessionId = await startConversation(sessions, {
			origin: { protocol: 'cli', kind: 'prompt' } as never,
		})
		const when = args.scheduledFor ?? startedAt
		const tz = job.schedule.kind === 'cron' ? job.schedule.tz : undefined
		await setTitle(sessions, asSessionId(sessionId), `⏲ ${job.name} · ${describeWhen(when, tz)}`)
	} catch (error) {
		return finish('failed', 1, {
			reason: `the conversation could not be started: ${error instanceof Error ? error.message : String(error)}`,
		})
	}
	writeRunResult(paths, { ...base(), status: 'running', exitCode: 0 })

	const config = projectCtx.config
	const session = await agent.createAgentSession(prefs, [detected], {
		cwd: folder.canonical,
		stateRoot: paths.home,
		conversationSessions: sessions,
		scope: {
			sessionId: asSessionId(sessionId),
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		},
		rules: policy.rules,
		permissionMode: policy.mode,
		...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
		...(config.plugins ? { plugins: config.plugins } : {}),
		...(config.hooks ? { hooks: config.hooks } : {}),
		...(policy.network && config.web ? { web: config.web } : {}),
		...(config.compaction ? { compaction: config.compaction } : {}),
		...(config.memory ? { memory: config.memory } : {}),
		sandbox:
			job.permissions.execution === 'sandbox'
				? { ...(config.sandbox ?? {}), enabled: true }
				: { enabled: false },
		...(job.permissions.additionalDirectories
			? { additionalDirectories: [...job.permissions.additionalDirectories] }
			: {}),
		limits: {
			maxIterations: job.budget.maxIterations,
			tokenBudget: job.budget.tokenBudget,
			timeoutMs: job.budget.timeoutMs,
		},
	})
	const closeAll = async (): Promise<void> => {
		await session.close().catch(() => undefined)
		closeSessions(sessions)
	}
	if (!session.hasProvider) {
		await closeAll()
		return blocked(session.errorHint ?? 'the provider could not be started')
	}
	if (session.mcpFailed.length > 0) {
		await closeAll()
		return blocked(
			`tool servers unavailable: ${session.mcpFailed.map((f) => `${f.name} (${f.reason})`).join(', ')}`,
		)
	}

	// ── the turn ──────────────────────────────────────────────────────────
	const abort = new AbortController()
	const exit = deps.exit ?? ((code: number) => process.exit(code))
	const watchdog = setTimeout(
		() => {
			abort.abort(new TurnCancelled('user'))
			void (async () => {
				finish('timed-out', 1, {
					reason: `the run exceeded its ${job.budget.timeoutMs} ms wall clock`,
				})
				settledByWatchdog = true
				await releaseHeldSessionLeases().catch(() => undefined)
				exit(1)
			})()
		},
		job.budget.timeoutMs + (deps.graceMs ?? WATCHDOG_GRACE_MS),
	)
	watchdog.unref()

	let text = ''
	let totalTokens: number | undefined
	let costUsd: number | undefined
	let paused: Extract<AgentEvent, { kind: 'paused' }> | null = null
	let failed: string | null = null
	let stopReason: string | undefined
	const consume = async (stream: AsyncIterable<AgentEvent>): Promise<void> => {
		paused = null
		failed = null
		for await (const event of stream) {
			switch (event.kind) {
				case 'delta':
					text += event.text
					break
				case 'usage':
					totalTokens = event.totalTokens
					costUsd = (event.cost as { totalCost?: number } | undefined)?.totalCost
					break
				case 'paused':
					paused = event
					turnId = event.turnId
					failed = describeTurnInterruption(event)
					break
				case 'error':
					failed = describeTurnInterruption(event)
					break
				case 'done':
					if (event.text !== undefined) text = event.text
					stopReason = event.stopReason
					if (event.turnId) turnId = event.turnId
					break
				case 'tool-start':
					log.info('scheduled run tool call', {
						'namzu.schedule.run_id': args.runId,
						'namzu.tool.name': event.toolName,
					})
					break
			}
		}
	}
	try {
		await consume(
			session.send([{ role: 'user', content: job.prompt, timestamp: Date.now() }], {
				signal: abort.signal,
				permissionMode: policy.mode,
				reviewHold: { reason: HOLD_REASON },
				systemNote: unattendedNote(job.name),
				...(job.model.effort ? { effort: job.model.effort as never } : {}),
			}),
		)
		// A provider pause is waited out inside the job's budget, from the
		// checkpoint, as `exec --wait-for-provider` does.
		let waits = 0
		let waitedMs = 0
		for (;;) {
			const current = paused as Extract<AgentEvent, { kind: 'paused' }> | null
			if (!current || !(current.providerError || current.failure)) break
			const asked = retryAfterMs(current)
			const decision = pauseWait({
				waited: waits,
				...(asked !== undefined ? { retryAfterMs: asked } : {}),
				waitedMs,
				budgetMs: job.budget.waitForProviderMs,
			})
			if (decision.kind === 'stop') {
				await closeAll()
				clearTimeout(watchdog)
				return finish('failed', 75, {
					reason: `${failed ?? 'the provider paused the turn'}; not resumed: ${decision.reason}`,
					...(asked !== undefined ? { retryAfterMs: asked } : {}),
				})
			}
			waits++
			await new Promise((resolve) => setTimeout(resolve, decision.delayMs))
			waitedMs += decision.delayMs
			await consume(
				session.resumePaused({
					turnId: current.turnId,
					checkpointId: current.checkpointId,
					signal: abort.signal,
					permissionMode: policy.mode,
					reviewHold: { reason: HOLD_REASON },
				}),
			)
		}
	} finally {
		clearTimeout(watchdog)
	}
	await closeAll()

	const usage = {
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
	}
	const withUsage = Object.keys(usage).length > 0 ? { usage } : {}
	const summary = summaryOf(text)
	const parked = paused as Extract<AgentEvent, { kind: 'paused' }> | null
	if (parked) {
		return finish('awaiting-approval', 0, {
			reason: parked.reason,
			...(summary ? { summary } : {}),
			...withUsage,
		})
	}
	if (failed)
		return finish('failed', 1, { reason: failed, ...(summary ? { summary } : {}), ...withUsage })
	if (stopReason === 'timeout') {
		return finish('timed-out', 1, {
			reason: `the turn reached its ${job.budget.timeoutMs} ms time limit`,
			...(summary ? { summary } : {}),
			...withUsage,
		})
	}
	if (stopReason && stopReason !== 'end_turn') {
		return finish('failed', 1, {
			reason: `the turn did not finish normally: ${stopReason}`,
			...(summary ? { summary } : {}),
			...withUsage,
		})
	}
	return finish('completed', 0, { ...(summary ? { summary } : {}), ...withUsage })
}

function describeWhen(iso: string, tz: string | undefined): string {
	try {
		return new Intl.DateTimeFormat('en-GB', {
			dateStyle: 'medium',
			timeStyle: 'short',
			...(tz ? { timeZone: tz } : {}),
		}).format(new Date(iso))
	} catch {
		return iso
	}
}

/** A one-line description for logs and notifications; never the prompt. */
export function describeJob(job: ScheduleJob): string {
	return `${job.name} (${describeSchedule(job.schedule, job.schedule.kind === 'cron' ? { tz: job.schedule.tz } : {})}) on ${hostname()}`
}
