/**
 * `namzu run "<prompt>"` — headless one-shot. Runs a single prompt through
 * the same agent the TUI uses and prints the reply to stdout, for scripts
 * and CI. The prompt comes from
 * the arguments, or from stdin when piped. Status lines go to stderr (info,
 * suppressed by `--quiet`); only the answer hits stdout.
 *
 * Non-interactive, so there's no approval prompt — tools auto-run, but the
 * safety gate still hard-denies catastrophic commands. One-shots use an
 * ephemeral session and are not added to `/resume` history.
 *
 * Options are parsed, not spoken: this command joined every argument into the
 * prompt, so the flags its streaming sibling accepts — `--cwd` above all —
 * were read aloud to the model while the run used this directory anyway. Both
 * commands now share one parser (`./run-flags.js`), because they are the same
 * one-shot differing only in how they print.
 */

import { relative } from 'node:path'

import { BOOT_EVENT_NAMES, EVENT_NAME_ATTRIBUTE } from '@namzu/sdk'
import type { Message, StopReason } from '@namzu/sdk'

import { resolveTrustedProjectContext } from '../config/trusted-project-context.js'
import { EXIT_UNTRUSTED, EXIT_USAGE } from '../exit-codes.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { openSessions } from '../integrations/sessions/store.js'
import {
	type AttachedSessionExport,
	attachSessionExport,
} from '../integrations/telemetry/session-export.js'
import { cliLogger, contextLogging, createStderrSink, installCliLogging } from '../logging.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { resolvePermissionMode } from '../permissions/mode.js'
import { compilePermissions } from '../permissions/rules.js'
import { hostCommandNames } from '../tui/slashCommands.js'
import { expandHeadlessCommand } from '../user-commands/store.js'
import { resolveResume } from './resume.js'
import {
	applyProviderFlags,
	buildGate,
	loadSkillsContext,
	parseRunFlags,
	resolveWorkingDirectory,
	unknownOptionMessage,
} from './run-flags.js'
import type { CommandDef } from './types.js'

/**
 * How long to wait for the FIRST byte of piped input when the prompt was
 * already given as an argument.
 *
 * Once a byte arrives the read runs to end-of-input with no deadline, so a
 * slow or large producer is never truncated. The bound only covers the case
 * where nothing is coming at all.
 *
 * It exists because "is anything being piped in?" is not answerable without
 * reading: on Windows a real pipe, an inherited-but-idle pipe, and a test
 * runner's stdin are indistinguishable to `fstat` — all three report neither
 * FIFO nor file. Measured. So a command that unconditionally waited for
 * end-of-input would hang forever whenever stdin was open and silent, which is
 * the ordinary state of a CI step or a test process. Waiting a quarter second
 * is invisible to a person and instant for a pipe that has data ready.
 */
const FIRST_BYTE_DEADLINE_MS = 250

async function readStdin(opts: { readonly deadline?: boolean } = {}): Promise<string> {
	// Capture once. Tests and embedded hosts can replace the process getter;
	// registration, observation and cleanup must still concern one stream.
	const input = process.stdin
	if (input.isTTY) return ''
	const chunks: Buffer[] = []
	const collect = async (): Promise<void> => {
		for await (const chunk of input) chunks.push(chunk as Buffer)
	}
	if (!opts.deadline) {
		await collect()
		return Buffer.concat(chunks).toString('utf8')
	}
	let timer: NodeJS.Timeout | undefined
	let settleFirstByte: (() => void) | undefined
	const firstByte = new Promise<void>((resolve) => {
		settleFirstByte = resolve
		timer = setTimeout(settleFirstByte, FIRST_BYTE_DEADLINE_MS)
		input.once('readable', settleFirstByte)
		input.once('end', settleFirstByte)
	})
	try {
		await firstByte
	} finally {
		if (timer) clearTimeout(timer)
		if (settleFirstByte) {
			input.removeListener('readable', settleFirstByte)
			input.removeListener('end', settleFirstByte)
		}
	}
	if (input.readableEnded || input.readableLength > 0) await collect()
	return Buffer.concat(chunks).toString('utf8')
}

/**
 * The prompt, from the arguments and the pipe together.
 *
 * Piped input used to be read only when there was no argument prompt, so
 *
 *     cat notes.txt | namzu run "summarise this"
 *
 * sent the model three words and silently dropped the file. Nothing reported
 * it: the run succeeded, and the answer was about nothing. A pipe and a
 * question are the ordinary way to ask about a document, and taking only one
 * of the two is the worst reading of that command.
 *
 * The piped text is fenced in a tag so the model can tell the instruction from
 * the material it is about — without a boundary, a long paste runs into the
 * question and the last line of a file reads as part of the request.
 *
 * Pure so it can be tested without a pipe; the reading happens in the handler.
 */
