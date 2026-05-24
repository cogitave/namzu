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
		description: 'List tools currently registered (from the clawtool plugin).',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content:
				ctx.availableTools.length === 0
					? 'No tools registered. Is `clawtool` installed and on your PATH?'
					: `Registered tools (${ctx.availableTools.length}):\n  ${ctx.availableTools.join('\n  ')}`,
		}),
	},
	{
		name: 'provider',
		description: 'Show the current provider + model.',
		action: (ctx) => ({
			kind: 'message',
			role: 'system',
			content:
				ctx.providerSummary === null
					? 'No provider configured. Run `namzu providers add <name> --type … --api-key … --default`.'
					: `Provider: ${ctx.providerSummary}${ctx.modelSummary ? `\nModel: ${ctx.modelSummary}` : ''}`,
		}),
	},
	{
		name: 'model',
		description: 'Alias of /provider for now (model picker lands in M4).',
		action: (ctx) =>
			SLASH_COMMANDS.find((c) => c.name === 'provider')?.action(ctx, []) ?? { kind: 'none' },
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
