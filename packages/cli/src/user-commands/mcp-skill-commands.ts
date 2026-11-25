/**
 * The skills a tool server offers, as `/` commands.
 *
 * A server's skill body is read from the server when it is used, so the
 * command does not carry it: running `/server:skill` sends one line that asks
 * the model to load the skill with the `skill` tool, which reads, checks and
 * labels the body like any other use. A name another command holds is left to
 * that command, and a name the composer cannot type as one word (the
 * directory-qualified form has a `/`) stays reachable through the tool only.
 */

import { ARGUMENTS_TOKEN, type UserCommand } from './store.js'

/** Where these commands say they came from, so a refresh can replace exactly them. */
export const MCP_SKILL_COMMAND_PATH_PREFIX = 'mcp-skill:'

export interface McpSkillMenuItem {
	readonly name: string
	readonly description: string
}

export function mcpSkillCommands(items: readonly McpSkillMenuItem[]): UserCommand[] {
	return items
		.filter((item) => !/[\s/]/.test(item.name))
		.map((item) => ({
			name: item.name,
			description: item.description,
			path: `${MCP_SKILL_COMMAND_PATH_PREFIX}${item.name}`,
			source: 'skill' as const,
			argumentHint: '[what to use it for]',
			template: `Load the skill "${item.name}" with the skill tool and follow it for this: ${ARGUMENTS_TOKEN}`,
		}))
}

/** The commands with the server skills replaced by `items`; a name another command holds is not taken. */
export function withMcpSkillCommands(
	commands: readonly UserCommand[],
	items: readonly McpSkillMenuItem[],
): UserCommand[] {
	const own = commands.filter((command) => !command.path.startsWith(MCP_SKILL_COMMAND_PATH_PREFIX))
	const held = new Set(own.map((command) => command.name))
	const added = mcpSkillCommands(items).filter((command) => !held.has(command.name))
	return [...own, ...added].sort((a, b) => a.name.localeCompare(b.name))
}
