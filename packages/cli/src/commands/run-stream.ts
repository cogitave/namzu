/**
 * `namzu run-stream [--session <key>] "<prompt>"` — headless STREAMING
 * one-shot. Same engine as `run`, but instead of buffering the final text it
 * emits one compact NDJSON line per `AgentEvent` to stdout
 * (`{"kind":"delta","text":…}`, `{"kind":"tool-start",…}`,
 * `{"kind":"error","message":…}`, `{"kind":"done"}`). A host process — a
 * desktop app embedding namzu, say — line-scans stdout and renders the turn
 * live: the equivalent of the TUI, driven from another runtime.
 *
 * History: with `--session <key>` the turn is bound to a persisted
 * conversation in the central application-home Project associated with the
 * canonical cwd (keyed by the embedder's own session id), so prior turns are
 * loaded as context and the kernel's exact
 * settled conversation projection is published — including opaque reasoning
 * and complete tool turns, excluding its fresh per-run system floor. That's
 * what lets a reopened session show and replay its past messages (`namzu
 * history --session <key>`). Without `--session`,
 * prior history may be supplied on stdin as a JSON `Message[]` and nothing is
 * persisted (stateless one-shot).
 *
 * Status lines go to stderr as NDJSON (LOG-05), never stdout, so every
 * stdout line is a valid JSON event, and EVERY failure is reported in band,
 * including the ones that also carry an exit code.
 *
 * ## What the exit code means
 *
 * It used to be explained as "a run that STARTED and failed exits 0; a refusal
 * to start exits non-zero", and that rule did not sort the cases it was applied
 * to. An unknown option, a missing prompt, a `--cwd` that is not there and a
 * tool server that will not connect are all refusals to start, and all four
 * exited 0 while an untrusted folder exited 77. Neither does the retry argument
 * the old comment appealed to: retrying an unknown option is exactly as
 * pointless as retrying an untrusted folder.
 *
 * The axis that does sort them:
 *
 *   CAN THE CALLER REACH THE RUN IT ASKED FOR BY CHANGING WHAT IT SENDS?
 *
 * - **Yes → `0`.** The host reads the `error` event and fixes its own
 *   invocation. An unknown option, no prompt, a `--cwd` that does not exist, a
 *   `--permission-mode` that is not a mode, an interactive command named
 *   headlessly, a provider id that is not a provider.
 * - **A run that started and failed → `0`.** Unchanged: that is an outcome to
 *   render, and possibly to retry.
 * - **No → non-zero, because a person has to go and do something.** `77` when
 *   the folder is untrusted — kept to that one condition, because being
 *   unambiguous is its entire justification. `1` for everything else in this
 *   group: a conversation that cannot be opened, no provider available, a
 *   credential or driver the session needs, a declared tool server that is not
 *   there, a command file that will not parse.
 *
 * `1` rather than a new code because `namzu run` — the same one-shot, differing
 * only in how it prints — already exits `1` for these conditions and `77` for
 * trust. A host that shells to one for a script and the other for a UI must not
 * be handed two tables for one fact.
 *
 * Dropping `--session` is NOT "the caller fixing it": it abandons what was
 * asked for rather than achieving it.
 */

import { type Message, type SessionId, generateSessionId, jsonLinesSink } from '@namzu/sdk'

import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_FAIL, EXIT_OK, EXIT_UNTRUSTED } from '../exit-codes.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import {
	appendMessages,
	findMappedConversation,
	loadConversation,
	openSessions,
	replaceConversation,
	resolveConversation,
} from '../integrations/sessions/store.js'
import { contextLogging, installCliLogging } from '../logging.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { resolvePermissionMode } from '../permissions/mode.js'
import { compilePermissions } from '../permissions/rules.js'
import { planTurnPublication } from '../tui/conversation-history.js'
import { hostCommandNames } from '../tui/slashCommands.js'
import { expandHeadlessCommand } from '../user-commands/store.js'
import { parsePriorMessages } from './prior-messages.js'
import {
	applyProviderFlags,
	buildGate,
	loadSkillsContext,
	parseRunFlags,
	resolveWorkingDirectory,
	unknownOptionMessage,
} from './run-flags.js'
import type { CommandDef } from './types.js'

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return ''
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString('utf8')
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

