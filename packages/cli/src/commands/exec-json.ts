/**
 * `namzu exec --json [--session <key>] "<prompt>"` — the headless one-shot as
 * a STREAM. Same engine as the default mode, but instead of buffering the
 * final text it emits one compact NDJSON line per `AgentEvent` to stdout
 * (`{"kind":"delta","text":…}`, `{"kind":"tool-start",…}`,
 * `{"kind":"error","message":…}`, `{"kind":"done"}`). A host process — a
 * desktop app embedding namzu, say — line-scans stdout and renders the turn
 * live: the equivalent of the TUI, driven from another runtime.
 *
 * History: with `--session <key>` the turn is bound to a persisted
 * conversation in the project the canonical cwd stands for (keyed by the
 * embedder's own session id, recorded on the conversation's
 * `session_started.origin`), so prior turns are folded from its session log as
 * context and the kernel appends this turn to that log as it runs — opaque
 * reasoning and complete tool turns included. That's what lets a reopened
 * session show and replay its past messages (`namzu history --session
 * <key>`). Without `--session`, prior history may be supplied on stdin as a
 * JSON `Message[]` and the turn works in an in-memory log: nothing is
 * persisted (a stateless one-shot).
 *
 * Status lines go to stderr as NDJSON (LOG-05), never stdout, so every
 * stdout line is a valid JSON event, and EVERY failure is reported in band,
 * including the ones that also carry an exit code.
 *
 * ## What the exit code means
 *
 * It used to be explained as "a turn that STARTED and failed exits 0; a refusal
 * to start exits non-zero", and that rule did not sort the cases it was applied
 * to. An unknown option, a missing prompt, a `--cwd` that is not there and a
 * tool server that will not connect are all refusals to start, and all four
 * exited 0 while an untrusted folder exited 77. Neither does the retry argument
 * the old comment appealed to: retrying an unknown option is exactly as
 * pointless as retrying an untrusted folder.
 *
 * The axis that does sort them:
 *
 *   CAN THE CALLER REACH THE TURN IT ASKED FOR BY CHANGING WHAT IT SENDS?
 *
 * - **Yes → `0`.** The host reads the `error` event and fixes its own
 *   invocation. An unknown option, no prompt, a `--cwd` that does not exist, a
 *   `--permission-mode` that is not a mode, an interactive command named
 *   headlessly, a provider id that is not a provider.
 * - **A turn that started and failed → `0`.** Unchanged: that is an outcome to
 *   render, and possibly to retry.
 * - **Not now → `75`.** The conversation already has an active turn — a
 *   paused one waiting on a decision or a drain, or one another process is
 *   running — so this turn was not begun. The event is
 *   `{"kind":"error","code":"turn_in_progress",...}` naming the turn.
 * - **No → non-zero, because a person has to go and do something.** `77` when
 *   the folder is untrusted — kept to that one condition, because being
 *   unambiguous is its entire justification. `1` for everything else in this
 *   group: a conversation that cannot be opened, no provider available, a
 *   credential or driver the session needs, a declared tool server that is not
 *   there, a command file that will not parse.
 *
 * `1` rather than a new code because the default mode of `namzu exec` — the
 * same one-shot, differing only in how it prints — already exits `1` for these
 * conditions and `77` for trust. A host that shells to one for a script and the other for a UI must not
 * be handed two tables for one fact.
 *
 * Dropping `--session` is NOT "the caller fixing it": it abandons what was
 * asked for rather than achieving it.
 */

import {
	type Message,
	type SessionId,
	type StructuredOutputConfig,
	TurnCancelled,
	generateSessionId,
	jsonLinesSink,
} from '@namzu/sdk'

/** EX_TEMPFAIL: the conversation already has an active turn; try again later. */
const EXIT_TURN_IN_PROGRESS = 75

import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_FAIL, EXIT_OK, EXIT_UNTRUSTED } from '../exit-codes.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import {
	closeSessions,
	loadConversation,
	openSessions,
	resolveConversation,
} from '../integrations/sessions/store.js'
import { contextLogging, installCliLogging } from '../logging.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { resolvePermissionMode } from '../permissions/mode.js'
import { compilePermissions } from '../permissions/rules.js'
import type { TerminationHandling } from '../termination.js'
import type { AgentEvent } from '../tui/agent.js'
import { hostCommandNames } from '../tui/slashCommands.js'
import { expandHeadlessCommand } from '../user-commands/store.js'
import {
	type ExecFlags,
	applyProviderFlags,
	buildGate,
	loadSkillsContext,
	resolveWorkingDirectory,
	unknownOptionMessage,
} from './exec-flags.js'
import { parsePriorMessages } from './prior-messages.js'
import { readStdin } from './stdin.js'
import type { CommandHandlerArgs } from './types.js'

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

