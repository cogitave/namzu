import { wrapUntrusted } from '@namzu/sdk'
import { MCP_OUTPUT_CHARS, boundedMcpText } from './output.js'
import { validatePromptArguments } from './prompts.js'
import type { McpConnection } from './servers.js'

/** Host permission checks stay in the composition root, never in remote metadata. */
export interface McpPersonActions
	extends Pick<McpConnection, 'listPrompts' | 'getPrompt' | 'listResources' | 'readResource'> {
	servers(): readonly string[]
	authorize(
		server: string,
		kind: 'prompt' | 'resource' | 'list_prompts' | 'list_resources',
		name: string,
		input: Readonly<Record<string, unknown>>,
	): Promise<boolean>
}

type Outcome = { kind: 'message'; text: string } | { kind: 'prompt'; text: string }
export const MCP_PERSON_USAGE = [
	'/mcp prompts [server]',
	'/mcp prompt <server> <name> [argument=value ...]',
	'/mcp resources [server]',
	'/mcp resource <server> <uri>',
]

/** null delegates only the existing status/tools/details forms to their renderer. */
export async function mcpPersonCommand(
	args: readonly string[],
	actions: McpPersonActions | null | undefined,
): Promise<Outcome | null> {
	const [verb, server, name, ...values] = args
	if (!['prompts', 'prompt', 'resources', 'resource'].includes(verb ?? '')) return null
	const message = (text: string): Outcome => ({ kind: 'message', text })
	if (!actions) return message('MCP prompt and resource actions are not available in this session.')
	const listPrompts = async (selected?: string) =>
		(
			await Promise.all(
				actions
					.servers()
					.filter((item) => !selected || item === selected)
					.map(async (item) =>
						(await actions.authorize(item, 'list_prompts', 'list_prompts', {}))
							? actions.listPrompts(undefined, item)
							: [],
					),
			)
		).flat()
	const listResources = async (selected?: string) =>
		(
			await Promise.all(
				actions
					.servers()
					.filter((item) => !selected || item === selected)
					.map(async (item) =>
						(await actions.authorize(item, 'list_resources', 'list_resources', {}))
							? actions.listResources(undefined, item)
							: [],
					),
			)
		).flat()
	try {
		if (verb === 'prompts' || verb === 'resources') {
			if (args.length > 2) return message(MCP_PERSON_USAGE.join('\n'))
			const rows =
				verb === 'prompts'
					? (await listPrompts(server)).map(
							(item) =>
								`${JSON.stringify(item.server)} ${JSON.stringify(item.name)} ${(item.arguments ?? []).map((arg) => `${JSON.stringify(arg.name)}${arg.required ? ' (required)' : ' (optional)'}`).join(' ')}`,
						)
					: (await listResources(server)).map(
							(item) =>
								`${JSON.stringify(item.server)} ${JSON.stringify(item.uri)} ${JSON.stringify(item.name)}`,
						)
			return message(boundedMcpText(rows.join('\n') || `No admitted MCP ${verb} available.`))
		}
		if (!server || !name || (verb === 'resource' && values.length > 0)) {
			return message(MCP_PERSON_USAGE.join('\n'))
		}
		if (verb === 'prompt') {
			const parameters: Record<string, string> = Object.create(null)
			for (const value of values) {
				const equals = value.indexOf('=')
				if (equals <= 0) return message('Prompt arguments must use argument=value.')
				const key = value.slice(0, equals)
				if (Object.hasOwn(parameters, key))
					return message(`Duplicate prompt argument: ${JSON.stringify(key)}`)
				parameters[key] = value.slice(equals + 1)
			}
			const prompt = (await listPrompts(server)).find(
				(item) => item.server === server && item.name === name,
			)
			if (!prompt) return message('Prompt unavailable or not admitted by server policy.')
			try {
				validatePromptArguments(prompt, parameters)
			} catch (error) {
				return message(
					boundedMcpText(
						JSON.stringify(error instanceof Error ? error.message : 'Invalid prompt arguments'),
						1_000,
					),
				)
			}
			if (!(await actions.authorize(server, 'prompt', name, parameters)))
				return message('MCP prompt access denied.')
			return { kind: 'prompt', text: await actions.getPrompt(server, name, parameters) }
		}
		// Reuse exactly the mention resource listing/read boundary: no arbitrary
		// URL, unlisted URI, binary resource or second resource registry.
		if (!(await actions.authorize(server, 'resource', name, { uri: name })))
			return message('MCP resource access denied.')
		const resource = (await listResources(server)).find(
			(item) => item.server === server && item.uri === name,
		)
		if (!resource) return message('Resource unavailable or not admitted by server policy.')
		const text = await actions.readResource(server, name)
		if (text === null) return message('Resource unavailable or contains no text.')
		return {
			kind: 'prompt',
			text: wrapUntrusted(
				{
					kind: 'mcp-resource',
					attributes: { server, uri: name },
					provenance:
						'User-selected resource; its text came from the named server, not the person.',
				},
				boundedMcpText(text, MCP_OUTPUT_CHARS),
			),
		}
	} catch {
		// A server's error body may contain credentials or terminal controls.
		return message(
			'MCP request failed. Check the server connection, policy and prompt arguments; server error text was withheld.',
		)
	}
}