export const runStreamCommand: CommandDef = {
	name: 'run-stream',
	description: 'Run a single prompt and stream AgentEvents as NDJSON (for host UIs)',
	passThrough: true,
	help: [
		'Usage: namzu run-stream <prompt...> [--session <id>] [--cwd <path>]',
		'',
		'Run a single prompt and stream one JSON event per line as the turn',
		'unfolds — text deltas, tool starts and ends, usage, then a terminal',
		'event. Built for a host UI that renders progress rather than waiting',
		'for a final string.',
		'',
		'Takes the same options as `namzu run`, including --permission-mode and',
		'the [permissions] table from the config file.',
		'',
		'History is bound with --session <id>. --continue and --resume are `run`',
		'options and are refused here rather than ignored.',
		'Without --session, optional stdin must be one complete JSON Message[];',
		'invalid or provider-incomplete tool history is refused before a run.',
		'',
		'The folder has to be trusted: run `namzu` here once and accept the',
		'prompt, or pass --trust for one run. An untrusted folder emits an error',
		'event and exits 77 without running anything.',
		'',
		'Needs a provider. Set a credential in the environment, or run namzu',
		'once to pick one interactively.',
		'',
		'Every failure is an event on stdout. The exit code says whether YOU can',
		'do anything about it: 0 when changing what you send would reach the run',
		'(a wrong option, no prompt, a bad --cwd) and when a run started and',
		'failed; 1 when it would not (no provider, a tool server that is not',
		'there, a conversation that cannot be opened); 77 when the folder has not',
		'been trusted, which only a person can change.',
	].join('\n'),
	handler: async ({ ctx: bootstrapCtx, rawArgs }) => {
		let ctx = bootstrapCtx
		const write = (o: unknown): void => {
			process.stdout.write(`${JSON.stringify(o)}\n`)
		}
		/**
		 * Report and stop.
		 *
		 * Always in band, always terminated with `done`, and the code says only
		 * whether the caller can reach the run by sending something else. The
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

		const flags = parseRunFlags(rawArgs)
		if (flags.unknown.length > 0) return fail(unknownOptionMessage(flags.unknown))
		// `--continue` and `--resume` parse here because the two commands share one
		// parser, and this command reads neither. Accepting a flag and doing
		// nothing with it is the failure mode the shared parser was introduced to
		// end: a host that asked to reopen a conversation was given a stateless
		// run, reported as an ordinary success, and the next turn had no history
		// with nothing anywhere connecting the two. Refused instead, and named,
		// because a host CAN fix this — `--session` is the flag it wanted.
		if (flags.continueLast || flags.resume !== null) {
			return fail(
				'run-stream does not take --continue or --resume; they are `namzu run` options. Bind history with --session <id>, which keys a persisted conversation in this folder.',
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
		// That rule is about a run that STARTED and failed, which a host should
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

		// Resolve the workspace's central Project for every run. A session key
		// additionally binds a durable conversation; without one, stdin history
		// remains stateless and no Session record is created.
		let cli: Awaited<ReturnType<typeof openSessions>>
		let conversationId: SessionId | null = null
		let prior: Message[] = []
		if (!sessionKey) {
			const parsed = parsePriorMessages(await readStdin())
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
				// or none, reported as an ordinary success. `run.ts` already
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
		// true }`: see `run.ts`'s identical comment.
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
		// this run, so the Namzu tab's picks win over ~/.namzu/preferences.json.
		prefs = applyProviderFlags(prefs, flags)

		// The operator's rules and mode reach this command too. They did not:
		// `[permissions]` was compiled for `run` and never for `run-stream`, so a
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
		// where the session store lives — a run told to work in another checkout
		// has to glob, read and edit files there.
		const gate = buildGate(flags, cwd)
		const session = await createAgentSession(prefs, probe.detected, {
			cwd,
			scope: {
				sessionId: conversationId ?? generateSessionId(),
				topicId: cli.topicId,
				projectId: cli.projectId,
				tenantId: cli.tenantId,
			},
			...(cli.backend === 'central' ? { stateRoot: cli.root } : {}),
			rules: permissions.rules,
			// The operator's --gate commands, as a standing condition on the
			// answer. Spread rather than passed as undefined so a run without
			// gates is byte-identical to the one that shipped before them.
			...(gate ?? {}),
			permissionMode: modeResult.mode,
			...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
			...(ctx.config.plugins ? { plugins: ctx.config.plugins } : {}),
			...(ctx.config.web ? { web: ctx.config.web } : {}),
			...(ctx.config.sandbox ? { sandbox: ctx.config.sandbox } : {}),
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
			// there is no argument the host can change to bring one up. `run`
			// already exits 1 here.
			return refuse(said)
		}

		// "Printed on every launch" has to reach a host UI too, or the one caller
		// with no human watching is the one that never hears it. Its own event
		// kind rather than an `error`: the run is proceeding, and a host that
		// treats this as a failure would be wrong.
		for (const notice of session.configNotices) {
			write({ kind: 'notice', message: notice })
		}

		// --skills <a,b,c>: load the named skills' bodies and inject them as the
		// turn's extra system context (the same channel the TUI's /skill uses).
		const extraSystem = await loadSkillsContext(cwd, flags.skills)

		const userMessage: Message = {
			role: 'user',
			content: finalPrompt,
			timestamp: Date.now(),
		} as Message
		const messages: Message[] = [...prior, userMessage]

		let assistantText = ''
		let conversationMessages: readonly Message[] | undefined
		try {
			for await (const event of session.send(messages, {
				...(extraSystem ? { extraSystem } : {}),
				onConversationMessages: (settled) => {
					conversationMessages = settled
				},
			})) {
				if (event.kind === 'delta') assistantText += event.text
				write(event)
			}
		} catch (err) {
			await session.close()
			return fail(err instanceof Error ? err.message : String(err))
		}
		// A stdio tool server is a child process; a command that returns without
		// closing leaves it running.
		await session.close()

		// Persist the turn so a later `history --session <key>` (and the next
		// turn's context) sees it. Best-effort — a store failure must not lose
		// the reply the user already saw stream.
		//
		// Best-effort is about not FAILING, not about staying quiet. This used to
		// swallow the error entirely, and it is the one failure here that makes a
		// LATER command wrong: the stream ends `done`, the process exits 0, and a
		// host has every reason to believe the turn is stored. Then
		// `history --session` comes back missing a turn the user watched arrive,
		// and the next turn's context silently lacks it — with nothing, anywhere,
		// connecting that to a write that failed minutes earlier.
		//
		// So it is said, on the same channel and in the same shape as the config
		// notices forty lines above, and for the reason written there: a host UI
		// is the caller with no human watching, and its own event kind rather
		// than an `error` because the run did succeed and a host treating this as
		// a failure would be wrong. The consequence is named, not just the fault,
		// because "could not persist" alone does not tell a host that its own
		// later reads are now incomplete.
		if (conversationId) {
			try {
				if (conversationMessages) {
					const publication = planTurnPublication(prior, userMessage, conversationMessages)
					if (publication.kind === 'replace') {
						await replaceConversation(cli, conversationId, publication.messages)
					} else {
						await appendMessages(cli, conversationId, publication.messages)
					}
				} else {
					const assistant: Message = {
						role: 'assistant',
						content: assistantText,
						timestamp: Date.now(),
					} as Message
					await appendMessages(cli, conversationId, [userMessage, assistant])
				}
			} catch (err) {
				write({
					kind: 'notice',
					message: `this turn was not saved: ${err instanceof Error ? err.message : String(err)}. The reply above is complete, but history for this session will not include it and the next turn will not have it as context.`,
				})
			}
		}

		write({ kind: 'done' })
		return 0
	},
}

export const historyCommand: CommandDef = {
	name: 'history',
	description: "Print a session's persisted messages as JSON (for host UIs)",
	passThrough: true,
	help: [
		'Usage: namzu history [--session <id>] [--cwd <path>]',
		'',
		"Print a session's persisted messages as JSON. With no session id the",
		'most recent session for the working directory is used.',
		'',
		'An empty array means the session exists and has no messages yet — it',
		'is not an error.',
	].join('\n'),
	handler: async ({ rawArgs }) => {
		const flags = parseRunFlags(rawArgs)
		const key = flags.session
		if (!key) {
			process.stdout.write('[]\n')
			return 0
		}
		try {
			// `--cwd` is in this command's help too, and picks the central Project
			// the session is read from. Reading the process's own directory
			// instead means a host asking about a session in another checkout is
			// told `[]` — indistinguishable from a session with no messages.
			const resolved = resolveWorkingDirectory(flags.cwd)
			if ('error' in resolved) {
				process.stdout.write('[]\n')
				return 0
			}
			const cli = await openSessions(resolved.cwd)
			const map = await import('../integrations/sessions/store.js')
			// Resolve WITHOUT creating: only emit history for an existing mapping.
			const existing = await findMappedConversation(cli, key)
			if (!existing) {
				process.stdout.write('[]\n')
				return 0
			}
			const messages = await loadConversation(cli, existing as never)
			const out = messages
				.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
				.map((m) => ({ role: m.role, content: m.content }))
			process.stdout.write(`${JSON.stringify(out)}\n`)
			void map
			return 0
		} catch {
			process.stdout.write('[]\n')
			return 0
		}
	},
}

// skills-json — read-only skill discovery for a host UI (the Namzu tab's skill
// chips). Prints the cwd-resolved skills as a JSON array of {name, description,
// source}. Distinct from the milestone-owned `skills` management command; this
// is the thin enumeration the desktop polls. Empty array on any failure.
export const skillsJSONCommand: CommandDef = {
	name: 'skills-json',
	description: 'Print discovered skills as JSON (for host UIs)',
	passThrough: true,
	help: [
		'Usage: namzu skills-json [--cwd <path>]',
		'',
		'Print the skills discovered for a working directory as JSON. Project',
		'skills come from that directory; user skills come from the home',
		'directory either way.',
		'',
		'An empty array means no skills were found — it is not an error.',
	].join('\n'),
	handler: async ({ rawArgs }) => {
		// Project skills live under the working directory, so a host listing the
		// skills for one checkout while the process sits in another was shown
		// the wrong project's chips — and then `run-stream --cwd <that
		// checkout> --skills <name>` could not find the skill it had just
		// offered. Same flag, same directory, both ends.
		const resolved = resolveWorkingDirectory(parseRunFlags(rawArgs).cwd)
		if ('error' in resolved) {
			process.stdout.write('[]\n')
			return 0
		}
		try {
			const { discoverSkills } = await import('../skills/store.js')
			const skills = discoverSkills({ cwd: resolved.cwd }).map((s) => ({
				name: s.name,
				description: s.description,
				source: s.source,
			}))
			process.stdout.write(`${JSON.stringify(skills)}\n`)
		} catch {
			process.stdout.write('[]\n')
		}
		return 0
	},
}

// providers-json — read-only provider+model discovery for a host UI (the Namzu
// tab's provider/model pickers). Emits every PROVIDER_REGISTRY entry with
// detection state + a best-effort live model list. Distinct from the `providers`
// profile-management command. Empty models[] → the host falls back to a
// free-text model field seeded with `default`. Never throws.
export const providersJSONCommand: CommandDef = {
	name: 'providers-json',
	description: 'Print providers + per-provider models as JSON (for host UIs)',
	passThrough: true,
	handler: async ({ ctx }) => {
		try {
			// Always NDJSON on stderr — same reasoning as run-stream's own sink
			// above; this command answers a host UI polling for a picker list,
			// not a person reading a terminal. installProcessSink/jsonLinesSink
			// are already statically imported at the top of this file, so the
			// dynamic import('@namzu/sdk') this replaced bought nothing — it
			// re-fetched a module already loaded for `Message`.
			const logging = contextLogging(ctx)
			installCliLogging(jsonLinesSink(process.stderr), logging.level)
			const { PROVIDER_REGISTRY, ALL_PROVIDER_IDS, findDetected } = await import(
				'../integrations/providers/index.js'
			)
			const { probeAgentSession, listProviderModels } = await import('../tui/agent.js')
			const probe = await probeAgentSession()
			const out: Array<{
				provider: string
				label: string
				detected: boolean
				default: string
				models: Array<{ id: string; name: string }>
			}> = []
			for (const id of ALL_PROVIDER_IDS) {
				const entry = PROVIDER_REGISTRY[id]
				const det = findDetected(probe.detected, id) ?? null
				const models = det ? await listProviderModels(id, det).catch(() => []) : []
				out.push({
					provider: id,
					label: entry.label,
					detected: Boolean(det),
					default: entry.defaultModel,
					models,
				})
			}
			// Detected providers first, so the picker defaults to a usable one.
			out.sort((a, b) => Number(b.detected) - Number(a.detected))
			process.stdout.write(`${JSON.stringify(out)}\n`)
		} catch {
			process.stdout.write('[]\n')
		}
		return 0
	},
}