/**
 * `exec --json`. `flags` are already parsed; `structuredOutput` is the loaded
 * `--output-schema`, or an error loading it that is reported in band.
 */
export async function execJson(
	{ ctx: bootstrapCtx }: CommandHandlerArgs,
	termination: TerminationHandling,
	flags: ExecFlags,
	structuredOutput: StructuredOutputConfig | { readonly error: string } | undefined,
): Promise<number> {
	let ctx = bootstrapCtx
	const write = (o: unknown): void => {
		process.stdout.write(`${JSON.stringify(o)}\n`)
	}
	/**
	 * Report and stop.
	 *
	 * Always in band, always terminated with `done`, and the code says only
	 * whether the caller can reach the turn by sending something else. The
	 * argument for each case is in this file's header; the two spellings exist
	 * so that every call site below has to state which side it is on rather
	 * than inheriting a default nobody re-reads.
	 */
	const fail = (message: string): number => {
		write({ kind: 'error', message })
		write({ kind: 'done' })
		return EXIT_OK
	}
	const refuse = (message: string): number => {
		write({ kind: 'error', message })
		write({ kind: 'done' })
		return EXIT_FAIL
	}

	// The turn's leash: the config file's limits, with a flag overriding each.
	const limitsFromFlags = {
		...(flags.maxIterations !== null ? { maxIterations: flags.maxIterations } : {}),
		...(flags.tokenBudget !== null ? { tokenBudget: flags.tokenBudget } : {}),
	}
	if (flags.unknown.length > 0) return fail(unknownOptionMessage(flags.unknown))
	if (structuredOutput && 'error' in structuredOutput) return fail(structuredOutput.error)
	// `--continue` and `--resume` parse here because both modes share one
	// parser, and this mode reads neither. Accepting a flag and doing
	// nothing with it is the failure mode the shared parser was introduced to
	// end: a host that asked to reopen a conversation was given a stateless
	// turn, reported as an ordinary success, and the next turn had no history
	// with nothing anywhere connecting the two. Refused instead, and named,
	// because a host CAN fix this — `--session` is the flag it wanted.
	if (flags.continueLast || flags.resume !== null) {
		return fail(
			'exec --json does not take --continue or --resume; they belong to the default mode. Bind history with --session <id>, which keys a persisted conversation in this folder.',
		)
	}
	// Same reasoning for the wait budget: this mode streams a pause to its
	// host as an event and the host decides when to resume; a flag it accepted
	// and ignored would promise a wait that never happens.
	if (flags.waitForProviderMs !== null) {
		return fail(
			'exec --json does not take --wait-for-provider; it belongs to the default mode. A host reads the paused event and resumes when it chooses.',
		)
	}
	const sessionKey = flags.session
	const prompt = flags.rest.join(' ').trim()
	if (!prompt) return fail('no prompt — pass it as an argument')
	const resolved = resolveWorkingDirectory(flags.cwd)
	if ('error' in resolved) return fail(resolved.error)
	const requestedCwd = resolved.cwd

	// Before the session store is opened, before anything is read or run in
	// that directory.
	//
	// Reported BOTH ways, which is the one place this command departs from
	// its "every failure is an in-band event and the exit code is 0" rule.
	// That rule is about a turn that STARTED and failed, which a host should
	// render and may sensibly retry. This is a refusal to start at all, and
	// a host that cannot tell the two apart will retry the one that must not
	// be retried — so the event carries the explanation and the exit code
	// carries the fact that nothing ran.
	const trust = decideHeadlessTrust({
		cwd: requestedCwd,
		trustFlag: flags.trust,
	})
	if (!trust.allowed) {
		write({ kind: 'error', message: trust.message ?? 'folder not trusted' })
		write({ kind: 'done' })
		return EXIT_UNTRUSTED
	}
	const cwd = trust.cwd
	ctx = resolveTrustedProjectContext(bootstrapCtx, cwd)

	// Project command discovery belongs behind the target folder's trust
	// gate, alongside project config and instructions.
	const expansion = expandHeadlessCommand(prompt, {
		cwd,
		builtins: hostCommandNames(),
	})
	if (expansion.kind === 'refused') {
		return expansion.fixable ? fail(expansion.reason) : refuse(expansion.reason)
	}
	const finalPrompt = expansion.kind === 'expanded' ? expansion.prompt : prompt

	// Resolve the workspace's central Project for every turn. A session key
	// additionally binds a durable conversation; without one, stdin history
	// remains stateless and no Session record is created.
	let cli: Awaited<ReturnType<typeof openSessions>>
	let conversationId: SessionId | null = null
	let prior: Message[] = []
	if (!sessionKey) {
		const parsed = parsePriorMessages(await readStdin({ deadline: true }))
		if (!parsed.ok) return fail(`invalid stdin history: ${parsed.error}`)
		prior = [...parsed.messages]
	}
	try {
		cli = await openSessions(cwd)
		if (sessionKey) {
			conversationId = await resolveConversation(cli, sessionKey)
			prior = await loadConversation(cli, conversationId)
		}
	} catch (err) {
		if (sessionKey) {
			// Refused, not run stateless.
			//
			// This used to set `cli = null` and fall through to the branch
			// below, which reads prior turns from STDIN — so a caller who named
			// a conversation got a turn answered against a different history,
			// or none, reported as an ordinary success. The default mode already
			// refuses the equivalent, in those words: someone who asked for a
			// specific conversation and got a new one that looks the same finds
			// out several turns later, having already acted on it.
			//
			// It cannot be softened into a warning, because we cannot say what
			// was lost. `resolveConversation` creates the key on first use, so
			// a fresh key legitimately has no prior turns — and the failure is
			// exactly what stopped us finding out which case this is. "Could
			// not look" is not "there was nothing there."
			//
			// In band, like every other failure here, because that is what the
			// host reads. No session has been built at this point in the flow,
			// so there is nothing to close on the way out.
			//
			// Non-zero, which is the correction #321 is about. `resolveConversation`
			// CREATES the key on first use, so this cannot be a key the host got
			// wrong — the only way here is the store itself: an unwritable
			// `.namzu`, a corrupt map file. Nothing the host sends changes that,
			// so a host treating 0 as "render the error and move on" would loop
			// on an environment fault it could have raised to a person. Dropping
			// `--session` is not a fix; it abandons what was asked for.
			return refuse(
				`could not open conversation "${sessionKey}": ${err instanceof Error ? err.message : String(err)}. Nothing ran, because continuing the wrong history is worse than not continuing. Drop --session to run this turn stateless.`,
			)
		}
		return refuse(
			`could not open workspace state: ${err instanceof Error ? err.message : String(err)}. Nothing ran, because generated state could not be bound to this working directory.`,
		)
	}
	// Always NDJSON on stderr, regardless of --log-format/NAMZU_LOG_FORMAT
	// — this is the machine-read channel §6.6 of the logging design
	// describes, and stdout's own protocol is unaffected by anything the
	// operator passes, so stderr here stays that way too. `{ replace:
	// true }`: see `exec.ts`'s identical comment.
	const logging = contextLogging(ctx)
	installCliLogging(jsonLinesSink(process.stderr), logging.level)
	const { probeAgentSession, createAgentSession } = await import('../tui/agent.js')
	const probe = await probeAgentSession()
	let prefs = probe.preferences ?? defaultPrefs(probe.detected)
	if (!prefs) {
		// Nothing detected and nothing configured. `--provider` cannot conjure a
		// credential, so no argument the host changes gets past this line.
		return refuse(
			'no LLM provider available — set a credential (e.g. ANTHROPIC_API_KEY) or run `namzu` to pick one',
		)
	}
	// --provider/--model override the persona's configured provider+model for
	// this turn, so the Namzu tab's picks win over ~/.namzu/preferences.json.
	prefs = applyProviderFlags(prefs, flags)

	// The operator's rules and mode reach this mode too. They did not:
	// `[permissions]` was compiled for the printing one-shot and never for the streaming one, so a
	// host UI ran with an empty rule list whatever the config said — the same
	// shape as a flag that parses and does nothing, one level larger, and
	// silent in exactly the same way.
	const modeResult = resolvePermissionMode({
		flag: flags.permissionMode,
		skipPermissions: flags.skipPermissions,
		interactive: false,
	})
	if ('error' in modeResult) return fail(modeResult.error)

	const permissions = compilePermissions(ctx.config.permissions, ctx.config.permissionChecks)
	for (const d of permissions.diagnostics) {
		const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
		// In band, because a host line-scanning stdout has no other channel —
		// and a permission the operator believes is in force must never be
		// dropped without saying so.
		write({ kind: 'error', message: `${where}: ${d.message}` })
	}

	// The resolved `--cwd` is what the agent's tools resolve against, not just
	// where the session store lives — a turn told to work in another checkout
	// has to glob, read and edit files there.
	const gate = buildGate(flags, cwd)
	const session = await createAgentSession(prefs, probe.detected, {
		cwd,
		...(structuredOutput ? { structuredOutput } : {}),
		scope: {
			sessionId: conversationId ?? generateSessionId(),
			topicId: cli.topicId,
			projectId: cli.projectId,
			tenantId: cli.tenantId,
		},
		stateRoot: cli.root,
		// A keyed conversation appends to its log; a stateless one runs in an
		// in-memory log, so nothing is written for it.
		...(conversationId ? { conversationSessions: cli } : { ephemeral: true }),
		rules: permissions.rules,
		// The operator's --gate commands, as a standing condition on the
		// answer. Spread rather than passed as undefined so a turn without
		// gates is byte-identical to the one that shipped before them.
		...(gate ?? {}),
		permissionMode: modeResult.mode,
		...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
		...(ctx.config.plugins ? { plugins: ctx.config.plugins } : {}),
		...(ctx.config.skills ? { skills: ctx.config.skills } : {}),
		...(ctx.config.web ? { web: ctx.config.web } : {}),
		...(ctx.config.hooks ? { hooks: ctx.config.hooks } : {}),
		...(ctx.config.compaction ? { compaction: ctx.config.compaction } : {}),
		...(ctx.config.memory ? { memory: ctx.config.memory } : {}),
		...(Object.keys({ ...ctx.config.limits, ...limitsFromFlags }).length > 0
			? { limits: { ...ctx.config.limits, ...limitsFromFlags } }
			: {}),
		...(ctx.config.sandbox ? { sandbox: ctx.config.sandbox } : {}),
		// `!== undefined`, not truthiness: an empty list is the operator
		// turning the default screen OFF, and a falsy check would drop it.
		...(ctx.config.toolResultScreens !== undefined
			? { toolResultScreens: ctx.config.toolResultScreens }
			: {}),
	})
	if (!session.hasProvider) {
		await session.close()
		// The one branch here that is genuinely BOTH. `createAgentSession`
		// refuses an id that is not a provider — which `--provider` put there,
		// so the host fixes it — and, with the same result object, a missing
		// credential, a driver package that would not load, a chain that
		// contradicts itself, a client that would not construct. None of those
		// four move for any argument.
		//
		// The session says which, in a field. Deciding it here by reading its
		// `errorHint` would be the message-matching that `exit-codes.ts` exists
		// to prevent, and would make that sentence unrewordable.
		const message = session.errorHint ?? 'agent is not ready'
		return session.errorKind === 'invocation' ? fail(message) : refuse(message)
	}
	// A configured tool server that is not here means the turn cannot do what
	// the operator set it up to do, and this command answers a host, not a
	// person who might notice. Refused rather than run short — in band, like
	// every other failure here, because that is what the host reads.
	if (session.mcpFailed.length > 0) {
		const said = session.mcpFailed
			.map((f) => `tool server "${f.name}" is not available: ${f.reason}`)
			.join('; ')
		await session.close()
		// The servers come from `namzu.config.json`, not from the invocation, so
		// there is no argument the host can change to bring one up. The default
		// mode already exits 1 here.
		return refuse(said)
	}

	// "Printed on every launch" has to reach a host UI too, or the one caller
	// with no human watching is the one that never hears it. Its own event
	// kind rather than an `error`: the turn is proceeding, and a host that
	// treats this as a failure would be wrong.
	for (const notice of session.configNotices) {
		write({ kind: 'notice', message: notice })
	}

	// --skills <a,b,c>: load the named skills' bodies and inject them as the
	// turn's extra system context (the same channel the TUI's /skill uses).
	const extraSystem = await loadSkillsContext(cwd, flags.skills, ctx.config.skills)

	const userMessage: Message = {
		role: 'user',
		content: finalPrompt,
		timestamp: Date.now(),
	} as Message
	const messages: Message[] = [...prior, userMessage]

	let terminalEvent: Extract<AgentEvent, { kind: 'done' }> | undefined
	let budget: Extract<AgentEvent, { kind: 'usage' }>['budget']
	let busy: Extract<AgentEvent, { kind: 'error' }>['turnInProgress']
	// Stopped from outside (SIGTERM, SIGHUP, SIGINT): the conversation's
	// lease is already given back when this runs (`termination.ts`). The host
	// is told in band and last — one `error` of code "terminated", then the
	// stream's one `done` — then the turn is stopped (its tools' processes go
	// with it) and the session closed. Nothing after those two lines is
	// written. What the error says depends on where the signal found the
	// turn: mid-flight it is left interrupted; once the turn has settled (the
	// session still closing, a slow `session_end` hook) it is recorded, and
	// the `done` is the turn's own.
	const turnAbort = new AbortController()
	let stopped = false
	/** Once the turn has settled: the stream's last line, and what a signal then says. */
	let settled: { readonly last: object; readonly state: string } | undefined
	/** The last line has been written; a signal after this writes nothing. */
	let ended = false
	const inConversation = conversationId ? ` in conversation ${conversationId}` : ''
	termination.onTerminate(async (signal) => {
		stopped = true
		if (!ended) {
			ended = true
			try {
				write({
					kind: 'error',
					code: 'terminated',
					message: settled
						? `stopped by ${signal} ${settled.state}`
						: `stopped by ${signal}; the turn was left interrupted${inConversation}. Close it with /abandon in the TUI, or continue it with /resume or \`namzu drain\`.`,
				})
				write(
					settled?.last ?? {
						kind: 'done',
						...(conversationId ? { sessionId: conversationId } : {}),
					},
				)
			} catch {
				// The reader is gone (SIGHUP, a closed pipe); there is nobody to tell.
			}
		}
		turnAbort.abort(new TurnCancelled('user'))
		await session.close()
		closeSessions(cli)
	})
	let paused: Extract<AgentEvent, { kind: 'paused' }> | undefined
	try {
		for await (const event of session.send(messages, {
			signal: turnAbort.signal,
			...(extraSystem ? { extraSystem } : {}),
			...(flags.effort !== null ? { effort: flags.effort } : {}),
		})) {
			if (stopped) continue
			if ('budget' in event && event.budget) budget = event.budget
			if (event.kind === 'paused') paused = event
			if (event.kind === 'error' && event.turnInProgress) {
				busy = event.turnInProgress
				write({ ...event, code: 'turn_in_progress' })
			} else if (event.kind === 'done') terminalEvent = event
			else write(event)
		}
	} catch (err) {
		// The signal handler closes the session and ends the process.
		if (stopped) return EXIT_OK
		const message = err instanceof Error ? err.message : String(err)
		settled = {
			last: { kind: 'done' },
			state: `after the turn failed (${message})${inConversation}.`,
		}
		await session.close()
		closeSessions(cli)
		if (stopped) return EXIT_OK
		ended = true
		return fail(message)
	}
	if (stopped) return EXIT_OK
	settled = busy
		? {
				// Nothing was begun, so nothing was recorded: the conversation's
				// active turn is still the one it was. Not now, rather than not ever.
				last: { kind: 'done', sessionId: busy.sessionId },
				state: `; no turn was started in conversation ${busy.sessionId}.`,
			}
		: {
				// The kernel appended this turn to the conversation's log as it ran,
				// so a later `history --session <key>` and the next turn's context
				// see it.
				last: {
					...(terminalEvent ?? {
						kind: 'done' as const,
						...(conversationId ? { sessionId: conversationId } : {}),
					}),
					...(budget ? { budget } : {}),
				},
				state: paused
					? `while the turn was paused: it keeps checkpoint ${paused.checkpointId}${inConversation}. Continue it with /resume or \`namzu drain\`, or close it with /abandon in the TUI.`
					: `after the turn ended; it is recorded${inConversation}, and nothing is left to close.`,
			}
	// A stdio tool server is a child process; a command that returns without
	// closing leaves it running.
	await session.close()
	closeSessions(cli)
	// A signal during the close has written the last line already.
	if (stopped) return EXIT_OK
	ended = true
	write(settled.last)
	return busy ? EXIT_TURN_IN_PROGRESS : 0
}
