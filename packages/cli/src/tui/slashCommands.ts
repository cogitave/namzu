/**
 * Slash command registry + parser. Pure logic — no React. Unit-tested.
 *
 * A command's `action` returns a `SlashAction` — see the union below, which has
 * grown well past the "message, exit, or nothing" this line used to claim. The
 * caller (App) maps every kind onto state, and its switch is exhaustive: a kind
 * added here and not handled there falls out of the switch into the send path
 * and dispatches the operator's `/command` to the model as prose.
 *
 * `/cost`, `/permissions` and `/agents` are RENDERERS. Every number and rule
 * they print was already computed — the kernel emits usage on its own event,
 * the permission rules were compiled before the session opened, and the
 * delegate roster is decided when the subagent runtime is built. None of them
 * asks the model, recomputes anything, or reaches past what the session
 * already carries. A command that had to compute its own answer would be a
 * second source for a fact the kernel already owns, and the two would drift.
 *
 * `/expand` is the same discipline with the split drawn one step earlier. The
 * lines it prints were captured when the tool ran and are held on the transcript
 * row, which this module cannot see and must not: it validates the argument and
 * hands App a `which`, and App — the only thing that knows what rows exist —
 * resolves it. Giving this module the transcript to search would put the answer
 * to "does block 4 exist" in two places at once.
 */

import {
	type AuthorizationRule,
	type CostInfo,
	type HostCommandOutcome,
	type SerializableHostCommand,
	kernelHostCommands,
} from '@namzu/sdk'

import type { SandboxSummary } from '../context/sandbox.js'
import { type UserCommand, expandCommand } from '../user-commands/store.js'
import { isCompletionArgument } from './login-prompt.js'

export type SlashAction =
	| { kind: 'message'; role: 'system'; content: string }
	| { kind: 'exit' }
	| { kind: 'clear' }
	| { kind: 'repick' }
	| { kind: 'remember'; text: string }
	| { kind: 'show-memory' }
	| { kind: 'list-skills' }
	| { kind: 'load-skill'; name: string }
	| { kind: 'resume' }
	/**
	 * Name this conversation, show its name, or take the name away.
	 *
	 * Its own kind rather than a message, because the write touches the
	 * session store and this union is pure. An empty `title` means "show me";
	 * an explicit clear is the literal word, so a person cannot erase a name
	 * by pressing enter on a half-typed command.
	 */
	| { kind: 'title'; title: string; clear: boolean }
	/**
	 * Continue in a copy, leaving this conversation where it is.
	 *
	 * Async like its neighbours: the copy reads the persisted transcript and
	 * writes it into a new session before anything on screen changes.
	 */
	| { kind: 'fork' }
	/**
	 * Shrink the conversation now, rather than when a threshold decides.
	 *
	 * Its own kind, and asynchronous where this union is not, for the reason
	 * `host-command` gives one line down: the work is a model call, and making
	 * the action itself async would push that through every command. The
	 * command decides; `App` performs and reports.
	 */
	| { kind: 'compact' }
	/** Ask the terminal to copy the latest available assistant output. */
	| { kind: 'copy' }
	/**
	 * Show what is uncommitted in the working tree.
	 *
	 * Async for the same reason `compact` is: it shells out to git, and this
	 * union is synchronous by design.
	 */
	| { kind: 'diff' }
	/**
	 * Read the working tree and report on it as a turn.
	 *
	 * Async like its neighbours — the file list comes from git — and it ends in
	 * a PROMPT rather than a message, so the answer arrives the way every other
	 * answer does and lands in the transcript that gets saved.
	 */
	| { kind: 'review' }
	/**
	 * A command the KERNEL registered, to be dispatched and rendered.
	 *
	 * Its own action kind because the registry's handlers are async — a
	 * `/tasks` readout reads a store — and this union is synchronous. Making
	 * the action itself async would push that everywhere; naming the
	 * dispatch as a result keeps the boundary where it is.
	 */
	| { kind: 'host-command'; name: string; args: readonly string[] }
	/**
	 * Record a judgment on the run's last assistant message.
	 *
	 * Carries the id rather than leaving App to re-derive it: the command
	 * has already decided there IS one, and re-deriving would open a window
	 * where the answer moved between the check and the write.
	 */
	| { kind: 'feedback'; rating: 'good' | 'bad'; messageId: string; note?: string }
	/**
	 * Print a collapsed tool body in full, as a NEW transcript row.
	 *
	 * `which` is the number the collapse hint printed, or `'last'` for the most
	 * recent one. This module validates the shape of the argument and stops
	 * there: whether such a block exists is a fact about the transcript, which
	 * App owns and this module deliberately does not see.
	 */
	| { kind: 'expand'; which: number | 'last' }
	/**
	 * Drive a turn with text the command composed rather than the user typed.
	 *
	 * The kernel already does the work — reading the tree, writing the file —
	 * so a command that needs the agent asks it, instead of the CLI growing a
	 * second way to inspect a repository that would then disagree with the one
	 * the model uses.
	 */
	| { kind: 'prompt'; text: string }
	/**
	 * Sign in to a subscription without leaving namzu.
	 *
	 * Bare `/login` STARTS an attempt; `/login <address-or-code>` FINISHES the
	 * one in flight. Two verbs on one command because they are one act from
	 * where the operator sits, and because the second is the whole point on a
	 * machine whose browser is somewhere else — a container, a remote shell.
	 * The distinction is `pasted`, and this module decides it (see
	 * `isCompletionArgument`) so App never has to parse an argument.
	 */
	| { kind: 'login'; pasted?: string }
	| { kind: 'logout' }
	| { kind: 'none' }

