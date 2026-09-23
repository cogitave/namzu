/**
 * `namzu drain` — one pass over a session's parked turn.
 *
 * namzu can park a turn in one process and continue it in another: the turn
 * stops with `turn_paused`, a decision it waits on is a `decision_requested`
 * record, and whoever works on a session holds its `lease.json`. This is the
 * caller that picks such a turn up. It finds the session's active turn, takes
 * the session's lease, continues the turn under that lease, and gives the
 * lease back.
 *
 * **It is not a daemon.** `namzu serve` still says namzu has no server; the
 * scheduler daemon (`namzu schedule`) runs scheduled jobs and never drains.
 * That refusal is not weakened by this command, it is the reason for its
 * shape: one bounded pass, exit code says what happened, and whatever the
 * operator already uses to run things periodically runs it again. A turn is
 * work a process does; a drain is a process that picks up work somebody
 * else's machine dropped.
 *
 * A session has at most one active turn, so one pass continues at most one.
 */

import { existsSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
	DiskSessionLog,
	InvalidIdError,
	type ProjectId,
	type ResumeOutcome,
	type SessionId,
	type SessionLease,
	type SessionLog,
	SessionPaths,
	type TenantId,
	type TopicId,
	type TurnId,
	asProjectId,
	asSessionId,
	asTenantId,
	claimSession,
	openSessionIndex,
	releaseSession,
} from '@namzu/sdk'

import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_FAIL, EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { readSessionStart } from '../integrations/resident/session-log-reads.js'
import { contextLogging, createStderrSink, installCliLogging } from '../logging.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { compilePermissions } from '../permissions/rules.js'
import { applyProviderFlags, resolveWorkingDirectory } from './exec-flags.js'
import type { CommandDef } from './types.js'

/** The drain flags name a scope the store does not hold: an argument error, exit 64. */
class DrainScopeError extends Error {
	override readonly name = 'DrainScopeError'
}

/** Lease length when the operator names none. Long enough for a real turn. */
const DEFAULT_TTL_MS = 600_000

export interface DrainFlags {
	store: string | null
	tenant: string | null
	project: string | null
	session: string | null
	cwd: string | null
	holder: string | null
	ttlMs: number | null
	maxConcurrent: number | null
	provider: string | null
	model: string | null
	trust: boolean
	unknown: string[]
}

/**
 * Parse `namzu drain`'s flags.
 *
 * Exported and pure so the refusals below are testable without a provider,
 * a store or a directory. Every one of them is a case where proceeding
 * would act on a scope the operator did not name.
 */
export function parseDrainFlags(rawArgs: readonly string[]): DrainFlags {
	const out: DrainFlags = {
		store: null,
		tenant: null,
		project: null,
		session: null,
		cwd: null,
		holder: null,
		ttlMs: null,
		maxConcurrent: null,
		provider: null,
		model: null,
		trust: false,
		unknown: [],
	}
	const value = (a: string, name: string, i: { v: number }): string | undefined => {
		if (a === `--${name}` && i.v + 1 < rawArgs.length) return rawArgs[++i.v]
		if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
		return undefined
	}
	const strings = [
		['store', 'store'],
		['tenant', 'tenant'],
		['project', 'project'],
		['session', 'session'],
		['cwd', 'cwd'],
		['holder', 'holder'],
		['provider', 'provider'],
		['model', 'model'],
	] as const

	for (const idx = { v: 0 }; idx.v < rawArgs.length; idx.v++) {
		const a = rawArgs[idx.v] as string
		if (a === '--trust') {
			out.trust = true
			continue
		}
		let matched = false
		for (const [flag, key] of strings) {
			const v = value(a, flag, idx)
			if (v !== undefined) {
				out[key] = v.trim() || null
				matched = true
				break
			}
		}
		if (matched) continue
		const ttl = value(a, 'ttl', idx)
		if (ttl !== undefined) {
			out.ttlMs = Number(ttl)
			continue
		}
		const conc = value(a, 'max-concurrent', idx)
		if (conc !== undefined) {
			out.maxConcurrent = Number(conc)
			continue
		}
		// Anything unrecognised is refused rather than ignored, positional
		// arguments included — this command takes none. It acts on other
		// people's turns; a typo'd `--tenant` that fell through would drain a
		// scope nobody asked for.
		out.unknown.push(a.split('=')[0] as string)
	}
	return out
}

