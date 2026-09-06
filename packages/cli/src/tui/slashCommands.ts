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
	type TokenBudgetSummary,
	kernelHostCommands,
} from '@namzu/sdk'

import { type ConfigDebugSnapshot, renderConfigDebug } from '../config/debug.js'
import type { HooksConfig } from '../config/schema.js'
import type { SandboxSummary } from '../context/sandbox.js'
import {
	type PermissionMode,
	effectivePermissionMode,
	isPermissionMode,
	permissionModeDescription,
	permissionModeLabel,
} from '../permissions/mode.js'
import { readChangelog, renderReleaseNotes } from '../release-notes.js'
import { ARGUMENTS_TOKEN, type UserCommand, expandCommand } from '../user-commands/store.js'
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
	| { kind: 'settings-picker' }
	| { kind: 'goal-picker' }
	| { kind: 'goal-editor'; edit: boolean }
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
	| { kind: 'remember'; text: string; scope: 'project' | 'user' }
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
	/** List file checkpoints, or put the tree back to before turn `turn`. */
	| { kind: 'restore'; turn?: number }
	/** Let the file tools reach another directory for the rest of the session. */
	| { kind: 'add-dir'; path: string }
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
	/** The shell hooks this session runs, by event; absent when the session has none. */
	readonly hooks?: () => HooksConfig | undefined
	/** Directories besides the working directory the file tools may reach, absolute. */
	readonly directories?: () => readonly string[]
	/** This session's background jobs, running and ended; empty under a sandbox. */
	readonly jobs: () => readonly {
		readonly id: string
		readonly command: string
		readonly status: 'running' | 'exited' | 'killed'
		readonly exitCode?: number
		readonly startedAt: number
	}[]
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
	 * Current or latest run spend, or `null` before the first usage report.
	 *
	 * The same numbers the status bar abbreviates. Kept as the kernel's own
	 * quantity rather than a formatted string so `/cost` can print exact
	 * figures — an abbreviation is right for a bar that must fit and wrong for
	 * a question someone asked on purpose.
	 */
	readonly usage: {
		readonly budget?: TokenBudgetSummary
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
	/** Read-only usage, kept beside the action rather than inferred by executing it. */
	readonly help?: {
		readonly usage: readonly string[]
		readonly details?: readonly string[]
	}
	/** Compatibility-only commands remain executable but stay out of discovery UI. */
	readonly discoverable?: false
	/** A live precondition shared by discovery and execution. */
	readonly unavailable?: (ctx: SlashContext) => string | undefined
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
export const HOST_OWNED_COMMAND_NAMES: readonly string[] = ['skills', 'agents', 'goal']

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
				help: {
					// An arbitrary JSON Schema does not declare positional CLI syntax.
					usage: [`/${descriptor.name}${descriptor.args ? ' [arguments]' : ''}`],
					...(descriptor.hint ? { details: [descriptor.hint] } : {}),
				},
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

/** Help reads metadata only: even a mutating or unavailable command is safe to inspect. */
function commandHelp(ctx: SlashContext, args: readonly string[]): SlashAction {
	const name = args[0]?.replace(/^\//, '')
	if (args.length !== 1 || !name) {
		return {
			kind: 'message',
			role: 'system',
			content: 'Usage: /help [command]. For example: /help permissions.',
		}
	}
	const command = (ctx.builtins ?? CLI_LOCAL_COMMANDS).find((entry) => entry.name === name)
	if (command) {
		const reason = command.unavailable?.(ctx)
		return {
			kind: 'message',
			role: 'system',
			content: [
				`/${command.name}`,
				command.description,
				'',
				'Usage:',
				...(command.help?.usage ?? [`/${command.name}`]).map((usage) => `  ${usage}`),
				...(command.help?.details?.length ? ['', ...command.help.details] : []),
				...(reason ? ['', `Unavailable: ${reason}`] : []),
			].join('\n'),
		}
	}
	const user = ctx.userCommands.find((entry) => entry.name === name)
	if (user) {
		const acceptsArguments = user.template.includes(ARGUMENTS_TOKEN)
		return {
			kind: 'message',
			role: 'system',
			content: [
				`/${user.name}`,
				user.description,
				'',
				...(user.problem
					? []
					: [
							'Usage:',
							`  /${user.name}${acceptsArguments ? ' [arguments]' : ''}`,
							'',
							'Running this command sends its saved prompt to the model.',
						]),
				`${user.source === 'project' ? 'Project command' : 'User command (all projects)'}: ${user.path}`,
				...(user.problem ? [`Unavailable: ${user.problem}`] : []),
			].join('\n'),
		}
	}
	return {
		kind: 'message',
		role: 'system',
		content: `Unknown command: /${name}. Use /help to browse available commands.`,
	}
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
		name: 'settings',
		description: 'View current settings and change model, reasoning or permissions.',
		action: () => ({ kind: 'settings-picker' }),
	},
	{
		name: 'agents',
		description: 'Inspect delegated agents; /agents available lists configured agents.',
		help: { usage: ['/agents [running|available]'] },
		action: (_ctx, args) =>
			args.length === 0 || (args.length === 1 && args[0] === 'running')
				? { kind: 'agent-cockpit' }
				: args.length === 1 && args[0] === 'available'
					? { kind: 'host-command', name: 'agents', args: [] }
					: { kind: 'message', role: 'system', content: 'Usage: /agents [running|available]' },
	},
	{
		name: 'goal',
		description: 'Manage this conversation’s goal and automatic continuation.',
		help: {
			usage: [
				'/goal',
				'/goal status',
				'/goal set [objective]',
				'/goal edit [objective]',
				'/goal pause|resume|clear',
			],
			details: [
				'Set and edit open an editor when no objective is supplied. Direct /goal <objective> also creates a goal.',
				'Creating or resuming a goal enables automatic work. Pausing or clearing stops future automatic turns.',
			],
		},
		action: (_ctx, args) => {
			if (args.length === 0) return { kind: 'goal-picker' }
			if (args.length === 1 && args[0] === 'status') {
				return { kind: 'host-command', name: 'goal', args: [] }
			}
			if (args.length === 1 && (args[0] === 'set' || args[0] === 'edit')) {
				return { kind: 'goal-editor', edit: args[0] === 'edit' }
			}
			return { kind: 'host-command', name: 'goal', args }
		},
	},
	{
		name: 'help',
		description: 'Browse commands, or show usage with /help <command>.',
		help: {
			usage: ['/help', '/help <command>'],
			details: [
				'Without a name, opens the command menu. With a name, shows help without running the command.',
			],
		},
		action: (ctx, args) => {
			if (args.length > 0) return commandHelp(ctx, args)
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
							...(command.unavailable?.(ctx) ? { problem: command.unavailable(ctx) } : {}),
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
		help: { usage: ['/feedback', '/feedback good|bad [note]'] },
		unavailable: (ctx) =>
			ctx.lastAssistantMessageId()
				? undefined
				: 'Nothing to rate yet. Wait for an assistant answer.',
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
		help: { usage: ['/rename [name]', '/rename clear'] },
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
		name: 'add-dir',
		help: {
			usage: ['/add-dir [path]'],
			details: ['Without a path, lists added directories. Paths may contain spaces.'],
		},
		description:
			'Let the file tools reach another directory this session: /add-dir <path>. Alone, list them.',
		action: (ctx, args) => {
			const path = args.join(' ').trim()
			if (path.length === 0) {
				const dirs = ctx.directories?.() ?? []
				return {
					kind: 'message',
					role: 'system',
					content:
						dirs.length === 0
							? 'No added directories. The file tools reach the working directory only. /add-dir <path> adds one for this session; `additionalDirectories` in the config file adds one for every session.'
							: `Added directories (reachable by absolute path, bound into the sandbox):\n${dirs.map((d) => `  ${d}`).join('\n')}`,
				}
			}
			return { kind: 'add-dir', path }
		},
	},
	{
		name: 'restore',
		help: {
			usage: ['/restore [turn]'],
			details: ['Run /restore to list checkpoints before choosing a turn to restore.'],
		},
		description:
			'Put files back to before a turn: /restore lists the checkpoints, /restore N restores.',
		action: (_ctx, args) => {
			const raw = args[0]?.trim()
			if (!raw) return { kind: 'restore' }
			const turn = Number.parseInt(raw, 10)
			if (!Number.isInteger(turn) || turn < 1 || String(turn) !== raw) {
				return {
					kind: 'message',
					role: 'system',
					content: `/restore takes a turn number from the list: /restore 3. Not: ${raw}`,
				}
			}
			return { kind: 'restore', turn }
		},
	},
	{
		name: 'memory',
		help: {
			usage: ['/memory [show|list]', '/memory add <text>', '/memory --user add <text>'],
			details: [
				'Show and list read saved memory. Add saves a project note; --user saves a note for all projects.',
				'Direct /memory <text> also saves a note. To save a reserved word as a note, use /memory add show.',
			],
		},
		description:
			'Show curated memory, or save a fact with /memory add <text>. Use /memory --user add <text> for every project.',
		action: (_ctx, args) => {
			const user = args[0] === '--user'
			const memoryArgs = user ? args.slice(1) : args
			const text = memoryArgs.join(' ').trim()
			// Reserve standalone inspection words while retaining multiword facts.
			if (text.length === 0 || ['show', 'list'].includes(text.toLowerCase())) {
				return { kind: 'show-memory' }
			}
			if (memoryArgs[0]?.toLowerCase() === 'add') {
				const fact = memoryArgs.slice(1).join(' ').trim()
				if (fact.length === 0) {
					return {
						kind: 'message',
						role: 'system',
						content:
							'Usage: /memory add <text> or /memory --user add <text>. /memory show displays saved memory.',
					}
				}
				return { kind: 'remember', text: fact, scope: user ? 'user' : 'project' }
			}
			return { kind: 'remember', text, scope: user ? 'user' : 'project' }
		},
	},
	{
		name: 'skills',
		help: { usage: ['/skills', '/skills list', '/skills <name>'] },
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
		description: 'Choose a model for the current provider, or change providers.',
		help: {
			usage: ['/model'],
			details: [
				'Press p in the model picker to change providers. Normal selections are saved for future launches; temporary credentials keep the selection in this session.',
			],
		},
		action: () => ({ kind: 'repick' }),
	},
	{
		name: 'login',
		description: 'Sign in with a Claude or Codex subscription.',
		help: {
			usage: ['/login', '/login <callback-address-or-code>'],
			details: [
				'Start sign-in with /login, then paste the callback address or code when requested.',
			],
		},
		action: (_ctx, args) =>
			isCompletionArgument(args)
				? { kind: 'login', pasted: args.join(' ').trim() }
				: { kind: 'login' },
	},
	{
		name: 'logout',
		help: { usage: ['/logout [claude|codex|all]'] },
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
		help: { usage: ['/cost [details]'] },
		description: 'Show usage and cost for the current or latest run.',
		action: (ctx, args) =>
			reportCommand('cost', args, (details) => renderCost(ctx.usage, ctx.compaction, details)),
	},
	{
		name: 'jobs',
		description: 'List background jobs started this session, running and ended.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content: renderJobs(ctx.jobs()),
		}),
	},
	{
		name: 'release-notes',
		help: { usage: ['/release-notes [version]'] },
		description: 'Show what changed in the version that is running: /release-notes [version].',
		action: (_ctx, args) => ({
			kind: 'message',
			role: 'system',
			content: renderReleaseNotes(readChangelog(), args[0]?.trim() || undefined),
		}),
	},
	{
		name: 'hooks',
		description: 'List the shell hooks this session runs, by event.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content: renderHooks(ctx.hooks?.()),
		}),
	},
	{
		name: 'context',
		help: { usage: ['/context [details]'] },
		description: 'Show context usage and automatic cleanup.',
		action: (ctx, args) =>
			reportCommand('context', args, (details) =>
				renderContext(ctx.usage, ctx.compaction, details),
			),
	},
	{
		name: 'review',
		help: {
			usage: ['/review [instructions]'],
			details: [
				'Without instructions, opens the review target menu. Starting a review uses the selected model.',
			],
		},
		description: 'Choose a review target, or provide custom instructions: /review [instructions].',
		action: (_ctx, args) => {
			const instructions = args.join(' ').trim()
			return instructions ? { kind: 'review', instructions } : { kind: 'review' }
		},
	},
	{
		name: 'mcp',
		help: { usage: ['/mcp [tools|details]'] },
		description: 'Show connected tool servers and connection problems.',
		action: (ctx, args) =>
			reportCommand('mcp', args, (details) => renderMcp(ctx.mcp(), details), 'tools'),
	},
	{
		name: 'diff',
		description: 'Show what is uncommitted in this working tree.',
		action: () => ({ kind: 'diff' }),
	},
	{
		name: 'compact',
		description: 'Summarise the older half of this conversation to free up context.',
		help: {
			usage: ['/compact'],
			details: ['Compaction uses a model call to summarise older context.'],
		},
		action: () => ({ kind: 'compact' }),
	},
	{
		name: 'copy',
		description: 'Choose the whole latest answer, a code block, or a quote to copy.',
		action: () => ({ kind: 'copy' }),
	},
	{
		name: 'raw',
		help: { usage: ['/raw [on|off]'] },
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
		help: {
			usage: ['/export [path]'],
			details: [
				'Without a path, choose the clipboard or a Markdown file. Existing files are not overwritten. Paths may contain spaces.',
			],
		},
		description: 'Export this verified conversation to the clipboard or a Markdown file.',
		action: (_ctx, args) => {
			const path = args.join(' ').trim()
			return path.length > 0 ? { kind: 'export', path } : { kind: 'export-picker' }
		},
	},
	{
		name: 'status',
		help: { usage: ['/status [details|config|tools]'] },
		description: 'Show the model, permissions, workspace and latest cost.',
		action: (ctx, args) => {
			const which = args.join(' ').trim().toLowerCase()
			if (which === 'config') {
				return {
					kind: 'message',
					role: 'system',
					content: renderConfigDebug(ctx.configDebug),
				}
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
			if (which.length > 0 && which !== 'details') {
				return {
					kind: 'message',
					role: 'system',
					content: 'Usage: /status [details|config|tools]',
				}
			}
			return { kind: 'message', role: 'system', content: renderStatus(ctx, which === 'details') }
		},
	},
	{
		name: 'permissions',
		description: 'Choose which actions need your approval.',
		help: {
			usage: ['/permissions', '/permissions details', '/permissions <mode>'],
			details: [
				'Choose a preset in the menu, or use a typed mode:',
				...(['prompt', 'accept-edits', 'plan', 'auto', 'strict'] as const).map(
					(mode) => `  ${mode}: ${permissionModeLabel(mode)}`,
				),
				'Changes apply to this session. Explicit deny rules and sandbox restrictions still apply.',
			],
		},
		action: (ctx, args) => {
			if (args.length === 0) return { kind: 'permission-mode-picker' }
			const mode = args.length === 1 ? args[0]?.toLowerCase() : undefined
			if (mode === 'details') {
				return {
					kind: 'message',
					role: 'system',
					content: renderPermissions(ctx.permissions, true),
				}
			}
			if (isPermissionMode(mode)) return { kind: 'permission-mode', mode }
			return {
				kind: 'message',
				role: 'system',
				content:
					'Usage: /permissions opens the permission menu. Choose a preset there, or use /permissions details to view rules.',
			}
		},
	},
	{
		name: 'effort',
		help: {
			usage: ['/effort [level|default]'],
			details: [
				'Run /effort to see the levels supported by the selected model and usable fallbacks. Changes affect future main-query turns in this session.',
			],
		},
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
		help: {
			usage: ['/init'],
			details: [
				'Asks the selected model to read the project and write instructions. Existing instructions are read before changes are proposed.',
			],
		},
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

/** The session's shell hooks, by event, in the order the config file gave them. */
export function renderHooks(hooks: HooksConfig | undefined): string {
	const events = Object.entries(hooks ?? {}).filter(([, entries]) => (entries?.length ?? 0) > 0)
	if (events.length === 0) {
		return 'No hooks. Add a `hooks` key to namzu.config.json or ~/.namzu/config.yaml: event → list of { command, matcher?, timeoutMs? }.'
	}
	const lines: string[] = []
	for (const [event, entries] of events) {
		lines.push(`${event}`)
		for (const entry of entries ?? []) {
			const when = entry.matcher ? ` · matches ${entry.matcher}` : ''
			const deadline =
				entry.timeoutMs !== undefined ? ` · ${Math.round(entry.timeoutMs / 1000)}s` : ''
			lines.push(`  ${entry.command}${when}${deadline}`)
		}
	}
	return lines.join('\n')
}

/** The session's background jobs, as an operator would ask about them. */
export function renderJobs(jobs: ReturnType<SlashContext['jobs']>): string {
	if (jobs.length === 0) {
		return 'No background jobs this session. The agent starts one with `run_in_background` on bash; under a sandbox none can be started.'
	}
	const lines = jobs.map((job) => {
		const state =
			job.status === 'running'
				? `running for ${Math.max(1, Math.round((Date.now() - job.startedAt) / 1000))}s`
				: job.status === 'killed'
					? 'stopped'
					: `exited ${job.exitCode ?? '?'}`
		return `${job.id}  ${state.padEnd(16)}  ${job.command}`
	})
	return [
		`${jobs.length} background job${jobs.length === 1 ? '' : 's'} this session:`,
		...lines,
		'',
		'The agent reads one with the job tool; ask it to stop one, or /exit stops them all.',
	].join('\n')
}

/** Reports validate their subcommand instead of silently ignoring mistyped arguments. */
function reportCommand(
	name: string,
	args: readonly string[],
	render: (details: boolean) => string,
	detailName = 'details',
): SlashAction {
	const option = args.join(' ').trim().toLowerCase()
	const details = option === detailName || option === 'details'
	return {
		kind: 'message',
		role: 'system',
		content: option.length === 0 || details ? render(details) : `Usage: /${name} [${detailName}]`,
	}
}

function contextMeasurement(usage: SlashContext['usage']): string[] {
	const context = usage?.context
	if (!context || context.windowTokens <= 0) return ['No context measurement yet.']
	const percent = Math.min(999, Math.round((context.tokens / context.windowTokens) * 100))
	const approx = context.measured && !context.windowAssumed ? '' : '~'
	return [
		`Context: ${context.tokens.toLocaleString('en-US')} / ${context.windowTokens.toLocaleString('en-US')} tokens (${approx}${percent}%)`,
		`${context.measured ? 'Counted by the provider' : 'Estimated by Namzu'}; window ${context.windowAssumed ? 'assumed from a table or default' : 'declared by the provider or config'}.`,
	]
}

export function renderContext(
	usage: SlashContext['usage'],
	compaction: CompactionSummary | null,
	details = false,
): string {
	const lines = contextMeasurement(usage)
	if (usage?.context) lines.push('Latest reported context size; not cumulative token usage.')
	if (!compaction) {
		lines.push('Automatic cleanup: unavailable before a session starts.')
	} else {
		lines.push(
			`Cleanup this session: ${compaction.passes} passes, ~${compaction.reclaimedTokens.toLocaleString('en-US')} tokens freed.`,
		)
		if (details) {
			const pct = (fraction: number) => `${Math.round(fraction * 100)}%`
			lines.push(`Strategy: ${compaction.strategy}`)
			if (compaction.strategy === 'salience') {
				lines.push(
					`Older, less useful content is shortened from ${pct(compaction.softTarget)} of the window; older history is summarised at ${pct(compaction.triggerThreshold)}.`,
				)
			} else {
				lines.push(
					`Older tool results are cleared at ${pct(compaction.triggerThreshold)} of the window; history is summarised if needed.`,
				)
			}
			lines.push(
				`Tool results cleared: ${compaction.clearedResults.toLocaleString('en-US')}`,
				`Messages shortened: ${compaction.stubbedNarrations.toLocaleString('en-US')}`,
				`Summaries written: ${compaction.summaries.toLocaleString('en-US')}`,
			)
		}
	}
	if (!details) lines.push('/context details for cleanup history.')
	return lines.join('\n')
}

/** Keep unknown prices distinct from measured zero, in status and cost alike. */
function costAmount(cost: CostInfo): string {
	if (cost.unpricedTokens > 0) {
		return cost.totalCost > 0 ? `at least $${cost.totalCost.toFixed(4)}` : 'not known'
	}
	return `$${cost.totalCost.toFixed(4)}${cost.totalCost === 0 ? ' (measured zero)' : ''}`
}

export function renderCost(
	usage: SlashContext['usage'],
	compaction: CompactionSummary | null = null,
	details = false,
): string {
	if (usage === null) return 'No usage reported yet. Send a message to begin.'
	const lines = [
		'Current or latest run',
		`Tokens: ${usage.totalTokens.toLocaleString('en-US')} (own model calls)`,
		`Cost: ${costAmount(usage.cost)}`,
	]
	if (usage.cost.unpricedTokens > 0) {
		lines.push(
			`${usage.cost.unpricedTokens.toLocaleString('en-US')} tokens have no known price and are excluded from the cost.`,
		)
	}
	if (usage.budget) {
		lines.push(
			`Including delegated agents: ${usage.budget.treeTokens.toLocaleString('en-US')} tokens; limit ${usage.budget.limit === 0 ? 'unlimited' : usage.budget.limit.toLocaleString('en-US')}.`,
		)
		if (usage.budget.poisoned)
			lines.push('Further spending is blocked until unresolved request usage is reconciled.')
	}
	if (details) {
		lines.push(
			'Cost covers this run’s own model calls, excluding delegated calls and earlier runs. These are not conversation totals.',
		)
		if (usage.cost.unpricedTokens > 0) {
			lines.push('Missing prices do not mean those tokens were free.')
		} else {
			lines.push('All reported tokens have a known rate.')
		}
		if (usage.cost.cacheDiscount > 0)
			lines.push(`Cache discount: $${usage.cost.cacheDiscount.toFixed(4)}`)
		if (usage.context && usage.context.windowTokens > 0) {
			lines.push('', ...contextMeasurement(usage), '/context details for automatic cleanup.')
		}
		if (compaction) lines.push(`Cleanup passes this session: ${compaction.passes}.`)
	} else {
		lines.push('/cost details for scope and pricing; /context for context size.')
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

export function renderMcp(mcp: ReturnType<SlashContext['mcp']>, details = false): string {
	if (mcp === null) return 'No session yet. Tool servers have not been checked.'
	if (mcp.connected.length === 0 && mcp.failed.length === 0) {
		return 'No tool servers configured. Add mcpServers to namzu.config.json.'
	}
	const lines = [
		`Tool servers: ${mcp.connected.length} connected, ${mcp.failed.length} unavailable.`,
	]
	for (const server of mcp.connected) {
		lines.push(`${server.name}: connected, ${server.tools.length} tools`)
		if (details) for (const tool of server.tools) lines.push(`  ${tool}`)
	}
	for (const server of mcp.failed) lines.push(`${server.name}: unavailable — ${server.reason}`)
	if (!details && mcp.connected.length > 0) lines.push('/mcp tools to list available tools.')
	return lines.join('\n')
}

export function renderStatus(ctx: SlashContext, details = false): string {
	const lines = [
		`Provider: ${ctx.providerSummary ?? 'none — run /model to choose one'}`,
		`Model: ${ctx.modelSummary ?? 'not selected'}`,
		`Working directory: ${ctx.cwd}`,
		...renderPermissions(ctx.permissions, details).split('\n'),
	]
	const sandbox = ctx.sandbox
	if (!sandbox) {
		lines.push('Sandbox: not resolved yet.')
	} else if (sandbox.unconfined) {
		lines.push('Sandbox: commands are not confined; they have this shell’s access.')
	} else {
		lines.push(
			`Sandbox: ${sandbox.environment ?? 'active'}; enforces ${sandbox.enforced.join(', ') || 'no reported restrictions'}.`,
		)
	}
	if (sandbox?.workspace === 'ephemeral') {
		lines.push('Workspace: temporary files; removed when the run ends.')
	} else if (sandbox?.workspace === 'working-directory' || sandbox?.workspace === 'host') {
		lines.push('Workspace: real project files; edits persist.')
	}
	if (details) {
		for (const dir of ctx.directories?.() ?? []) lines.push(`Additional directory: ${dir}`)
		if (sandbox) {
			lines.push(
				`Required isolation: ${sandbox.required.length > 0 ? sandbox.required.join(', ') : 'none'}.`,
			)
			if (sandbox.required.length > 0)
				lines.push('A host missing required isolation cannot start the session.')
		}
		lines.push('/status config for setting sources; /status tools for available tools.')
	}
	if (ctx.usage)
		lines.push(`Spend (current or latest run, own calls): ${costAmount(ctx.usage.cost)}`)
	if (!details) lines.push('/status details for rules and workspace details.')
	return lines.join('\n')
}

export function renderPermissions(
	permissions: SlashContext['permissions'],
	details = false,
): string {
	const current = permissions.currentMode()
	const effective = effectivePermissionMode(current.mode, permissions.approvalLatched())
	const approvedAll = effective !== current.mode
	const lines = [
		`Permissions: ${permissionModeLabel(effective)}. ${approvedAll ? 'Tools are approved automatically for this session.' : permissionModeDescription(effective)}`,
	]
	if (approvedAll) lines.push('Choose a preset in /permissions to change this.')
	if (!details) return lines.join('\n')
	if (current.source === 'launch-bypass')
		lines.push('Selected at launch with --dangerously-skip-permissions.')
	lines.push('Explicit deny rules and the built-in safety gate apply in every mode.')
	if (current.mode === 'plan')
		lines.push('Plan mode also blocks writes that an allow rule would otherwise permit.')
	const exempt = permissions.neverPrompted()
	if (exempt.length > 0) {
		lines.push(`Tools exempt from ordinary prompts: ${exempt.join(', ')}.`)
		lines.push(
			'Destructive calls still require review; the selected mode decides whether to allow, ask or refuse. Plan mode still requires read-only tools.',
		)
	}
	if (permissions.rules.length > 0) {
		lines.push(
			`Rules (${permissions.rules.length}):`,
			...permissions.rules.map((rule) => `  ${describeRule(rule)}`),
		)
	} else {
		lines.push('No custom rules. Configure permissions in namzu.config.json.')
	}
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
	if (cmd) {
		const commandContext = { ...ctx, builtins }
		const reason = cmd.unavailable?.(commandContext)
		return reason
			? { kind: 'message', role: 'system', content: reason }
			: cmd.action(commandContext, parsed.args)
	}

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