export interface SlashContext {
	/**
	 * Every tool the agent can call, read when the command runs.
	 *
	 * A function, and it is the same function `neverPrompted` below already is,
	 * for the same reason — see the note there. It was an array, captured when
	 * the session was built, which is before the task tools register. So the
	 * command whose entire job is "what can this thing call" answered from a
	 * snapshot taken too early, while `/permissions` two commands down read the
	 * registry live. On the same screen, `/permissions` could name a tool as
	 * never-prompted that `/tools` did not list at all.
	 */
	readonly availableTools: () => readonly string[]
	/**
	 * Where writes may land, for the one command that shows it beside the
	 * approval settings.
	 *
	 * `null` before a session exists. These two facts were reachable only from
	 * two different places at two different times — the sandbox as a boot
	 * notice that scrolls away, the approvals from `/permissions` — and an
	 * operator who read one had no reason to think the other mattered.
	 */
	readonly sandbox: SandboxSummary | null
	/**
	 * Tool servers, as they stood when this session connected.
	 *
	 * `null` before a session exists. Reported at connect time as transcript
	 * rows that scroll away, and nowhere else — so an operator ten minutes into
	 * a session had no way to ask which servers answered and which did not.
	 */
	readonly mcp: {
		readonly connected: readonly { readonly name: string; readonly tools: readonly string[] }[]
		readonly failed: readonly { readonly name: string; readonly reason: string }[]
	} | null
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	/**
	 * CUMULATIVE run spend, or `null` before the first turn reports any.
	 *
	 * The same numbers the status bar abbreviates. Kept as the kernel's own
	 * quantity rather than a formatted string so `/cost` can print exact
	 * figures — an abbreviation is right for a bar that must fit and wrong for
	 * a question someone asked on purpose.
	 */
	readonly usage: { readonly totalTokens: number; readonly cost: CostInfo } | null
	/** What decides a tool call right now — flags, config, and session state. */
	readonly permissions: {
		/** `--yolo` / `--dangerously-skip-permissions`. */
		readonly skipPermissions: boolean
		readonly rules: readonly AuthorizationRule[]
		/**
		 * Whether "approve all" is in force, read at render time.
		 *
		 * A function because this is the one field here that CHANGES while
		 * namzu runs. The other two come from flags and a config file and are
		 * fixed for the process; this one flips on a keystroke mid-turn. Since
		 * this context object is assembled during a render and read later from
		 * a callback that captured it, a boolean would report whatever was true
		 * when the object was built — which is precisely the staleness that let
		 * `/permissions` claim tools were still being reviewed after they were
		 * not.
		 */
		readonly approvalLatched: () => boolean
		/**
		 * Tools that never reach the prompt, named so the readout can say so.
		 *
		 * Supplied by the caller rather than imported here, because this module
		 * is deliberately free of the agent runtime. A function because the
		 * roster is not final when a session is built — task tools register
		 * deferred inside the first turn, and tool servers connect during
		 * startup — so a captured array can describe a set the operator never
		 * had.
		 */
		readonly neverPrompted: () => readonly string[]
	}
	/**
	 * Absolute paths of the project-instruction files already in this session's
	 * system prompt.
	 *
	 * `/init` reads it to tell "this project has never been described" from
	 * "one exists and you are about to be asked to rewrite it", which are
	 * different requests and want different prompts. The session already
	 * reports this; nothing new is discovered to answer it.
	 */
	readonly instructionFiles: readonly string[]
	/**
	 * Commands the operator defined as `.md` files.
	 *
	 * Consulted only after the builtins, so a file cannot take a name the TUI
	 * already answers to. Empty is the normal case.
	 */
	readonly userCommands: readonly UserCommand[]

	/**
	 * Everything this session answers to, for `/help` to list.
	 *
	 * Absent falls back to the CLI's own, which is right for a caller with
	 * no registry and wrong to assume anywhere else.
	 */
	readonly builtins?: readonly SlashCommand[]
	/**
	 * The last assistant message this run produced, or `null` before there
	 * is one.
	 *
	 * A function, like every other field here that moves while namzu runs —
	 * this context is assembled during a render and read later from a
	 * callback that captured it, so a captured string would name whatever
	 * was last when the object was built. For `/feedback` that is not a
	 * stale readout, it is a rating attached to the wrong answer.
	 */
	readonly lastAssistantMessageId: () => string | null
}

export interface SlashCommand {
	readonly name: string
	readonly description: string
	readonly action: (ctx: SlashContext, args: readonly string[]) => SlashAction
}

export interface ParsedSlash {
	readonly name: string
	readonly args: readonly string[]
}

/**
 * Autocomplete matches for a composer value that is a command-in-progress
 * (`/`, `/me`, `/mo…` — slash + a partial name, no space yet). Returns []
 * once a space is typed (the user has moved on to arguments) or the value
 * isn't a slash command, so the dropdown only shows while picking a name.
 */