export function composePrompt(fromArgs: string, piped: string): string {
	const question = fromArgs.trim()
	const material = piped.trim()
	if (!question) return material
	if (!material) return question
	return `${question}\n\n<stdin>\n${material}\n</stdin>`
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

export const runCommand: CommandDef = {
	name: 'run',
	description: 'Run a single prompt headlessly and print the reply (for scripts/CI)',
	passThrough: true,
	help: [
		'Usage: namzu run [options] <prompt...>',
		'       echo "<prompt>" | namzu run',
		'       cat file.txt | namzu run "summarise this"',
		'',
		'Run a single prompt headlessly and print the reply. Everything that is',
		'not an option is the prompt.',
		'',
		'Piped input is used too, not discarded: with no prompt argument it IS',
		'the prompt, and alongside one it is appended as material the question',
		'is about. `namzu run -` reads the prompt from stdin explicitly.',
		'',
		'Options (the same ones run-stream takes):',
		'  --cwd <path>          Directory the agent works in (default: this one)',
		'  --provider <id>       Provider to answer with',
		'  --model <id>          Model to answer with',
		'  --skills <a,b,c>      Load these skills as context for the turn',
		'  --continue, -c        Resume the most recent conversation here',
		'  --resume <id>         Resume that conversation, and no other',
		'  --gate <command>      Must pass before the run may finish; repeatable',
		'  --gate-retries <n>    Fix attempts a failing gate allows (default 3)',
		'  --permission-mode <m> prompt | auto | strict — what happens to a call',
		'                        no [permissions] rule decided (default: auto)',
		'  --trust               Accept this folder for THIS run',
		'  --                    End of options; the rest is the prompt verbatim',
		'',
		'A folder has to be trusted before namzu will work in it, because namzu',
		'reads its files, runs commands in it and executes its code. Run `namzu`',
		'here once and accept the prompt to trust it permanently, or pass --trust',
		'to accept it for one run. --trust does not remember; that is the point.',
		'',
		'--yolo does NOT imply --trust: one is about which tools may run inside a',
		'folder, the other about the folder.',
		'',
		'By default tools run without asking, because there is nobody to ask, and',
		'the safety gate still refuses catastrophic commands. Use --permission-mode',
		'strict for an unattended run that must refuse anything no rule allowed.',
		'',
		'A mode only decides calls no rule decided: it can never reopen a deny.',
		'',
		'--gate is the unattended-operator flag: the run is not allowed to settle',
		'until every gate command exits 0. A failure comes back to the model as the',
		'next turn, naming the command, the exit code and the output. Repeat the',
		'flag for several, and they run in order, stopping at the first failure.',
		'',
		'A gate is not re-run when the answer changed nothing on disk: the model is',
		'told the workspace is unchanged instead, which is cheaper and a different',
		'instruction from repeating a failure it has already been shown. The',
		'attempt still counts. When the attempts run out the run stops with',
		'answer_rejected and a non-zero exit — never with a green run over a red',
		'build.',
		'',
		"The working directory's AGENTS.md files — that directory and every one up",
		'to the repository root — are loaded as standing instructions for the run,',
		'and the ones that were loaded are named on stderr.',
		'',
		'--continue and --resume refuse when the conversation cannot be reopened,',
		'and say why. Neither ever falls back to starting a new one: run with no',
		'flag if that is what you want.',
		'',
		'Needs a provider. Set a credential in the environment, or run namzu',
		'once to pick one interactively.',
		'',
		'Exit codes: 0 on a reply, 1 on a failed or unfinished run, 2 when no',
		'prompt was supplied, 64 when an argument is wrong, 77 when the folder',
		'has not been trusted and nothing ran.',
	].join('\n'),
	handler: async ({ ctx: bootstrapCtx, rawArgs }) => {
		let ctx = bootstrapCtx
		const flags = parseRunFlags(rawArgs)
		if (flags.unknown.length > 0) {
			// A shell caller learns about a bad argument from `$?`, so this is 64
			// rather than the in-band error event the streaming sibling emits.
			ctx.formatter.error({ message: unknownOptionMessage(flags.unknown) })
			return EXIT_USAGE
		}
		// `-` on its own means "the prompt is on stdin", the usual spelling for
		// it. Before, it was sent to the model as a one-character question.
		const fromArgs = flags.rest.join(' ').trim() === '-' ? '' : flags.rest.join(' ').trim()
		// With no prompt argument, piped input IS the prompt and is waited for
		// as long as it takes — that is the existing contract for `echo … |
		// namzu run` and for the `-` sentinel. Alongside a prompt it is extra
		// material, so it gets the first-byte deadline instead: a caller who
		// asked a complete question should never be left waiting on a pipe
		// they did not mean to open.
		const piped = await readStdin({ deadline: Boolean(fromArgs) })
		const prompt = composePrompt(fromArgs, piped)
		if (!prompt) {
			ctx.formatter.error({
				message: 'no prompt — pass it as an argument or pipe it via stdin',
			})
			return 2
		}
		const resolved = resolveWorkingDirectory(flags.cwd)
		if ('error' in resolved) {
			ctx.formatter.error({ message: resolved.error })
			return EXIT_USAGE
		}

		// Before anything is read, run or constructed in that directory. The
		// order is the gate: a check that happens after the session is built has
		// already opened stores and walked the tree it was meant to protect.
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

		// Project commands are code-like launch authority: discover and expand
		// them only after the target folder has crossed the same trust boundary
		// as its config and instructions.
		const expansion = expandHeadlessCommand(prompt, {
			cwd,
			builtins: hostCommandNames(),
		})
		if (expansion.kind === 'refused') {
			ctx.formatter.error({ message: expansion.reason })
			return EXIT_USAGE
		}
		const finalPrompt = expansion.kind === 'expanded' ? expansion.prompt : prompt

		// The CLI owns stderr, not the kernel it drives (LOG-05) — a live sink
		// at the level --verbose/--quiet/NAMZU_LOG_LEVEL named, instead of
		// forcing the level to `silent` via `configureLogger`, which threw
		// every diagnostic away regardless of what anyone asked for.
		// `{ replace: true }`: a real invocation calls this once, but this
		// package's own test suite calls a command's handler more than once
		// per process, which a refusing second install would break for
		// reasons that have nothing to do with what those tests are about.
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

		// A permission the operator wrote and which was silently dropped is the
		// worst outcome available here: they believe a control is in force and it
		// is not. So a bad line is reported and the rest still load.
		const modeResult = resolvePermissionMode({
			flag: flags.permissionMode,
			skipPermissions: flags.skipPermissions,
			// A headless run has nobody to ask, so `prompt` here would silently
			// become `auto`. Resolving it as `auto` says so instead.
			interactive: false,
		})
		if ('error' in modeResult) {
			ctx.formatter.error({ message: modeResult.error })
			return EXIT_USAGE
		}

		const permissions = compilePermissions(ctx.config.permissions, ctx.config.permissionChecks)
		for (const d of permissions.diagnostics) {
			const where = d.pattern ? `permissions.${d.tool}."${d.pattern}"` : `permissions.${d.tool}`
			ctx.formatter.error({ message: `${where}: ${d.message}` })
		}

		const gate = buildGate(flags, cwd)
		// Attached BEFORE the session, and its failure is fatal. An operator who
		// configured `telemetry.sessionExport` asked for this run to be
		// recorded; continuing without it means the run happens and the record
		// they were counting on does not exist, which is a failure they only
		// discover when they go looking for a session that was never written.
		let sessionExport: AttachedSessionExport | undefined
		if (ctx.config.telemetry?.sessionExport) {
			try {
				sessionExport = await attachSessionExport({
					config: ctx.config.telemetry.sessionExport,
				})
				// Under the same event name the boot narrative used for the
				// boolean. This is the half that names the destination and the
				// redactors, and it is emitted HERE because it describes what
				// actually resolved rather than what was configured.
				cliLogger().info(sessionExport.disclosure, {
					[EVENT_NAME_ATTRIBUTE]: BOOT_EVENT_NAMES.TELEMETRY_STATUS,
					'namzu.telemetry.session_export': true,
				})
			} catch (err) {
				ctx.formatter.error({
					message: err instanceof Error ? err.message : String(err),
				})
				return 1
			}
		}
		const session = await createAgentSession(prefs, probe.detected, {
			cwd,
			rules: permissions.rules,
			...(sessionExport ? { onRunEvent: sessionExport.listener } : {}),
			// The operator's --gate commands, as a standing condition on the
			// answer. Spread rather than passed as undefined so a run without
			// gates is byte-identical to the one that shipped before them.
			...(gate ?? {}),
			permissionMode: modeResult.mode,
			...(ctx.config.mcpServers ? { mcpServers: ctx.config.mcpServers } : {}),
			...(ctx.config.plugins ? { plugins: ctx.config.plugins } : {}),
			...(ctx.config.sandbox ? { sandbox: ctx.config.sandbox } : {}),
		})
		if (!session.hasProvider) {
			await session.close()
			await sessionExport?.shutdown()
			ctx.formatter.error({
				message: session.errorHint ?? 'agent is not ready',
			})
			return 1
		}
		// A configured tool server that is not here means the run cannot do what
		// the operator set it up to do, and there is nobody watching to notice.
		// The TUI reports and carries on, because a person can read the line and
		// decide; a script has no such reader, so it refuses. Same principle as
		// the permission mode resolving differently when `interactive` is false.
		if (session.mcpFailed.length > 0) {
			for (const f of session.mcpFailed) {
				ctx.formatter.error({
					message: `tool server "${f.name}" is not available: ${f.reason}`,
				})
			}
			await session.close()
			await sessionExport?.shutdown()
			return 1
		}
		// "Printed on every launch" has to mean every launch, not every launch of
		// the TUI. A scripted run under an accepted capability limitation is
		// exactly the case where nobody is watching, so the line has to be in the
		// output the script keeps.
		for (const notice of session.configNotices) {
			ctx.formatter.info(notice)
		}
		for (const s of session.mcpConnected) {
			ctx.formatter.info(`tool server ${s.name} · ${s.toolCount} tools`)
		}
		ctx.formatter.info(
			`namzu · ${session.providerSummary}${session.modelSummary ? ` · ${session.modelSummary}` : ''}`,
		)
		// stderr like every other status line, so a caller piping the answer is
		// unaffected and a person watching can still tell which instructions the
		// run is bound by. A script that reads AGENTS.md aloud is not a script
		// whose output changed.
		if (session.instructionFiles.length > 0) {
			ctx.formatter.info(
				`project instructions: ${session.instructionFiles
					.map((p) => relative(cwd, p) || p)
					.join(', ')}`,
			)
		}
		// A refusal that says nothing is indistinguishable from a project that
		// declared nothing, and the two want opposite responses from the reader.
		for (const skip of session.skippedInstructionFiles) {
			ctx.formatter.error({
				message: `skipped ${relative(cwd, skip.path) || skip.path}: ${skip.reason}`,
			})
		}

		const extraSystem = await loadSkillsContext(cwd, flags.skills)

		// A conversation the TUI could reopen could not be reopened from a
		// script: the store, the reader and the picker all existed and only the
		// entry point was missing.
		let sessions: Awaited<ReturnType<typeof openSessions>> | null = null
		if (flags.continueLast || flags.resume) {
			try {
				sessions = await openSessions(cwd)
			} catch {
				sessions = null // reported by resolveResume, which knows what was asked for
			}
		}
		const resume = await resolveResume(
			sessions,
			{ continueLast: flags.continueLast, sessionId: flags.resume },
			cwd,
		)
		if (resume.kind === 'error') {
			// Refused, never silently started fresh. Someone who asked for a
			// specific conversation and got a new one that looks the same finds
			// out several turns later, having already acted on it.
			ctx.formatter.error({ message: resume.message })
			await session.close()
			await sessionExport?.shutdown()
			return EXIT_USAGE
		}
		const prior: readonly Message[] = resume.kind === 'resumed' ? resume.messages : []
		if (resume.kind === 'resumed') {
			ctx.formatter.info(`resuming ${resume.sessionId} · ${prior.length} messages`)
		}

		let text = ''
		let failed: string | null = null
		let stopReason: StopReason | undefined
		for await (const event of session.send(
			[...prior, { role: 'user', content: finalPrompt, timestamp: Date.now() }],
			extraSystem ? { extraSystem } : undefined,
		)) {
			if (event.kind === 'delta') text += event.text
			else if (event.kind === 'tool-start')
				ctx.formatter.info(`⏺ ${event.toolName} ${event.summary}`)
			// stderr, like every other status line, so it reaches a person
			// watching without contaminating the answer a caller piped.
			else if (event.kind === 'context') ctx.formatter.info(event.text)
			else if (event.kind === 'error') failed = event.message
			else if (event.kind === 'done') stopReason = event.stopReason
		}

		// Every exit below this point releases the session first. A stdio tool
		// server is a child process, and a `run` that returns without closing
		// leaves it behind.
		await session.close()
		// Drained with the session, not at process exit: a buffering sink that
		// only flushed on `beforeExit` loses its tail whenever the CLI is
		// interrupted, which is exactly the run somebody wanted the record of.
		await sessionExport?.shutdown()

		if (failed) {
			ctx.formatter.error({ message: failed })
			return 1
		}

		// The text prints either way. Partial output is real output, and a
		// caller who piped it wants what there is — but `$?` has to be able to
		// tell them it is partial, which it could not: `run_failed` is emitted
		// only from the throw path, so a run stopped by its token budget, its
		// timeout, its iteration cap, a cancellation, or a blocking output
		// guardrail all arrived as `run_completed` and exited 0. Measured: a
		// `max_iterations` stop reports `status: 'completed'`. The sharp case is
		// the guardrail — a REFUSED answer exited 0 with empty text, so
		// `namzu run … > out.txt && deploy` proceeded on the empty file.
		ctx.formatter.print(ctx.formatter.name === 'json' ? { text: text.trim() } : text.trim())
		if (stopReason && stopReason !== 'end_turn') {
			ctx.formatter.error({
				message: `run did not finish normally: ${stopReason}${text.trim() ? ' — the output above is partial' : ''}`,
			})
			return 1
		}
		return 0
	},
}