/** The scope refusal, or the scope: the full tenant → project → session prefix. */
export function resolveDrainScope(flags: Pick<DrainFlags, 'tenant' | 'project' | 'session'>):
	| { readonly error: string }
	| {
			// Not optional. Both are refused above when absent, so the caller
			// was narrowing them back with a cast on every use.
			readonly tenantId: TenantId
			readonly projectId: ProjectId
			readonly sessionId: SessionId
	  } {
	if (!flags.tenant) {
		return {
			error:
				'--tenant is required. A drain with no tenant is a cross-tenant read with a friendly name, so there is no default to fall back to.',
		}
	}
	// A parked turn belongs to one session, and the session to one project;
	// the pass checks both against the session's own log before it claims
	// anything, so it asks for the full prefix.
	if (!flags.project || !flags.session) {
		return {
			error:
				'--project and --session are both required: a turn is drained within one session, and the pass checks that the session belongs to that project before it claims anything.',
		}
	}
	// Prefix-checked, and refused in THIS function's shape rather than by
	// throwing. Every other bad flag here produces an operator-readable
	// sentence; an `InvalidIdError` escaping to the top level would be the one
	// that arrives as a stack trace. A typo'd `--tenant prj_x` previously
	// reached the store as a TenantId and listed nothing, which reads as "no
	// turns" rather than "wrong flag".
	try {
		return {
			tenantId: asTenantId(flags.tenant),
			projectId: asProjectId(flags.project),
			sessionId: asSessionId(flags.session),
		}
	} catch (err) {
		if (err instanceof InvalidIdError) {
			return {
				error: `${err.message} Check --tenant, --project and --session.`,
			}
		}
		throw err
	}
}

/** A per-process holder when the operator names none. */
export function defaultHolder(): string {
	return `namzu-drain-${process.pid}-${Date.now().toString(36)}`
}

/** What one pass over a session did with its active turn. */
export interface DrainPassResult {
	/** Turns the pass found to work on: the session's active turn, if any. */
	readonly listed: number
	readonly resumed: readonly TurnId[]
	/** Parked on a human decision: reported, never resumed past. */
	readonly awaitingDecision: readonly TurnId[]
	/** Nothing to continue from. */
	readonly noCheckpoint: readonly TurnId[]
	/** Another process holds the session's lease. */
	readonly heldByOthers: readonly TurnId[]
	/** Settled or replaced between the listing and the claim. */
	readonly alreadyHandled: readonly TurnId[]
	readonly failed: readonly { readonly turnId: TurnId; readonly error: string }[]
	/** The work landed but the lease could not be given back. */
	readonly unreleased: readonly { readonly turnId: TurnId; readonly error: string }[]
}

