/**
 * Slash command registry + parser. Pure logic — no React. Unit-tested.
 *
 * A command's `action` returns a `SlashAction` — see the union below, which has
 * grown well past the "message, exit, or nothing" this line used to claim. The
 * caller (App) maps every kind onto state, and its switch is exhaustive: a kind
 * added here and not handled there falls out of the switch into the send path
 * and dispatches the operator's `/command` to the model as prose.
 *
 * `/cost`, argumentless `/permissions` and `/agents` are RENDERERS. Every number and rule
 * they print was already computed — the kernel emits usage on its own event,
 * the permission rules were compiled before the session opened, and the
 * delegate roster is decided when the subagent runtime is built. None of them
 * asks the model, recomputes anything, or reaches past what the session
 * already carries. A command that had to compute its own answer would be a
 * second source for a fact the kernel already owns, and the two would drift.
 *
 * Ctrl+O's reprint is the same discipline with the split drawn one step earlier. The
 * lines it prints were captured when the tool ran and are held on the transcript
 * row, which this module cannot see and must not: App — the only thing that knows
 * what rows exist — resolves it. Giving this module the transcript to search
 * would put the answer
 * to "does block 4 exist" in two places at once.
 */

import {
	type AuthorizationRule,
	type CostInfo,
	type HostCommandOutcome,
	type ReasoningEffort,
	type SerializableHostCommand,
	kernelHostCommands,
} from '@namzu/sdk'

import { type ConfigDebugSnapshot, renderConfigDebug } from '../config/debug.js'
import type { SandboxSummary } from '../context/sandbox.js'
import { type PermissionMode, isPermissionMode } from '../permissions/mode.js'
import { type UserCommand, expandCommand } from '../user-commands/store.js'
import { isCompletionArgument } from './login-prompt.js'

/** One row in the interactive `/help` command palette. */
export interface CommandPickerEntry {
	readonly name: string
	readonly description: string
	/** Present when a discovered command file exists but cannot be executed. */
	readonly problem?: string
}

export type SlashAction =
	| { kind: 'message'; role: 'system'; content: string }
	/** Choose and dispatch one exact command from the session's live vocabulary. */
	| { kind: 'command-picker'; commands: readonly CommandPickerEntry[] }
	/** Observe child runs retained by this TUI conversation. */
	| { kind: 'agent-cockpit' }
	| { kind: 'exit' }
	/** Empty only the rendered terminal transcript; model context is unchanged. */
	| { kind: 'clear-screen' }
	/** Replace the command invocation with an operator-editable composer draft. */
	| { kind: 'composer-draft'; text: string }
	/** Start a fresh conversation, optionally clearing the rendered transcript too. */
	| { kind: 'new-conversation'; clearScreen: boolean }
	/** Confirm before making the current durable conversation read-only and exiting. */
	| { kind: 'archive-picker' }
	| { kind: 'repick' }
	/** Select how the next TUI turn resolves otherwise-undecided tool calls. */
	| { kind: 'permission-mode'; mode: PermissionMode }
	/** Open the finite permission-mode chooser. */
	| { kind: 'permission-mode-picker' }
	/** Select model-specific reasoning effort for future main-query turns. */
	| { kind: 'reasoning-effort'; effort: ReasoningEffort | null }
	/** Open the current model's finite reasoning-effort chooser. */
	| { kind: 'reasoning-effort-picker' }
	/** Open the finite good/bad chooser for one exact assistant message. */
	| { kind: 'feedback-picker'; messageId: string }
	| { kind: 'remember'; text: string }
	| { kind: 'show-memory' }
	| { kind: 'list-skills' }
	| { kind: 'skill-picker' }
	| { kind: 'load-skill'; name: string }
	| { kind: 'resume' }
	/**
	 * Name this conversation, open its name editor, or take the name away.
	 *
	 * Its own kind rather than a message, because the write touches the
	 * session store and this union is pure. An empty `title` means "open the
	 * editor"; an explicit clear is the literal word, so a person cannot erase
	 * a name by pressing enter on a half-typed command.
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
	/** Choose a raw source region from the latest available assistant output. */
	| { kind: 'copy' }
	/** Toggle or explicitly select copy-friendly plain transcript rendering. */
	| { kind: 'raw'; enabled: boolean | 'toggle' }
	/** Choose whether the verified Markdown projection goes to the clipboard or a file. */
	| { kind: 'export-picker' }
	/** Write a verified, no-clobber Markdown projection of this conversation. */
	| { kind: 'export'; path: string }
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
	| { kind: 'review'; instructions?: string }
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
	| {
			kind: 'feedback'
			rating: 'good' | 'bad'
			messageId: string
			note?: string
	  }
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
	| { kind: 'logout'; target?: 'anthropic' | 'codex' | 'all' }
	| { kind: 'none' }

