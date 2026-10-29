import { randomUUID } from 'node:crypto'
import type { AuthorizationGate, ToolManager, ToolReviewPrompt } from '@namzu/sdk'
import type { McpPersonActions } from './person-commands.js'
import type { McpConnection } from './servers.js'

/** The same live registry, source and gate used by model calls; no mode bypass. */
export function mcpPersonActions(input: {
	readonly connection: McpConnection
	readonly manager: () => ToolManager
	readonly gate: () => AuthorizationGate
	readonly onPermission?: ToolReviewPrompt
	readonly signal?: AbortSignal
}): McpPersonActions {
	const { connection, signal } = input
	return {
		servers: () => connection.current().connected.map((server) => server.name),
		listPrompts: (requestedSignal, server) =>
			connection.listPrompts(requestedSignal ?? signal, server),
		getPrompt: (server, name, args, requestedSignal) =>
			connection.getPrompt(server, name, args, requestedSignal ?? signal),
		listResources: (requestedSignal, server) =>
			connection.listResources(requestedSignal ?? signal, server),
		readResource: (server, uri, requestedSignal) =>
			connection.readResource(server, uri, requestedSignal ?? signal),
		authorize: async (server, kind, name, toolInput) => {
			if (signal?.aborted) return false
			const manager = input.manager()
			const toolName =
				kind === 'prompt'
					? `mcp_prompt_${server}_${name}`
					: `mcp__${server}__${kind === 'resource' ? 'read_resource' : kind}`
			// Prompt listing has no model-facing tool. Borrow only the metadata
			// and provenance of this server's real list helper, not its name.
			const registeredName = kind === 'list_prompts' ? `mcp__${server}__list_resources` : toolName
			const registered = manager.get(registeredName)
			if (!registered || manager.availability(registeredName) === 'suspended') return false
			const toolSource = manager.sourceOf(registeredName)
			if (toolSource.kind !== 'mcp_server' || toolSource.server !== server) return false
			const toolDef = kind === 'list_prompts' ? { ...registered, name: toolName } : registered
			const verdict = input.gate().evaluate({ toolName, toolInput, toolDef, toolSource })
			if (verdict.decision === 'deny') return false
			if (verdict.decision === 'allow') return !signal?.aborted
			if (!input.onPermission) return false
			const answer = await input.onPermission({
				toolCalls: [
					{
						id: randomUUID(),
						name: toolName,
						input: toolInput,
						isDestructive: false,
						authorization: { decision: 'review', reason: verdict.reason },
					},
				],
				...(signal ? { signal } : {}),
			})
			// Approval is for this exact call only, never a session-wide grant.
			if (signal?.aborted || (answer.kind !== 'approve' && answer.kind !== 'approve-all'))
				return false
			if (input.manager().get(registeredName) !== registered) return false
			return input.gate().evaluate({ toolName, toolInput, toolDef, toolSource }).decision !== 'deny'
		},
	}
}

export async function listedMcpResources(actions: McpPersonActions, signal?: AbortSignal) {
	const lists = await Promise.all(
		actions
			.servers()
			.map(async (server) =>
				(await actions.authorize(server, 'list_resources', 'list_resources', {}))
					? actions.listResources(signal, server)
					: [],
			),
	)
	return lists.flat()
}

/** Shared permission boundary for mentions and the explicit resource command. */
export async function readMentionedMcpResource(
	actions: McpPersonActions,
	server: string,
	uri: string,
	signal?: AbortSignal,
) {
	if (!(await actions.authorize(server, 'resource', uri, { uri }))) return null
	if (!(await actions.authorize(server, 'list_resources', 'list_resources', {}))) return null
	const listed = await actions.listResources(signal, server)
	if (!listed.some((resource) => resource.uri === uri)) return null
	return actions.readResource(server, uri, signal)
}