export function matchSlashCommands(
	value: string,
	userCommands: readonly UserCommand[] = [],
	/**
	 * What this session actually offers.
	 *
	 * Passed rather than read from a module constant, because the kernel's
	 * registry decides part of it at runtime — a command a capability adds
	 * has to reach the dropdown without an edit here, which is the whole
	 * point. Defaults to the CLI's own for callers with no registry.
	 */
	builtins: readonly SlashCommand[] = CLI_LOCAL_COMMANDS,
): SlashCommand[] {
	const m = /^\/([\w-]*)$/.exec(value)
	if (!m) return []
	const prefix = (m[1] ?? '').toLowerCase()

	// A command the dropdown does not offer is one nobody discovers. Refused
	// ones are offered too, carrying their reason as the description — running
	// it prints the problem, which is how its author finds out.
	const own: SlashCommand[] = userCommands.map((c) => ({
		name: c.name,
		description: c.problem ? `⚠ ${c.problem}` : c.description,
		action: () => ({ kind: 'none' }) as const,
	}))

	return [...builtins, ...own].filter((c) => c.name.startsWith(prefix))
}

/** A registry command whose name a CLI-local one already answers to. */
export class CommandNameCollisionError extends Error {
	constructor(name: string) {
		super(
			`/${name} is registered by the kernel AND by this host. One of them would silently never run, and which depends on merge order — rename one.`,
		)
		this.name = 'CommandNameCollisionError'
	}
}

/**
 * The CLI's own commands plus whatever the kernel's registry reports.
 *
 * This file used to BE the vocabulary: a hardcoded array, with two headless
 * commands importing it for a name list, so nothing a capability added could
 * reach the operator without editing here.
 *
 * A collision THROWS rather than letting local win quietly. One of the two
 * would never run, which one depends on merge order, and neither the kernel
 * nor the host author would ever see it — the same reasoning the registry
 * itself uses for its own duplicate names.
 */
/**
 * Names this host implements itself, and knowingly does not take from the
 * kernel.
 *
 * `/skills` is the case that made this list necessary. The kernel's version
 * lists what a registry holds; this host's DISCOVERS skills from disk, marks
 * which are active, and shows a refused one with its reason rather than
 * hiding it. Both are correct for their audience, and a host with no skills
 * UI should get the kernel's — so the kernel keeps offering it and this one
 * declines, in writing.
 *
 * Deliberately not a general precedence rule. First-wins or last-wins would
 * make an ACCIDENTAL collision silent, which is what
 * {@link CommandNameCollisionError} exists to prevent; naming each one here
 * keeps the refusal for every collision nobody decided about.
 */
export const HOST_OWNED_COMMAND_NAMES: readonly string[] = ['skills']

export function mergeHostCommands(
	descriptors: readonly SerializableHostCommand[],
	locals: readonly SlashCommand[] = CLI_LOCAL_COMMANDS,
): readonly SlashCommand[] {
	const localNames = new Set(locals.map((c) => c.name))
	const owned = new Set(HOST_OWNED_COMMAND_NAMES)
	const fromKernel = descriptors.filter((descriptor) => !owned.has(descriptor.name))
	for (const descriptor of fromKernel) {
		if (localNames.has(descriptor.name)) throw new CommandNameCollisionError(descriptor.name)
	}

	return [
		...locals,
		...fromKernel.map(
			(descriptor): SlashCommand => ({
				name: descriptor.name,
				description: descriptor.description,
				action: (_ctx, args) => ({ kind: 'host-command', name: descriptor.name, args }),
			}),
		),
	]
}

/**
 * A kernel outcome, drawn the way this surface draws things.
 *
 * The SDK returns fields and formats nothing, which is the whole reason a
 * TUI and a JSON command can both consume it. This is the TUI's half.
 */
export function renderOutcome(outcome: HostCommandOutcome): string {
	switch (outcome.kind) {
		case 'ack':
			return outcome.message
		case 'prompt':
			return outcome.text
		case 'refused':
			return outcome.reason
		case 'report': {
			if (outcome.rows.length === 0) return `${outcome.title}: none.`
			const columns = [...new Set(outcome.rows.flatMap((r) => Object.keys(r)))]
			return [
				`${outcome.title} (${outcome.rows.length}):`,
				...outcome.rows.map(
					(row) =>
						`  ${columns
							.map((c) => (row[c] === null || row[c] === undefined ? '-' : String(row[c])))
							.join('  ')}`,
				),
			].join('\n')
		}
	}
}

/**
 * Every name this build answers to, kernel commands included.
 *
 * The headless commands used to map the raw array, so a registry command
 * was invisible to them — and a name they do not know is sent to the MODEL
 * as prose, silently, which is both a wrong answer and a tool call nobody
 * asked for.
 */
export function hostCommandNames(
	descriptors: readonly SerializableHostCommand[] = kernelCommandDescriptors(),
	locals: readonly SlashCommand[] = CLI_LOCAL_COMMANDS,
): string[] {
	return mergeHostCommands(descriptors, locals).map((c) => c.name)
}

/**
 * The kernel's own commands, as descriptors.
 *
 * Built with empty options because only the NAMES are wanted here — a
 * headless path deciding whether `/tasks` is a command it knows does not
 * need a task store to answer that.
 */
export function kernelCommandDescriptors(): readonly SerializableHostCommand[] {
	return kernelHostCommands({}).map(({ handler: _handler, ...rest }) => rest)
}