/** What {@link drainSessionPass} composes. Each is one SDK call in the command. */
export interface DrainPassDeps {
	/** The session's log: where its active turn is read from. */
	readonly log: Pick<SessionLog, 'activeTurn'>
	/** Turns with an unresolved `decision_requested` (`SessionIndex.listPendingDecisions`). */
	readonly pendingDecisionTurns: ReadonlySet<TurnId>
	/** `claimSession`: the lease, or `null` when another process holds it. */
	claim(): Promise<SessionLease | null>
	/** `releaseSession`, in a `finally`. */
	release(lease: SessionLease): Promise<void>
	/** Continue the turn under the lease (`resumeSession` with this host's half attached). */
	resume(turnId: TurnId, lease: SessionLease): Promise<ResumeOutcome>
	readonly info: (message: string) => void
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * One pass: find the session's active turn, report it if a human owes it an
 * answer, otherwise take the session's lease, check the turn is still the
 * active one under that lease, continue it, and give the lease back.
 *
 * A turn waiting on a decision is reported before any claim. The answer
 * belongs to a person; a drainer that continued without it would discard
 * the question the turn stopped to ask, and claiming the session to find
 * that out would only block the person's own resolver.
 */
export async function drainSessionPass(deps: DrainPassDeps): Promise<DrainPassResult> {
	const result = {
		listed: 0,
		resumed: [] as TurnId[],
		awaitingDecision: [] as TurnId[],
		noCheckpoint: [] as TurnId[],
		heldByOthers: [] as TurnId[],
		alreadyHandled: [] as TurnId[],
		failed: [] as { turnId: TurnId; error: string }[],
		unreleased: [] as { turnId: TurnId; error: string }[],
	}
	const active = await deps.log.activeTurn()
	if (!active) return result
	result.listed = 1
	const { turnId } = active
	if (deps.pendingDecisionTurns.has(turnId)) {
		result.awaitingDecision.push(turnId)
		deps.info(`⏸ ${turnId} · waiting on a human decision`)
		return result
	}
	const lease = await deps.claim()
	if (!lease) {
		result.heldByOthers.push(turnId)
		deps.info(`⋯ ${turnId} · another process holds the session`)
		return result
	}
	try {
		deps.info(`⏵ ${turnId} · ${active.state} · fence ${lease.fence}`)
		// Re-read under the lease: between the listing and the claim, the
		// previous holder may have settled the turn, or a new one begun.
		const current = await deps.log.activeTurn({ lease })
		if (current?.turnId !== turnId) {
			result.alreadyHandled.push(turnId)
			deps.info(`↷ ${turnId} · settled before this pass took it`)
			return result
		}
		const outcome = await deps.resume(turnId, lease)
		if (outcome.resumed) {
			if (outcome.turn.status === 'failed' || outcome.turn.status === 'cancelled') {
				throw new Error(`Resumed turn ended with status "${outcome.turn.status}".`)
			}
			result.resumed.push(turnId)
			deps.info(`✔ ${turnId} · ${outcome.turn.status}`)
		} else if (outcome.reason === 'awaiting-decision') {
			// The index had not yet seen the decision; the log had.
			result.awaitingDecision.push(turnId)
			deps.info(`⏸ ${turnId} · waiting on a human decision`)
		} else {
			result.noCheckpoint.push(turnId)
			deps.info(`∅ ${turnId} · no checkpoint to continue from`)
		}
	} catch (error) {
		result.failed.push({ turnId, error: errorText(error) })
	} finally {
		try {
			await deps.release(lease)
		} catch (error) {
			result.unreleased.push({ turnId, error: errorText(error) })
		}
	}
	return result
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first
		? {
				version: 3,
				providers: [{ id: first.entry.id }],
				subagents: { active: [] },
			}
		: null
}

/** `--store` must already be a namzu home: a drain never creates state where it looks. */
function isNamzuHome(home: string): boolean {
	const projects = join(home, 'projects')
	if (!existsSync(projects)) return false
	const entry = lstatSync(projects)
	return entry.isDirectory() && !entry.isSymbolicLink()
}

export const drainCommand: CommandDef = {
	name: 'drain',
	description: 'Continue a turn another process left behind (one pass, then exit)',
	passThrough: true,
	help: [
		'Usage: namzu drain --store <dir> --tenant <id> --project <id> --session <id>',
		'',
		"Take the session's parked or interrupted turn if no worker holds the",
		'session, continue it from its last checkpoint under the session lease, and',
		'release the lease. One pass, then exit — this is a command your own',
		'scheduler runs, not a service. (namzu’s scheduler daemon runs scheduled',
		'jobs only, and never resumes past a decision a person has to make.)',
		'',
		'Options:',
		'  --store <dir>         The namzu home whose sessions to drain (NAMZU_HOME)',
		'  --tenant <id>         Isolation boundary. Required; there is no default',
		'  --project <id>        Required — checked against the session log',
		'  --session <id>        Required: the session whose turn to continue',
		'  --holder <id>         Who is taking the session. Must be unique PER PROCESS',
		'  --ttl <ms>            Lease length (default 600000)',
		'  --max-concurrent <n>  Turns in flight at once (default 1). A session has',
		'                        one active turn, so a pass continues at most one',
		'  --cwd <path>          Directory the resumed turn works in',
		'  --provider <id>       Provider to continue with',
		'  --model <id>          Model to continue with',
		'  --trust               Accept this folder for this pass',
		'',
		'A turn that is parked on a human decision is REPORTED, never resumed past.',
		'The answer belongs to a person; a drainer that continued without it would',
		'discard the question the turn stopped to ask.',
		'',
		'Exit codes: 0 when every turn it took was continued, 1 when any turn failed,',
		'64 when an argument is wrong, 77 when the folder has not been trusted.',
	].join('\n'),
	handler: async ({ ctx: bootstrapCtx, rawArgs }) => {
		let ctx = bootstrapCtx
		const flags = parseDrainFlags(rawArgs)
		if (flags.unknown.length > 0) {
			ctx.formatter.error({
				message: `unknown option(s): ${flags.unknown.join(', ')}`,
			})
			return EXIT_USAGE
		}
		if (!flags.store) {
			ctx.formatter.error({
				message:
					'--store is required: name the namzu home whose sessions to drain. There is no default, because an empty queue and a directory nobody writes to would report the same thing.',
			})
			return EXIT_USAGE
		}
		const scope = resolveDrainScope(flags)
		if ('error' in scope) {
			ctx.formatter.error({ message: scope.error })
			return EXIT_USAGE
		}
		const ttlMs = flags.ttlMs ?? DEFAULT_TTL_MS
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			ctx.formatter.error({
				message: `--ttl must be a positive number of ms, got ${flags.ttlMs}`,
			})
			return EXIT_USAGE
		}
		if (
			flags.maxConcurrent !== null &&
			(!Number.isSafeInteger(flags.maxConcurrent) || flags.maxConcurrent < 1)
		) {
			ctx.formatter.error({
				message: `--max-concurrent must be a whole number above zero, got ${flags.maxConcurrent}`,
			})
			return EXIT_USAGE
		}
		const resolved = resolveWorkingDirectory(flags.cwd)
		if ('error' in resolved) {
			ctx.formatter.error({ message: resolved.error })
			return EXIT_USAGE
		}
		const trust = decideHeadlessTrust({
			cwd: resolved.cwd,
			trustFlag: flags.trust,
		})
		if (!trust.allowed) {
			ctx.formatter.error({ message: trust.message ?? 'folder not trusted' })
			return EXIT_UNTRUSTED
		}
		const cwd = trust.cwd
		ctx = resolveTrustedProjectContext(bootstrapCtx, cwd)

		// The CLI owns stderr, not the kernel it drives (LOG-05) — a live sink
		// at the level --verbose/--quiet/NAMZU_LOG_LEVEL named, instead of
		// forcing the level to `silent` via `configureLogger`. `{ replace:
		// true }`: see the identical comment in `exec.ts` — a real invocation
		// calls this once, this package's own tests call a handler's more
		// than once per process.
		const logging = contextLogging(ctx)
		installCliLogging(createStderrSink(logging.format), logging.level)
		const { probeAgentSession, createAgentSession } = await import('../tui/agent.js')
		const probe = await probeAgentSession()
		let prefs = probe.preferences ?? defaultPrefs(probe.detected)
		if (!prefs) {
			ctx.formatter.error({
				message:
					'no LLM provider available — set a credential (e.g. ANTHROPIC_API_KEY) or run `namzu` to pick one',
			})
			return 1
		}
		prefs = applyProviderFlags(prefs, flags)
		const permissions = compilePermissions(ctx.config.permissions, ctx.config.permissionChecks)
		for (const diagnostic of permissions.diagnostics) {
			const where = diagnostic.pattern
				? `permissions.${diagnostic.tool}."${diagnostic.pattern}"`
				: `permissions.${diagnostic.tool}`
			ctx.formatter.error({ message: `${where}: ${diagnostic.message}` })
		}

		const home = resolve(flags.store)
		let log: SessionLog
		let topicId: TopicId
		let pendingDecisionTurns: Set<TurnId>
		try {
			if (!isNamzuHome(home)) throw new DrainScopeError(`${home} holds no projects/ directory`)
			// The index is derived from the logs; opening it brings it up to date.
			const index = await openSessionIndex({ home })
			try {
				const indexed = await index.getSession(scope.sessionId)
				if (!indexed || indexed.projectId !== scope.projectId) {
					throw new DrainScopeError(
						`Session ${scope.sessionId} is not persisted under Project ${scope.projectId}`,
					)
				}
				if (indexed.depth > 0) {
					throw new DrainScopeError(
						`Session ${scope.sessionId} is a child session; drain its root session ${indexed.rootId}`,
					)
				}
				const paths = new SessionPaths({ home, slug: indexed.slug })
				const opened = await readSessionStart(
					home,
					paths.sessionLog({ sessionId: scope.sessionId }),
				)
				if (
					!opened ||
					opened.sessionId !== scope.sessionId ||
					opened.projectId !== scope.projectId ||
					opened.tenantId !== scope.tenantId
				) {
					throw new DrainScopeError(
						`Session ${scope.sessionId} was not opened under Tenant ${scope.tenantId} and Project ${scope.projectId}`,
					)
				}
				if (!opened.topicId) {
					throw new DrainScopeError(`Session ${scope.sessionId} records no topic to continue under`)
				}
				topicId = opened.topicId
				log = DiskSessionLog.at(paths, { sessionId: scope.sessionId })
				pendingDecisionTurns = new Set(
					(await index.listPendingDecisions({ sessionId: scope.sessionId })).map(
						(decision) => decision.turnId,
					),
				)
			} finally {
				index.close()
			}
		} catch (error) {
			ctx.formatter.error({
				message: `cannot resolve the drain session: ${errorText(error)}`,
			})
			// The flags named something that is not there (no namzu home, an
			// unknown or child session, a scope mismatch): the caller's to fix.
			// Anything else is state that could not be read, which is exit 1.
			return error instanceof DrainScopeError ? EXIT_USAGE : EXIT_FAIL
		}

		const session = await createAgentSession(prefs, probe.detected, {
			cwd,
			scope: {
				// The session is exactly the one the required flags named.
				// Constructing the provider under a random CLI Project and
				// Session would create generated state for a scope the operator
				// never named, then resume the turn under a different one.
				sessionId: scope.sessionId,
				topicId,
				projectId: scope.projectId,
				tenantId: scope.tenantId,
			},
			stateRoot: home,
			rules: permissions.rules,
			permissionMode: 'auto',
			...(ctx.config.limits ? { limits: ctx.config.limits } : {}),
			...(ctx.config.compaction ? { compaction: ctx.config.compaction } : {}),
			...(ctx.config.memory ? { memory: ctx.config.memory } : {}),
			...(ctx.config.web ? { web: ctx.config.web } : {}),
			...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
			...(ctx.config.plugins ? { plugins: ctx.config.plugins } : {}),
			...(ctx.config.sandbox ? { sandbox: ctx.config.sandbox } : {}),
			// `!== undefined`, not truthiness: an empty list is the operator
			// turning the default screen OFF, and a falsy check would drop it.
			...(ctx.config.toolResultScreens !== undefined
				? { toolResultScreens: ctx.config.toolResultScreens }
				: {}),
		})
		if (!session.hasProvider) {
			await session.close()
			ctx.formatter.error({
				message: session.errorHint ?? 'agent is not ready',
			})
			return 1
		}

		const holder = flags.holder ?? defaultHolder()
		try {
			const result = await drainSessionPass({
				log,
				pendingDecisionTurns,
				claim: () => claimSession(scope.sessionId, { holder, ttlMs, log }),
				release: (lease) => releaseSession(scope.sessionId, lease, { log }),
				resume: (turnId, lease) =>
					session.resumeDurable({
						entry: {
							tenantId: scope.tenantId,
							projectId: scope.projectId,
							sessionId: scope.sessionId,
							turnId,
						},
						sessionLog: log,
						// The reason the lease is handed over at all: every record
						// the resumed turn appends carries its fence, so a drainer
						// that stalled past its lease cannot write over whoever
						// took the session over.
						lease,
					}),
				info: (message) => ctx.formatter.info(message),
			})

			ctx.formatter.print({
				listed: result.listed,
				resumed: result.resumed.length,
				awaitingDecision: result.awaitingDecision,
				noCheckpoint: result.noCheckpoint,
				heldByOthers: result.heldByOthers,
				alreadyHandled: result.alreadyHandled,
				failed: result.failed,
				unreleased: result.unreleased,
			})
			for (const f of result.failed) {
				ctx.formatter.error({ message: `${f.turnId}: ${f.error}` })
			}
			// A drain that could not give a lease back is reported too. The work
			// landed, but the session is unavailable to the next reader until the
			// lease lapses, and an operator watching throughput needs to know.
			for (const u of result.unreleased) {
				ctx.formatter.error({
					message: `${u.turnId}: lease not released — ${u.error}`,
				})
			}
			return result.failed.length > 0 ? 1 : 0
		} catch (err) {
			// A refusal from the log or the lease lands here. Reported rather
			// than swallowed into an empty pass that reads as "nothing was parked".
			ctx.formatter.error({ message: errorText(err) })
			return 1
		} finally {
			await session.close()
		}
	},
}