/** What `/context` reads: the strategy the session runs and what its passes have done so far. */
export interface CompactionSummary {
	readonly strategy: 'structured' | 'salience'
	/** Fraction of the window the salience pass holds the context at. */
	readonly softTarget: number
	/** Fraction of the window at which older history is summarised. */
	readonly triggerThreshold: number
	readonly passes: number
	readonly clearedResults: number
	readonly stubbedNarrations: number
	readonly summaries: number
	readonly reclaimedTokens: number
}

export interface SlashContext {
	/** Canonical working directory owned by this TUI session. */
	readonly cwd: string
	/** Null before a session exists. */
	readonly compaction: CompactionSummary | null
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
	 * Tool servers as they stand when the command runs.
	 *
	 * `null` before a session exists. Reported at connect time as transcript
	 * rows that scroll away, and nowhere else — so an operator ten minutes into
	 * a session had no way to ask which servers answered and which did not.
	 */
	readonly mcp: () => {
		readonly connected: readonly {
			readonly name: string
			readonly tools: readonly string[]
		}[]
		readonly failed: readonly {
			readonly name: string
			readonly reason: string
		}[]
	} | null
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	/** Live, model/chain-specific reasoning-effort control. */
	readonly reasoningEffort: {
		readonly current: () => ReasoningEffort | undefined
		readonly levels: readonly ReasoningEffort[] | undefined
	}
	/**
	 * CUMULATIVE run spend, or `null` before the first turn reports any.
	 *
	 * The same numbers the status bar abbreviates. Kept as the kernel's own
	 * quantity rather than a formatted string so `/cost` can print exact
	 * figures — an abbreviation is right for a bar that must fit and wrong for
	 * a question someone asked on purpose.
	 */
	readonly usage: {
		readonly totalTokens: number
		readonly cost: CostInfo
		/**
		 * How full the context is, when the run knows: the numerator and the
		 * window with their provenance, from the `usage` event. Absent when
		 * the run resolved no window. Printed here, on request, rather than in
		 * the footer — the persistent gauge was removed on purpose for a
		 * quieter frame, and `/cost` is where a person asks.
		 */
		readonly context?: {
			readonly tokens: number
			readonly windowTokens: number
			readonly measured: boolean
			readonly windowAssumed: boolean
		}
	} | null
	/** What decides a tool call right now — flags, config, and session state. */
	readonly permissions: {
		/** Live mode and why it currently has that value, read at render time. */
		readonly currentMode: () => {
			readonly mode: PermissionMode
			readonly source: 'default' | 'launch-bypass' | 'session'
		}
		readonly rules: readonly AuthorizationRule[]
		/**
		 * Whether "approve all" is in force, read at render time.
		 *
		 * A function because this field changes while namzu runs. The selected
		 * mode above also moves, but only at an idle command boundary; this one
		 * flips on a keystroke mid-turn. Since
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
	/** Values-free launch snapshot behind `/debug-config`; null for an embed that omitted it. */
	readonly configDebug: ConfigDebugSnapshot | null

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
	/** Compatibility-only commands remain executable but stay out of discovery UI. */
	readonly discoverable?: false
	readonly action: (ctx: SlashContext, args: readonly string[]) => SlashAction
}

export interface ParsedSlash {
	readonly name: string
	readonly args: readonly string[]
}

function renameConversationAction(_ctx: SlashContext, args: readonly string[]): SlashAction {
	const text = args.join(' ').trim()
	if (text.toLowerCase() === 'clear') return { kind: 'title', title: '', clear: true }
	return { kind: 'title', title: text, clear: false }
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

	const matches = [...builtins.filter((command) => command.discoverable !== false), ...own].filter(
		(command) => command.name.startsWith(prefix),
	)
	if (prefix.length === 0) return matches
	const exact = matches.findIndex((command) => command.name === prefix)
	if (exact <= 0) return matches
	const exactMatch = matches[exact]
	if (!exactMatch) return matches
	return [exactMatch, ...matches.slice(0, exact), ...matches.slice(exact + 1)]
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
				action: (_ctx, args) => ({
					kind: 'host-command',
					name: descriptor.name,
					args,
				}),
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
		description: 'Choose and run an available slash command.',
		action: (ctx) => {
			// Reads what this session OFFERS, not a module constant. A command the
			// kernel registered and `/help` did not list is a command nobody
			// discovers. Refused command files remain rows with their reason; App
			// refuses those rows instead of silently invoking a same-named builtin.
			return {
				kind: 'command-picker',
				commands: [
					...(ctx.builtins ?? CLI_LOCAL_COMMANDS)
						.filter((command) => command.discoverable !== false)
						.map((command) => ({
							name: command.name,
							description: command.description,
						})),
					...ctx.userCommands.map((command) => ({
						name: command.name,
						description: command.description,
						...(command.problem ? { problem: command.problem } : {}),
					})),
				],
			}
		},
	},
	{
		name: 'feedback',
		description: 'Rate the last answer; choose good/bad or add an optional note.',
		action: (ctx, args) => {
			if (args.length === 0) {
				const messageId = ctx.lastAssistantMessageId()
				return messageId
					? { kind: 'feedback-picker', messageId }
					: {
							kind: 'message',
							role: 'system',
							content: 'Nothing to rate yet — /feedback applies to the last answer in this run.',
						}
			}
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
		description: 'Clear the terminal and start a fresh conversation.',
		action: () => ({ kind: 'new-conversation', clearScreen: true }),
	},
	{
		name: 'new',
		description: 'Start a fresh conversation without clearing the terminal.',
		action: () => ({ kind: 'new-conversation', clearScreen: false }),
	},
	{
		name: 'archive',
		description: 'Archive this conversation and exit after confirmation.',
		action: () => ({ kind: 'archive-picker' }),
	},
	{
		name: 'exit',
		description: 'Exit namzu.',
		action: () => ({ kind: 'exit' }),
	},
	{
		name: 'rename',
		description:
			'Rename this conversation; opens an editor when no name is supplied. /rename clear removes the saved name.',
		action: renameConversationAction,
	},
	{
		name: 'fork',
		description: 'Continue in a copy of this conversation, leaving the original where it is.',
		action: () => ({ kind: 'fork' }),
	},
	{
		name: 'memory',
		description: 'Show what namzu remembers, or save a fact: /memory [something to remember].',
		action: (_ctx, args) => {
			const text = args.join(' ').trim()
			return text.length === 0 ? { kind: 'show-memory' } : { kind: 'remember', text }
		},
	},
	{
		name: 'skills',
		description: 'Choose an available skill; use /skills list for the full roster.',
		action: (_ctx, args) => {
			const choice = args.join(' ').trim()
			if (choice.length === 0) return { kind: 'skill-picker' }
			if (choice.toLowerCase() === 'list') return { kind: 'list-skills' }
			return { kind: 'load-skill', name: choice }
		},
	},
	{
		name: 'resume',
		description: 'Resume a past conversation in this folder.',
		action: () => ({ kind: 'resume' }),
	},
	{
		name: 'model',
		description: 'Re-open the provider picker to switch the primary provider.',
		action: () => ({ kind: 'repick' }),
	},
	{
		name: 'login',
		description: 'Sign in with a Claude or Codex subscription.',
		action: (_ctx, args) =>
			isCompletionArgument(args)
				? { kind: 'login', pasted: args.join(' ').trim() }
				: { kind: 'login' },
	},
	{
		name: 'logout',
		description: 'Remove a Namzu-owned subscription credential: /logout [claude|codex|all].',
		action: (_ctx, args) => {
			const target = args.join(' ').trim().toLowerCase()
			if (target.length === 0) return { kind: 'logout' }
			if (target === 'claude' || target === 'anthropic') {
				return { kind: 'logout', target: 'anthropic' }
			}
			if (target === 'codex' || target === 'chatgpt') return { kind: 'logout', target: 'codex' }
			if (target === 'all') return { kind: 'logout', target: 'all' }
			return {
				kind: 'message',
				role: 'system',
				content: 'Usage: /logout [claude|codex|all]',
			}
		},
	},
	{
		name: 'cost',
		description: 'Show tokens and spend for this run.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content: renderCost(ctx.usage, ctx.compaction),
		}),
	},
	{
		name: 'context',
		description: 'Show how full the context is and what compaction has done to keep it that way.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content: renderContext(ctx.usage, ctx.compaction),
		}),
	},
	{
		name: 'review',
		description: 'Choose a review target, or provide custom instructions: /review [instructions].',
		action: (_ctx, args) => {
			const instructions = args.join(' ').trim()
			return instructions ? { kind: 'review', instructions } : { kind: 'review' }
		},
	},
	{
		name: 'mcp',
		description: 'Show current tool-server connections, tools, and failures.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content: renderMcp(ctx.mcp()),
		}),
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
		description: 'Choose the whole latest answer, a code block, or a quote to copy.',
		action: () => ({ kind: 'copy' }),
	},
	{
		name: 'raw',
		description: 'Toggle copy-friendly plain transcript rendering: /raw [on|off].',
		action: (_ctx, args) => {
			const choice = args.join(' ').trim().toLowerCase()
			if (choice.length === 0) return { kind: 'raw', enabled: 'toggle' }
			if (choice === 'on') return { kind: 'raw', enabled: true }
			if (choice === 'off') return { kind: 'raw', enabled: false }
			return {
				kind: 'message',
				role: 'system',
				content: 'Usage: /raw [on|off]',
			}
		},
	},
	{
		name: 'export',
		description: 'Export this verified conversation to the clipboard or a Markdown file.',
		action: (_ctx, args) => {
			const path = args.join(' ').trim()
			return path.length > 0 ? { kind: 'export', path } : { kind: 'export-picker' }
		},
	},
	{
		name: 'status',
		description:
			'Show what this session is, where it may write, and when it stops to ask; /status config for where each setting came from, /status tools for what the agent can call.',
		action: (ctx, args) => {
			const which = args.join(' ').trim().toLowerCase()
			if (which === 'config') {
				return { kind: 'message', role: 'system', content: renderConfigDebug(ctx.configDebug) }
			}
			if (which === 'tools') {
				const tools = ctx.availableTools()
				return {
					kind: 'message',
					role: 'system',
					content:
						tools.length === 0
							? 'No tools registered yet — the agent session may still be connecting.'
							: `Registered tools (${tools.length}):\n  ${tools.join('\n  ')}`,
				}
			}
			if (which.length > 0) {
				return { kind: 'message', role: 'system', content: 'Usage: /status [config|tools]' }
			}
			return { kind: 'message', role: 'system', content: renderStatus(ctx) }
		},
	},
	{
		name: 'permissions',
		description: 'Choose how undecided tool calls are handled: /permissions [mode].',
		action: (_ctx, args) => {
			if (args.length === 0) return { kind: 'permission-mode-picker' }
			const mode = args.length === 1 ? args[0]?.toLowerCase() : undefined
			if (isPermissionMode(mode)) return { kind: 'permission-mode', mode }
			return {
				kind: 'message',
				role: 'system',
				content: 'Usage: /permissions [prompt|auto|strict]',
			}
		},
	},
	{
		name: 'effort',
		description: 'Choose reasoning effort for future turns: /effort [level|default].',
		action: (ctx, args) => {
			if (args.length === 0) {
				if (!ctx.providerSummary) {
					return {
						kind: 'message',
						role: 'system',
						content: 'No active session — pick a provider with /model before changing effort.',
					}
				}
				if (ctx.reasoningEffort.levels === undefined) {
					return {
						kind: 'message',
						role: 'system',
						content: `Reasoning effort cannot be selected here: ${ctx.modelSummary ?? 'the current model'} or one of its usable fallback models does not publish an exact effort menu.`,
					}
				}
				return { kind: 'reasoning-effort-picker' }
			}
			if (!ctx.providerSummary) {
				return {
					kind: 'message',
					role: 'system',
					content: 'No active session — pick a provider with /model before changing effort.',
				}
			}
			const token = args.length === 1 ? args[0]?.toLowerCase() : undefined
			if (token === 'default') return { kind: 'reasoning-effort', effort: null }
			const offered = ctx.reasoningEffort.levels
			if (offered === undefined) {
				return {
					kind: 'message',
					role: 'system',
					content: `Reasoning effort was not changed: ${ctx.modelSummary ?? 'the current model'} or one of its usable fallback models does not publish an exact effort menu. Leave the provider default in force or choose a model/chain that can enumerate its levels.`,
				}
			}
			const effort = offered.find((level) => level === token)
			if (effort) return { kind: 'reasoning-effort', effort }
			const levels = offered.length > 0 ? offered.join('|') : '<none>'
			return {
				kind: 'message',
				role: 'system',
				content: `Usage: /effort [${levels}|default]`,
			}
		},
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
/**
 * The working set, as a reader would ask about it: how full, held where,
 * and what it has cost the transcript so far. Counts are for this session,
 * summed over every pass; a pass that declined leaves them unchanged.
 */
export function renderContext(
	usage: SlashContext['usage'],
	compaction: CompactionSummary | null,
): string {
	const lines: string[] = []
	const context = usage?.context
	if (context && context.windowTokens > 0) {
		const percent = Math.min(999, Math.round((context.tokens / context.windowTokens) * 100))
		const approx = context.measured && !context.windowAssumed ? '' : '~'
		lines.push(
			`Context: ${context.tokens.toLocaleString('en-US')} / ${context.windowTokens.toLocaleString('en-US')} tokens (${approx}${percent}%)`,
			`${context.measured ? 'Counted by the provider' : 'Estimated on this side'}; window ${
				context.windowAssumed
					? 'assumed from a table or default'
					: 'declared by the provider or config'
			}.`,
		)
	} else {
		lines.push('No context measurement yet. The kernel reports it as a turn runs.')
	}
	if (!compaction) {
		lines.push('', 'No session yet, so no compaction strategy to report.')
		return lines.join('\n')
	}
	const pct = (fraction: number) => `${Math.round(fraction * 100)}%`
	lines.push('')
	if (compaction.strategy === 'salience') {
		lines.push(
			'Strategy: salience — every message is scored (recency, relevance to the goal,',
			`whether a later turn used it, whether a later message repeats it) and from ${pct(compaction.softTarget)}`,
			"of the window the least salient are evicted first: a tool result's body cleared, a",
			`narration cut to its first sentence. Older history is summarised only at ${pct(compaction.triggerThreshold)}.`,
		)
	} else {
		lines.push(
			`Strategy: structured — at ${pct(compaction.triggerThreshold)} of the window, stale tool results are cleared`,
			'and, if that is not enough, older history is replaced by a structured summary.',
		)
	}
	lines.push(
		'',
		`Passes this session: ${compaction.passes}`,
		`  tool results cleared:  ${compaction.clearedResults.toLocaleString('en-US')}`,
		`  narrations stubbed:    ${compaction.stubbedNarrations.toLocaleString('en-US')}`,
		`  summaries written:     ${compaction.summaries.toLocaleString('en-US')}`,
		`  tokens reclaimed:      ~${compaction.reclaimedTokens.toLocaleString('en-US')}`,
	)
	return lines.join('\n')
}

export function renderCost(
	usage: SlashContext['usage'],
	compaction: CompactionSummary | null = null,
): string {
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

	// The other quantity, when the run has it. Each term with its provenance,
	// because a ratio is only as sound as the weaker of its terms and a bare
	// `42%` over an assumed window would be a measurement nobody made.
	const context = usage.context
	if (context && context.windowTokens > 0) {
		const percent = Math.min(999, Math.round((context.tokens / context.windowTokens) * 100))
		const approx = context.measured && !context.windowAssumed ? '' : '~'
		lines.push(
			'',
			`Context: ${context.tokens.toLocaleString('en-US')} / ${context.windowTokens.toLocaleString('en-US')} tokens (${approx}${percent}%)`,
			`${context.measured ? 'Counted by the provider' : 'Estimated on this side'}; window ${
				context.windowAssumed
					? 'assumed from a table or default'
					: 'declared by the provider or config'
			}. ${
				compaction?.strategy === 'salience'
					? `Salience holds it from ${Math.round(compaction.softTarget * 100)}%; /context has the detail.`
					: `Automatic compaction runs at ${Math.round((compaction?.triggerThreshold ?? 0.7) * 100)}%.`
			}`,
		)
	}
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

/** Review a branch comparison already resolved by the host to an immutable commit. */
export function baseBranchReviewPrompt(mergeBaseSha: string): string {
	return reviewTargetPrompt([
		'Review the changes between the current working tree and its selected base branch.',
		`The host resolved the merge base to ${mergeBaseSha}.`,
		`Use \`git diff ${mergeBaseSha}\` as the comparison boundary.`,
	])
}

/** Review one immutable commit without asking the model to resolve a mutable ref. */
export function commitReviewPrompt(sha: string): string {
	return reviewTargetPrompt([
		`Review the code changes introduced by commit ${sha}.`,
		`Use \`git show --stat --oneline ${sha}\` and \`git diff ${sha}^ ${sha}\` as the boundary.`,
	])
}

function reviewTargetPrompt(target: readonly string[]): string {
	return [
		...target,
		'',
		'Read the changed files and surrounding code, then report prioritized, actionable findings.',
		'Every finding must name the file, line and concrete state that produces the wrong behavior.',
		'Do not summarize the change back to me. If there are no findings, say so in one line.',
		'Say plainly what you did not examine.',
	].join('\n')
}

export function renderMcp(mcp: ReturnType<SlashContext['mcp']>): string {
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
	if (sandbox?.workspace === 'working-directory') {
		lines.push('  Workspace: real project files — changes persist across turns.')
	} else if (sandbox?.workspace === 'ephemeral') {
		lines.push('  Workspace: disposable per run — changes are removed at teardown.')
	} else if (sandbox?.workspace === 'host') {
		lines.push('  Workspace: real project files on the host.')
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
	const current = permissions.currentMode()
	lines.push(`Current mode: ${current.mode}.`)
	lines.push('')

	// Four effective states, most permissive first, and the approve-all one is the reason this
	// function was rewritten: it is reachable from a single keystroke at a
	// prompt, it silently outranks the default, and it used to be invisible
	// here — so the page answering "how do tool calls get approved" gave the
	// safe answer to an operator who had already turned the safety off.
	if (current.mode === 'auto') {
		lines.push(
			current.source === 'launch-bypass'
				? 'Unreviewed calls: approved automatically (--dangerously-skip-permissions).'
				: 'Unreviewed calls: approved automatically for future turns (/permissions auto).',
		)
	} else if (current.mode === 'strict') {
		lines.push('Unreviewed calls: rejected automatically for future turns (/permissions strict).')
		lines.push(
			'Only calls an explicit allow rule covers may run; no approval prompt can widen that.',
		)
	} else if (permissions.approvalLatched()) {
		lines.push('Unreviewed calls: approved automatically — "approve all" was chosen at')
		lines.push('an earlier prompt. Run /permissions prompt to revoke that latch and ask again.')
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

/** Render the exact session control without inventing a global effort menu. */
export function renderReasoningEffort(ctx: SlashContext): string {
	if (!ctx.providerSummary) {
		return 'No active session — pick a provider with /model before selecting reasoning effort.'
	}
	const current = ctx.reasoningEffort.current()
	const lines = [
		`Current reasoning effort: ${current ?? 'provider default'}.`,
		`Model: ${ctx.modelSummary ?? 'provider default'}.`,
	]
	const offered = ctx.reasoningEffort.levels
	if (offered === undefined) {
		lines.push(
			'Selectable levels: unavailable — this model or one usable fallback cannot enumerate an exact menu.',
		)
	} else if (offered.length === 0) {
		lines.push('Selectable levels: none — the usable provider chain has no common effort level.')
	} else {
		lines.push(`Selectable for every usable provider-chain member: ${offered.join(', ')}.`)
		lines.push(`Use /effort <${offered.join('|')}> or /effort default.`)
	}
	lines.push(
		'Applies to future main-query turns in this TUI session; /model resets it. Subagents and manual compaction keep their own provider defaults.',
	)
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