/** Returns null when the line is not a slash command. */
export function parseSlash(line: string): ParsedSlash | null {
	const trimmed = line.trim()
	if (!trimmed.startsWith('/')) return null
	const [name, ...args] = trimmed.slice(1).split(/\s+/)
	if (!name) return null
	return { name, args }
}

/**
 * The commands that are genuinely this host's.
 *
 * A transcript, a picker, a login, an expand — every one is about something
 * the TUI owns and the kernel has no view of. What is NOT here is anything
 * the kernel can answer, which now arrives through the registry instead of
 * being restated in this file.
 */
export const CLI_LOCAL_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'help',
		description: 'Show available slash commands.',
		action: (ctx) => {
			// Reads what this session OFFERS, not a module constant. A command
			// the kernel registered and `/help` did not list is a command
			// nobody discovers.
			const builtin = (ctx.builtins ?? CLI_LOCAL_COMMANDS).map(
				(c) => `/${c.name.padEnd(12)} ${c.description}`,
			)
			// Listed separately and always, including the refused ones with their
			// reason. A command file that exists and does not work is exactly what
			// its author needs to see here — leaving it out of `/help` is how it
			// stays broken.
			const own = ctx.userCommands.map((c) =>
				c.problem
					? `/${c.name.padEnd(12)} ⚠ ${c.problem}`
					: `/${c.name.padEnd(12)} ${c.description}`,
			)
			return {
				kind: 'message',
				role: 'system',
				content:
					own.length > 0
						? `${builtin.join('\n')}\n\nYour commands:\n${own.join('\n')}`
						: builtin.join('\n'),
			}
		},
	},
	{
		name: 'feedback',
		description: 'Rate the last answer: /feedback good|bad [note].',
		action: (ctx, args) => {
			const [rating, ...rest] = args
			if (rating !== 'good' && rating !== 'bad') {
				return {
					kind: 'message',
					role: 'system',
					content: 'Usage: /feedback good|bad [note]',
				}
			}

			// Refused rather than recorded against something invented. A
			// feedback row is read later to answer "which answers were bad";
			// one pointing at a message that does not exist cannot be traced
			// back to what was said, and is indistinguishable from a real one.
			const messageId = ctx.lastAssistantMessageId()
			if (!messageId) {
				return {
					kind: 'message',
					role: 'system',
					content: 'Nothing to rate yet — /feedback applies to the last answer in this run.',
				}
			}

			const note = rest.join(' ').trim()
			return { kind: 'feedback', rating, messageId, ...(note ? { note } : {}) }
		},
	},
	{
		name: 'clear',
		description: 'Clear the transcript.',
		action: () => ({ kind: 'clear' }),
	},
	{
		name: 'quit',
		description: 'Exit namzu.',
		action: () => ({ kind: 'exit' }),
	},
	{
		name: 'exit',
		description: 'Alias of /quit.',
		action: () => ({ kind: 'exit' }),
	},
	{
		name: 'tools',
		description: 'List tools the agent can call.',
		action: (ctx) => {
			// Asked now, not when the session was built. Some of these register
			// during the first turn, so a list captured earlier is a list of what
			// was callable then — and this command is asked in the present tense.
			const tools = ctx.availableTools()
			return {
				kind: 'message',
				role: 'system',
				content:
					tools.length === 0
						? 'No tools registered yet — the agent session may still be connecting.'
						: `Registered tools (${tools.length}):\n  ${tools.join('\n  ')}`,
			}
		},
	},
	{
		name: 'remember',
		description: 'Save a fact to durable memory: /remember <text>.',
		action: (_ctx, args) => {
			const text = args.join(' ').trim()
			return text.length === 0
				? { kind: 'message', role: 'system', content: 'Usage: /remember <something to remember>' }
				: { kind: 'remember', text }
		},
	},
	{
		name: 'title',
		description: 'Name this conversation so /resume is navigable: /title <name>, or /title clear.',
		action: (_ctx, args) => {
			const text = args.join(' ').trim()
			// `clear` is a word, not an empty argument. Bare `/title` is the
			// question — the reading a person expects, and the one that cannot
			// destroy anything by being typed early.
			if (text.toLowerCase() === 'clear') return { kind: 'title', title: '', clear: true }
			return { kind: 'title', title: text, clear: false }
		},
	},
	{
		name: 'fork',
		description: 'Continue in a copy of this conversation, leaving the original where it is.',
		action: () => ({ kind: 'fork' }),
	},
	{
		name: 'memory',
		description: 'Show what namzu remembers (USER.md + MEMORY.md).',
		action: () => ({ kind: 'show-memory' }),
	},
	{
		name: 'skills',
		description: 'List available skills (~/.namzu/skills + ./skills).',
		action: () => ({ kind: 'list-skills' }),
	},
	{
		name: 'resume',
		description: 'Resume a past conversation in this folder.',
		action: () => ({ kind: 'resume' }),
	},
	{
		name: 'expand',
		description: 'Print a collapsed tool output in full: /expand [n].',
		action: (_ctx, args) => {
			const arg = args.join(' ').trim()
			// Bare `/expand` means the most recent one. That is what a person types
			// the moment output truncates in front of them, and making them read a
			// number back off the screen first would be a toll on the common case.
			if (arg.length === 0) return { kind: 'expand', which: 'last' }
			// Matched as the literal decimal a hint can print, and nothing else.
			//
			// `parseInt` would read `2nd` as 2 and expand a block the operator did
			// not name. `Number` plus `Number.isInteger` fixes that one and still
			// admits `0x10`, `1e2`, `+3` and `3.0` — four spellings no hint has
			// ever shown, each of which turns a typo into a valid reference to
			// some OTHER block. What this accepts is exactly what the screen can
			// produce, which is the only set with no silently-wrong answer in it.
			if (!/^[1-9][0-9]*$/.test(arg)) {
				return {
					kind: 'message',
					role: 'system',
					content:
						'Usage: /expand [n], where n is the number in the "… +N lines · /expand n" hint under a collapsed tool output. /expand on its own takes the most recent one.',
				}
			}
			return { kind: 'expand', which: Number(arg) }
		},
	},
	{
		name: 'skill',
		description: 'Activate a skill for this session: /skill <name>.',
		action: (_ctx, args) => {
			const name = args.join(' ').trim()
			return name.length === 0
				? { kind: 'message', role: 'system', content: 'Usage: /skill <name> (see /skills)' }
				: { kind: 'load-skill', name }
		},
	},
	{
		name: 'provider',
		description: 'Show the current provider + model.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content:
				ctx.providerSummary === null
					? 'No provider configured. Run /model to pick one, or set an LLM env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY) and restart namzu.'
					: `Provider: ${ctx.providerSummary}${ctx.modelSummary ? `\nModel: ${ctx.modelSummary}` : ''}`,
		}),
	},
	{
		name: 'model',
		description: 'Re-open the provider picker to switch the primary provider.',
		action: () => ({ kind: 'repick' }),
	},
	{
		name: 'login',
		description: 'Sign in with a subscription: /login, then /login <address> if asked.',
		action: (_ctx, args) =>
			isCompletionArgument(args)
				? { kind: 'login', pasted: args.join(' ').trim() }
				: { kind: 'login' },
	},
	{
		name: 'logout',
		description: 'Remove the subscription credential namzu stored on this machine.',
		action: () => ({ kind: 'logout' }),
	},
	{
		name: 'cost',
		description: 'Show tokens and spend for this run.',
		action: (ctx) => ({ kind: 'message', role: 'system', content: renderCost(ctx.usage) }),
	},
	{
		name: 'review',
		description: 'Ask the agent to review what is uncommitted in this working tree.',
		action: () => ({ kind: 'review' }),
	},
	{
		name: 'mcp',
		description: 'Show which tool servers connected, what they expose, and which failed.',
		action: (ctx) => ({ kind: 'message', role: 'system', content: renderMcp(ctx.mcp) }),
	},
	{
		name: 'diff',
		description: 'Show what is uncommitted in this working tree.',
		action: () => ({ kind: 'diff' }),
	},
	{
		name: 'compact',
		description: 'Summarise the older half of this conversation to free up context.',
		action: () => ({ kind: 'compact' }),
	},
	{
		name: 'copy',
		description: 'Send the latest available assistant output to the terminal clipboard.',
		action: () => ({ kind: 'copy' }),
	},
	{
		name: 'status',
		description: 'Show what this session is, where it may write, and when it stops to ask.',
		action: (ctx) => ({ kind: 'message', role: 'system', content: renderStatus(ctx) }),
	},
	{
		name: 'permissions',
		description: 'Show how tool calls get approved, and any rules in force.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content: renderPermissions(ctx.permissions),
		}),
	},
	{
		name: 'init',
		description: 'Write an AGENTS.md describing this project to future agents.',
		action: (ctx) => {
			if (!ctx.providerSummary) {
				return {
					kind: 'message',
					role: 'system',
					content:
						'/init asks the agent to read this repository and write the file, so it needs a provider. Run /model to pick one.',
				}
			}
			return { kind: 'prompt', text: initPrompt(ctx.instructionFiles) }
		},
	},
]

