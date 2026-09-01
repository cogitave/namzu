/**
 * `namzu drain` — one pass over a queue of durable runs.
 *
 * namzu could park a run in one process and continue it in another, and no
 * shipped surface ever did: `claimRun`, `listDurableRuns` and `resumeRun`
 * all existed, and the only caller of any of them was a test. This is the
 * caller. It lists the runs nobody holds under a scope, takes each one,
 * continues it under that claim, and gives it back.
 *
 * **It is not a daemon, and `namzu serve` still says namzu has no daemon.**
 * That refusal is not weakened by this command, it is the reason for its
 * shape: one bounded pass, exit code says what happened, and whatever the
 * operator already uses to run things periodically runs it again. A run is
 * a process; a drain is a process that picks up processes somebody else's
 * machine dropped.
 *
 * The store is named rather than assumed. namzu's own runs are not
 * checkpointed to disk today, so every run this command can find was
 * written by an SDK host — and a default path would have this command
 * report "nothing parked" against a directory nobody writes to, which is
 * the reading that makes an empty queue indistinguishable from a missing
 * one.
 */

import {
	DiskCheckpointStore,
	InvalidIdError,
	asProjectId,
	asSessionId,
	asTenantId,
	asTopicId,
	drainRuns,
} from '@namzu/sdk'
import type { DurableRunEntry, ProjectId, SessionId, TenantId } from '@namzu/sdk'

import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { contextLogging, createStderrSink, installCliLogging } from '../logging.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { compilePermissions } from '../permissions/rules.js'
import { applyProviderFlags, resolveWorkingDirectory } from './run-flags.js'
import type { CommandDef } from './types.js'

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
		// people's runs; a typo'd `--tenant` that fell through would drain a
		// scope nobody asked for.
		out.unknown.push(a.split('=')[0] as string)
	}
	return out
}

/** The scope refusal, or the scope. Contiguous prefix — see the store contract. */
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
				'--tenant is required. A run listing with no tenant is a cross-tenant read with a friendly name, so there is no default to fall back to.',
		}
	}
	// The disk store keys checkpoints by directory and needs the project and
	// session to attribute what it finds, so this command asks for the full
	// prefix rather than the contract's minimum.
	if (!flags.project || !flags.session) {
		return {
			error:
				'--project and --session are both required for a disk store: its layout carries no attribution, so it cannot say which project and session the runs it finds belong to.',
		}
	}
	// Prefix-checked, and refused in THIS function's shape rather than by
	// throwing. Every other bad flag here produces an operator-readable
	// sentence; an `InvalidIdError` escaping to the top level would be the one
	// that arrives as a stack trace. A typo'd `--tenant prj_x` previously
	// reached the store as a TenantId and listed nothing, which reads as "no
	// runs" rather than "wrong flag".
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

