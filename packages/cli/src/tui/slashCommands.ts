/**
 * Slash command registry + parser. Pure logic — no React. Unit-tested.
 *
 * A command's `action` returns either a `system` message to push onto the
 * transcript, an `exit` signal, or `void` (no transcript change). The
 * caller (App) maps results onto state.
 *
 * `/cost`, `/permissions` and `/agents` are RENDERERS. Every number and rule
 * they print was already computed — the kernel emits usage on its own event,
 * the permission rules were compiled before the session opened, and the
 * delegate roster is decided when the subagent runtime is built. None of them
 * asks the model, recomputes anything, or reaches past what the session
 * already carries. A command that had to compute its own answer would be a
 * second source for a fact the kernel already owns, and the two would drift.
 */

import type { VerificationRule } from '@namzu/sdk'

import { type UserCommand, expandCommand } from '../user-commands/store.js'

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
	 * Drive a turn with text the command composed rather than the user typed.
	 *
	 * The kernel already does the work — reading the tree, writing the file —
	 * so a command that needs the agent asks it, instead of the CLI growing a
	 * second way to inspect a repository that would then disagree with the one
	 * the model uses.
	 */
	| { kind: 'prompt'; text: string }
	| { kind: 'none' }

export interface SlashContext {
	readonly availableTools: readonly string[]
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
	readonly usage: { readonly totalTokens: number; readonly costUsd: number } | null
	/** What the operator's config and flags decided about tool approval. */
	readonly permissions: {
		/** `--yolo` / `--dangerously-skip-permissions`. */
		readonly skipPermissions: boolean
		readonly rules: readonly VerificationRule[]
	}
	/**
	 * Delegate ids this session can dispatch to, empty when the delegation tool
	 * is not mounted.
	 */
	readonly agentIds: readonly string[]
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

	return [...SLASH_COMMANDS, ...own].filter((c) => c.name.startsWith(prefix))
}

/** Returns null when the line is not a slash command. */
export function parseSlash(line: string): ParsedSlash | null {
	const trimmed = line.trim()
	if (!trimmed.startsWith('/')) return null
	const [name, ...args] = trimmed.slice(1).split(/\s+/)
	if (!name) return null
	return { name, args }
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		name: 'help',
		description: 'Show available slash commands.',
		action: (ctx) => {
			const builtin = SLASH_COMMANDS.map((c) => `/${c.name.padEnd(12)} ${c.description}`)
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
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content:
				ctx.availableTools.length === 0
					? 'No tools registered yet — the agent session may still be connecting.'
					: `Registered tools (${ctx.availableTools.length}):\n  ${ctx.availableTools.join('\n  ')}`,
		}),
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
		name: 'cost',
		description: 'Show tokens and spend for this run.',
		action: (ctx) => ({ kind: 'message', role: 'system', content: renderCost(ctx.usage) }),
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
		name: 'agents',
		description: 'List the delegates this session can dispatch to.',
		action: (ctx) => ({ kind: 'message', role: 'system', content: renderAgents(ctx.agentIds) }),
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
	const cost =
		usage.costUsd > 0 ? `$${usage.costUsd.toFixed(4)}` : '$0.0000 (this provider reported no price)'
	return [
		`Tokens: ${usage.totalTokens.toLocaleString('en-US')}`,
		`Cost:   ${cost}`,
		'',
		'Cumulative for this run, across every turn. Not a measure of how full',
		'the context is — that is a different quantity and it goes down when the',
		'conversation is compacted, while this only ever grows.',
	].join('\n')
}

/** What decides a tool call, in the order it actually decides it. */
export function renderPermissions(permissions: SlashContext['permissions']): string {
	const lines: string[] = []

	lines.push(
		permissions.skipPermissions
			? 'Unreviewed calls: approved automatically (--dangerously-skip-permissions).'
			: 'Unreviewed calls: you are asked before they run.',
	)

	if (permissions.rules.length === 0) {
		lines.push('')
		lines.push('No rules configured. Add a [permissions] table to namzu.config.json')
		lines.push('to allow or deny tools by name without being asked each time.')
	} else {
		lines.push('')
		lines.push(`Rules (${permissions.rules.length}), from your config:`)
		for (const rule of permissions.rules) lines.push(`  ${describeRule(rule)}`)
	}

	lines.push('')
	// Stated because the precedence is the part people get wrong, and getting it
	// wrong in this direction is the dangerous one: assuming the flag lifts a
	// `deny` they wrote.
	lines.push('A rule decides first. The approval setting above only reaches calls')
	lines.push('no rule covered, so it can never reopen what a `deny` closed.')

	return lines.join('\n')
}

function describeRule(rule: VerificationRule): string {
	if (rule.type === 'deny_by_name') return `deny   ${rule.toolNames.join(', ')}`
	if (rule.type === 'allow_by_name') return `allow  ${rule.toolNames.join(', ')}`
	return rule.type
}

/** The delegate roster, and an honest answer when there is none. */
export function renderAgents(agentIds: readonly string[]): string {
	if (agentIds.length === 0) {
		return 'No delegates. This session has no delegation tool mounted, so it does the work itself.'
	}
	return [
		`Delegates (${agentIds.length}):`,
		...agentIds.map((id) => `  ${id}`),
		'',
		'The agent dispatches to these itself when a task suits one. It may also',
		'define a specialist for a single task, which is not listed here because',
		'it does not exist until the agent asks for it.',
	].join('\n')
}

export function runSlash(line: string, ctx: SlashContext): SlashAction | null {
	const parsed = parseSlash(line)
	if (!parsed) return null

	// Builtins first, always. A file appearing on disk must not take over a name
	// the TUI already answers to — `discoverUserCommands` marks those files with
	// a `problem` so their author is told, rather than leaving them to wonder
	// why the file never ran.
	const cmd = SLASH_COMMANDS.find((c) => c.name === parsed.name)
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