/**
 * The instruction `/init` sends as a turn.
 *
 * Written as a prompt rather than a template the CLI fills in, because the
 * useful half of this file is what a reader could not guess from the tree —
 * the commands that actually work here, the layout that is deliberate — and
 * only something that has read the repository can say that. A CLI-side
 * generator would produce a directory listing with headings on it.
 *
 * The instruction it opens with is the one that matters: an `AGENTS.md` full of
 * invented conventions is worse than none, because the next agent obeys it. So
 * the prompt asks for verification against the tree and for omission over
 * invention, in those words.
 */
export function initPrompt(instructionFiles: readonly string[]): string {
	const existing =
		instructionFiles.length > 0
			? [
					'',
					'This project ALREADY has project instructions, loaded from:',
					...instructionFiles.map((f) => `  ${f}`),
					'',
					'Do not overwrite them. Read them first, then propose specific edits —',
					'what is now wrong, what is missing — and make only the changes I agree to.',
				].join('\n')
			: ['', 'This project has no AGENTS.md yet. Create one at the repository root.'].join('\n')

	return [
		'Write the project instructions that a coding agent joining this repository would need.',
		'',
		'Verify every claim against the tree before you write it. Do not describe a',
		'command you have not found, a layout you have not opened, or a convention you',
		'have inferred from one file. If you cannot establish something, leave it out —',
		'an AGENTS.md full of plausible inventions is worse than a short true one,',
		'because the next agent will follow it.',
		existing,
		'',
		'Cover what a newcomer cannot get from the file listing:',
		'  - what this project is, in a sentence or two',
		'  - the build, test and lint commands that actually work here (check the',
		'    package manifest or task runner rather than assuming the usual ones)',
		'  - the layout, and any part of it that is deliberate rather than incidental',
		'  - conventions the code visibly holds to, with the evidence that shows it',
		'  - anything that would let someone break the project without noticing',
		'',
		'Keep it short enough to be read in full. Every line costs context on every',
		'future run, so a sentence that says nothing is not free.',
	].join('\n')
}

