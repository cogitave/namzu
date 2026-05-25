/**
 * Slash command registry + parser. Pure logic — no React. Unit-tested.
 *
 * A command's `action` returns either a `system` message to push onto the
 * transcript, an `exit` signal, or `void` (no transcript change). The
 * caller (App) maps results onto state.
 */

export type SlashAction =
	| { kind: 'message'; role: 'system'; content: string }
	| { kind: 'exit' }
	| { kind: 'clear' }
	| { kind: 'repick' }
	| { kind: 'remember'; text: string }
	| { kind: 'show-memory' }
	| { kind: 'list-skills' }
	| { kind: 'load-skill'; name: string }
	| { kind: 'none' }

export interface SlashContext {
	readonly availableTools: readonly string[]
	readonly providerSummary: string | null
	readonly modelSummary: string | null
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
		description: 'List tools the agent can call (builtins + clawtool).',
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
]

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