function describe(entry: DurableRunEntry): string {
	const park = entry.park ? `${entry.park.state} ${entry.park.requestType}` : 'not parked'
	return `${entry.runId} · ${entry.checkpointCount} checkpoints · ${park}`
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

export const drainCommand: CommandDef = {
	name: 'drain',
	description: 'Continue runs another process left behind (one pass, then exit)',
	passThrough: true,
	help: [
		'Usage: namzu drain --store <dir> --tenant <id> --project <id> --session <id>',
		'',
		'Take every run under that scope that no worker currently holds, continue',
		'it from its last checkpoint, and release it. One pass, then exit — namzu',
		'has no daemon, and this is a command your scheduler runs, not a service.',
		'',
		'Options:',
		'  --store <dir>         The runs/ directory a checkpoint store writes to',
		'  --tenant <id>         Isolation boundary. Required; there is no default',
		'  --project <id>        Required — the disk layout carries no attribution',
		'  --session <id>        Required, same reason',
		'  --holder <id>         Who is taking the runs. Must be unique PER PROCESS',
		'  --ttl <ms>            Lease length (default 600000)',
		'  --max-concurrent <n>  Runs in flight at once (default 1)',
		'  --cwd <path>          Directory the resumed runs work in',
		'  --provider <id>       Provider to continue with',
		'  --model <id>          Model to continue with',
		'  --trust               Accept this folder for this pass',
		'',
		'A run that is parked on a human decision is REPORTED, never resumed past.',
		'The answer belongs to a person; a drainer that continued without it would',
		'discard the question the run stopped to ask.',
		'',
		'Exit codes: 0 when every run it took was continued, 1 when any run failed,',
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
					'--store is required: name the runs/ directory the checkpoint store writes to. There is no default, because an empty queue and a directory nobody writes to would report the same thing.',
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
		// true }`: see the identical comment in `run.ts` — a real invocation
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
		let stateRoot: string
		try {
			stateRoot = resolveNamzuHome()
		} catch (error) {
			ctx.formatter.error({
				message: `application state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
			})
			return 1
		}

		const session = await createAgentSession(prefs, probe.detected, {
			cwd,
			scope: {
				// The checkpoint queue is already exactly scoped by the required
				// flags below. Constructing the provider under a random CLI Project
				// and Session would create generated state for a scope the operator
				// never named, then resume the run under a different one.
				sessionId: scope.sessionId,
				topicId: asTopicId('top_namzu-cli'),
				projectId: scope.projectId,
				tenantId: scope.tenantId,
			},
			stateRoot,
			rules: permissions.rules,
			permissionMode: 'auto',
			...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
			...(ctx.config.plugins ? { plugins: ctx.config.plugins } : {}),
			...(ctx.config.sandbox ? { sandbox: ctx.config.sandbox } : {}),
		})
		if (!session.hasProvider) {
			await session.close()
			ctx.formatter.error({
				message: session.errorHint ?? 'agent is not ready',
			})
			return 1
		}

		// `resolveDrainScope` refuses a partial prefix above, so all three are
		// present here; the store's attribution has no optional fields because
		// a listing that guessed one would file runs under a project nobody
		// named.
		const store = new DiskCheckpointStore(
			{ baseDir: flags.store },
			{
				tenantId: scope.tenantId,
				projectId: scope.projectId,
				sessionId: scope.sessionId,
			},
		)
		const holder = flags.holder ?? defaultHolder()
		const awaiting: string[] = []
		const empty: string[] = []

		try {
			const result = await drainRuns({
				store,
				scope,
				holder,
				ttlMs,
				...(flags.maxConcurrent !== null ? { maxConcurrent: flags.maxConcurrent } : {}),
				onRun: async (entry, claim) => {
					ctx.formatter.info(`⏵ ${describe(entry)} · fence ${claim.fence}`)
					const outcome = await session.resumeDurable({
						entry,
						checkpointStore: store,
						// The reason the claim is handed over at all: every durable
						// write this run makes carries it, so a drainer that stalled
						// past its lease cannot overwrite whoever took over.
						claimFence: claim.fence,
					})
					if (outcome.resumed) {
						ctx.formatter.info(`✔ ${entry.runId} · ${outcome.run.status}`)
						return
					}
					// Reported, not resumed past. The two non-resumed outcomes mean
					// opposite things and an operator has to be able to tell them
					// apart: one is a question waiting on a person, the other is a
					// run with nothing to continue.
					if (outcome.reason === 'awaiting-decision') {
						awaiting.push(entry.runId)
						ctx.formatter.info(`⏸ ${entry.runId} · waiting on a human decision`)
					} else {
						empty.push(entry.runId)
						ctx.formatter.info(`∅ ${entry.runId} · no checkpoint to continue from`)
					}
				},
			})

			ctx.formatter.print({
				listed: result.listed,
				resumed: result.drained.filter((id) => !awaiting.includes(id) && !empty.includes(id))
					.length,
				awaitingDecision: awaiting,
				noCheckpoint: empty,
				heldByOthers: result.skipped,
				alreadyHandled: result.stale,
				failed: result.failed,
				unreleased: result.unreleased,
			})
			for (const f of result.failed) {
				ctx.formatter.error({ message: `${f.runId}: ${f.error}` })
			}
			// A drain that could not give a lease back is reported too. The work
			// landed, but the run is unavailable to the next reader until the
			// lease lapses, and an operator watching throughput needs to know.
			for (const u of result.unreleased) {
				ctx.formatter.error({
					message: `${u.runId}: lease not released — ${u.error}`,
				})
			}
			return result.failed.length > 0 ? 1 : 0
		} catch (err) {
			// The refusals from `drainRuns` land here: a store that cannot claim,
			// a lease that cannot mean what it says. Reported rather than
			// swallowed into an empty pass that reads as "nothing was parked".
			ctx.formatter.error({
				message: err instanceof Error ? err.message : String(err),
			})
			return 1
		} finally {
			await session.close()
		}
	},
}
