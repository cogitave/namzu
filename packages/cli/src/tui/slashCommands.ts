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
export function matchSlashCommands(value: string): SlashCommand[] {
	const m = /^\/([\w-]*)$/.exec(value)
	if (!m) return []
	const prefix = (m[1] ?? '').toLowerCase()
	return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix))
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
		action: () => ({
			kind: 'message',
			role: 'system',
			content: SLASH_COMMANDS.map((c) => `/${c.name.padEnd(10)} ${c.description}`).join('\n'),
		}),
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
]

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
	const cmd = SLASH_COMMANDS.find((c) => c.name === parsed.name)
	if (!cmd) {
		return {
			kind: 'message',
			role: 'system',
			content: `Unknown command: /${parsed.name}. Try /help.`,
		}
	}
	return cmd.action(ctx, parsed.args)
}