/**
 * Spend, stated as spend.
 *
 * `totalTokens` is cumulative and monotone; it is NOT how full the context is,
 * and the two were conflated once already — the gauge divided cumulative spend
 * by a guessed window, so it climbed with turn count and read FULL on a
 * conversation with room to spare. This command prints the spend and says which
 * quantity it is, so that nobody reads it as the other one.
 */
export function renderCost(usage: SlashContext['usage']): string {
	if (usage === null) {
		return 'No usage reported yet. The kernel emits it as a turn runs, so this fills in after the first exchange.'
	}

	// Three states, and the third used to read as the first.
	//
	// This printed `'$0.0000 (this provider reported no price)'` for any total
	// that was not above zero — which was every run, because nothing fed the
	// kernel's cost calculation at all. Two things were wrong with it beyond
	// the number. A run on a local model costs nothing and is NOT the same
	// event as a run nobody can price; and the parenthetical asserted a fact
	// about the provider that no code had checked. What was actually known is
	// that this side has no rate for the model — a statement about namzu, not
	// about the vendor, and the difference decides who the operator goes to.
	//
	// The kernel exports `describeCost` for exactly this distinction and it is
	// deliberately NOT used here: it renders through `formatCost`, which rounds
	// to two decimals above a cent, and this command exists to print exact
	// figures (see `SlashContext.usage`). Rounding `$0.0731` to `$0.07` to
	// reuse a helper would trade the property someone asked for against tidy
	// code. The status bar, which must fit, is where the short form belongs.
	const amount = `$${usage.cost.totalCost.toFixed(4)}`
	const unpriced = usage.cost.unpricedTokens > 0
	const lines = [
		`Tokens: ${usage.totalTokens.toLocaleString('en-US')}`,
		`Cost:   ${unpriced && usage.cost.totalCost === 0 ? 'not known' : amount}${
			unpriced && usage.cost.totalCost > 0 ? ' and counting — see below' : ''
		}`,
		'',
	]

	if (unpriced) {
		lines.push(
			`${usage.cost.unpricedTokens.toLocaleString('en-US')} tokens ran on a model namzu has no rate`,
			'for, so what they cost is not in this figure and cannot be. This is not',
			'a claim that they were free. Declare the rate to price them.',
		)
	} else if (usage.cost.totalCost === 0) {
		lines.push(
			'A measured zero, not a missing figure: the model that served this run',
			'bills nothing per token.',
		)
	} else {
		lines.push('Every token in this run was charged at a known rate.')
	}

	lines.push(
		'',
		'Cumulative for this run, across every turn. Not a measure of how full',
		'the context is — that is a different quantity and it goes down when the',
		'conversation is compacted, while this only ever grows.',
	)
	return lines.join('\n')
}

/** What decides a tool call, in the order it actually decides it. */
/**
 * One page holding both halves of what a run may do.
 *
 * They are separate mechanisms and they answer separate questions — where a
 * write may land, and whether anyone is asked first — and neither implies the
 * other. An operator who turns approvals off has not widened the sandbox, and
 * one who confines the filesystem has not stopped the prompts. Read apart, each
 * looks like the whole answer; the failure is believing you configured
 * something you did not.
 *
 * So they are printed adjacently and each is labelled with the question it
 * answers, rather than with its mechanism's name.
 */
/**
 * Which tool servers answered, and what they brought.
 *
 * A failure is listed as prominently as a success and never omitted. The
 * transcript said so once at connect time and scrolled it away, and a server
 * that failed silently is indistinguishable from one nobody configured — which
 * is the state an operator is in when a tool they expect is simply not there.
 */
/**
 * The turn `/review` sends.
 *
 * Two failures shape it, and they pull in opposite directions.
 *
 * A review that INVENTS problems is worse than no review, because someone acts
 * on it — the same reasoning `initPrompt` uses about invented conventions. So
 * the instruction asks for findings tied to a specific line and for silence
 * over speculation.
 *
 * A review that only reassures is worse than useless, because it buys
 * confidence nobody earned. So it also refuses the summary-of-the-diff answer:
 * restating what changed is not review, and it is the shape a model falls into
 * when it has nothing to say.
 *
 * The FILE LIST goes in, not the patch. The agent has tools and a shell; handing
 * it a truncated 24 kB patch would spend the context that reading the
 * interesting parts properly requires, and a review of a truncated diff is a
 * review of whatever fitted.
 */
export function reviewPrompt(stat: string, untracked: readonly string[]): string {
	const lines = [
		'Review the uncommitted work in this repository.',
		'',
		'`git diff HEAD` reports:',
		'',
		stat.length > 0 ? stat : '(no tracked file changed)',
	]
	if (untracked.length > 0) {
		lines.push('', 'Untracked, which no diff shows:', ...untracked.map((p) => `  ${p}`))
	}
	lines.push(
		'',
		'Read what you need — the diff, the files around it, the tests. Then report:',
		'',
		'- Correctness problems, each tied to a file and line, with the input or',
		'  state that produces the wrong behaviour. If you cannot name one, do not',
		'  raise the finding.',
		'- Anything the change claims in a comment or a message that the code does',
		'  not do.',
		'- Tests that would pass whether or not the change is correct.',
		'',
		'Do not summarise the diff back to me — I can read it, and a summary is what',
		'a review turns into when it has nothing to say. If the work looks right,',
		'say so in one line and stop. Say plainly what you did not examine.',
	)
	return lines.join('\n')
}

export function renderMcp(mcp: SlashContext['mcp']): string {
	if (mcp === null) return 'No session yet — no tool servers have been contacted.'

	const lines: string[] = []
	if (mcp.connected.length === 0 && mcp.failed.length === 0) {
		return 'No tool servers configured. Add an `mcpServers` block to namzu.config.json.'
	}

	for (const server of mcp.connected) {
		lines.push(`${server.name} — connected, ${server.tools.length} tool(s)`)
		// Named, not counted. A count answers "did it work"; the operator's
		// actual question is whether the tool they wanted is among them.
		for (const tool of server.tools) lines.push(`  ${tool}`)
	}

	if (mcp.failed.length > 0) {
		if (lines.length > 0) lines.push('')
		for (const server of mcp.failed) {
			lines.push(`${server.name} — NOT available: ${server.reason}`)
		}
	}

	return lines.join('\n')
}

export function renderStatus(ctx: SlashContext): string {
	const lines: string[] = []

	lines.push(`Provider: ${ctx.providerSummary ?? 'none — run /model to pick one'}`)
	lines.push(`Model:    ${ctx.modelSummary ?? '—'}`)
	lines.push('')

	lines.push('Where it may write')
	const sandbox = ctx.sandbox
	if (!sandbox) {
		lines.push('  Not resolved yet — no session has started.')
	} else if (sandbox.unconfined) {
		// The loudest line on the page, and deliberately not softened by the
		// environment name: a tier that enforces nothing is not a weaker
		// sandbox, it is the absence of one.
		lines.push('  Anywhere this shell can. Commands are NOT confined.')
		if (sandbox.environment) {
			lines.push(`  The sandbox is attached (${sandbox.environment}) and enforces nothing here.`)
		}
		lines.push('  Name what you need under `sandbox.requireIsolation` to be refused instead.')
	} else {
		lines.push(`  Confined to this session's sandbox (${sandbox.environment ?? 'unknown'}).`)
		lines.push(`  Enforced here: ${sandbox.enforced.join(', ')}.`)
	}
	if (sandbox && sandbox.required.length > 0) {
		// Worth its own line even when it matches what is enforced: a demand
		// travels to the next machine and a coincidence does not.
		lines.push(
			`  Required by config: ${sandbox.required.join(', ')} — a host without them refuses to run.`,
		)
	} else if (sandbox) {
		lines.push('  Required by config: nothing — this host decides what you get.')
	}
	lines.push('')

	lines.push('When it stops to ask')
	for (const line of renderPermissions(ctx.permissions).split('\n')) {
		lines.push(line.length > 0 ? `  ${line}` : '')
	}

	if (ctx.usage) {
		lines.push('')
		lines.push(`Spend: ${renderCost(ctx.usage).split('\n')[0] ?? ''}`)
	}

	return lines.join('\n').trimEnd()
}

export function renderPermissions(permissions: SlashContext['permissions']): string {
	const lines: string[] = []

	// Three states, most permissive first, and the middle one is the reason this
	// function was rewritten: it is reachable from a single keystroke at a
	// prompt, it silently outranks the default, and it used to be invisible
	// here — so the page answering "how do tool calls get approved" gave the
	// safe answer to an operator who had already turned the safety off.
	if (permissions.skipPermissions) {
		lines.push('Unreviewed calls: approved automatically (--dangerously-skip-permissions).')
	} else if (permissions.approvalLatched()) {
		lines.push('Unreviewed calls: approved automatically — "approve all" was chosen at')
		lines.push('an earlier prompt. Nothing will ask again while this session lasts;')
		lines.push('restart namzu, or re-pick a provider with /model, to be asked again.')
	} else {
		lines.push('Unreviewed calls: you are asked before they run.')
	}

	// Stated in every mode, because it is true in every mode and an operator
	// cannot discover it by using namzu: these tools simply never appear at a
	// prompt, so their absence reads as "the agent did not use any".
	const neverPrompted = permissions.neverPrompted()
	if (neverPrompted.length > 0) {
		lines.push('')
		lines.push(`Never prompted for (${neverPrompted.length}):`)
		lines.push(`  ${neverPrompted.join(', ')}`)
		lines.push('Each of these declares itself read-only, or is a named exception')
		lines.push("for the agent's own task list. A rule can still deny one, and any")
		lines.push('call the kernel flags destructive is prompted for regardless.')
	}

	if (permissions.rules.length === 0) {
		lines.push('')
		lines.push('No rules configured. Add a "permissions" object to namzu.config.json')
		lines.push('to allow or deny tools by name without being asked each time.')
	} else {
		lines.push('')
		lines.push(`Rules (${permissions.rules.length}), from your config:`)
		for (const rule of permissions.rules) lines.push(`  ${describeRule(rule)}`)
	}

	lines.push('')
	// The order this function claims to describe starts here, and the page used
	// to begin one step in. Omitting the gate is not a false statement, but it
	// makes "a rule decides first" read as the whole story when something
	// outranks the rules too — and a true-but-incomplete order is a wrong order
	// for anyone reasoning about what can still get through.
	lines.push('Before any of the below: a built-in safety gate hard-denies a narrow set')
	lines.push('of catastrophic shell patterns (rm -rf /, mkfs, fork bombs, curl|sh, …).')
	lines.push('It applies in every mode, including --dangerously-skip-permissions, and')
	lines.push('nothing here can switch it off.')
	lines.push('')
	// Stated because the precedence is the part people get wrong, and getting it
	// wrong in this direction is the dangerous one: assuming the flag lifts a
	// `deny` they wrote.
	lines.push('Then a rule decides. The approval setting above only reaches calls')
	lines.push('no rule covered, so it can never reopen what a `deny` closed.')

	return lines.join('\n')
}

/**
 * One rule, as a line an operator can check against what they wrote.
 *
 * Every arm is spelled out and the default is a `never`, so a ninth rule type
 * fails the build here instead of printing its own name. The previous version
 * handled two of the eight and returned `rule.type` for the rest — and the
 * most common config in existence compiles to `custom_pattern`, so a
 * per-argument rule someone wrote as `"git push*" = "deny"` was reported to
 * them as the single word `custom_pattern`.
 *
 * The kernel exports a `describeRule` of its own, deliberately not reused: it
 * is phrased to tell a MODEL why one call was refused ("denied by name … so a
 * different input will not change it"). This one is a table of standing policy
 * for a person. Same facts, different question.
 */
function describeRule(rule: AuthorizationRule): string {
	switch (rule.type) {
		case 'deny_by_name':
			return `deny   ${rule.toolNames.join(', ')}`
		case 'allow_by_name':
			return `allow  ${rule.toolNames.join(', ')}`
		case 'allow_by_category':
			return `allow  any tool in category: ${rule.categories.join(', ')}`
		case 'allow_by_tier':
			return `allow  any tool in tier: ${rule.tiers.join(', ')}`
		case 'allow_read_only':
			return 'allow  any tool that only observes'
		case 'deny_dangerous_patterns':
			return 'deny   the built-in catastrophic-command patterns'
		case 'argument_pattern': {
			const verb = rule.decision === 'deny' ? 'deny  ' : 'allow '
			return `${verb} ${rule.toolNames.join(', ')} when ${rule.argument} matches ${rule.pattern}`
		}
		case 'custom_pattern': {
			// The pattern is shown as the regex it compiled to, which is not
			// what the operator typed — a `permissions` table turns
			// `"git push*"` into `^bash .*git push.*$`. Shown anyway: the
			// compiled form is what actually decides, and inventing a
			// prettier one would be reporting a rule that is not in force.
			const verb = rule.decision === 'deny' ? 'deny  ' : 'allow '
			const where = rule.target === 'both' ? 'name+args' : rule.target
			return `${verb} ${where} matching ${rule.pattern}`
		}
		default: {
			const exhaustive: never = rule
			return `unrecognised rule: ${JSON.stringify(exhaustive)}`
		}
	}
}

/** The delegate roster, and an honest answer when there is none. */
/**
 * The roster, drawn.
 *
 * Kept as a formatter and moved off `SlashContext.agentIds`: the roster is
 * the KERNEL's fact — the delegation tools already hold it — and having the
 * CLI carry a second copy meant two answers to one question that could
 * disagree. The command is answered by the registry now; this draws what it
 * reports.
 */
export function renderAgents(ids: readonly string[]): string {
	if (ids.length === 0) {
		return 'No delegates. This session has no delegation tool mounted, so it does the work itself.'
	}
	return [
		`Delegates (${ids.length}):`,
		...ids.map((id) => `  ${id}`),
		'',
		'The agent dispatches to these itself when a task suits one. It may also',
		'define a specialist for a single task, which is not listed here because',
		'it does not exist until the agent asks for it.',
	].join('\n')
}

export function runSlash(
	line: string,
	ctx: SlashContext,
	builtins: readonly SlashCommand[] = CLI_LOCAL_COMMANDS,
): SlashAction | null {
	const parsed = parseSlash(line)
	if (!parsed) return null

	// Builtins first, always. A file appearing on disk must not take over a name
	// the TUI already answers to — `discoverUserCommands` marks those files with
	// a `problem` so their author is told, rather than leaving them to wonder
	// why the file never ran.
	const cmd = builtins.find((c) => c.name === parsed.name)
	if (cmd) return cmd.action(ctx, parsed.args)

	const user = ctx.userCommands.find((c) => c.name === parsed.name)
	if (user) {
		const expanded = expandCommand(user, parsed.args.join(' '))
		return expanded.ok
			? { kind: 'prompt', text: expanded.prompt }
			: { kind: 'message', role: 'system', content: expanded.reason }
	}

	return {
		kind: 'message',
		role: 'system',
		content: `Unknown command: /${parsed.name}. Try /help.`,
	}
}
