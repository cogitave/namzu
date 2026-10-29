import { type MCPClient, MCPToolDiscovery, renderPromptMessages } from '@namzu/sdk'
import { MCP_OUTPUT_CHARS, boundedMcpText } from './output.js'
import type { McpServerSpec } from './servers.js'

export interface McpPromptListing {
	readonly server: string
	readonly name: string
	readonly description?: string
	readonly arguments?: readonly { name: string; description?: string; required?: boolean }[]
}

export function validatePromptArguments(
	prompt: McpPromptListing,
	args: Readonly<Record<string, string>>,
): void {
	const declared = new Set((prompt.arguments ?? []).map((arg) => arg.name))
	for (const [name, value] of Object.entries(args)) {
		if (!declared.has(name)) throw new Error(`Unknown prompt argument: ${name}`)
		if (typeof value !== 'string') throw new Error(`Prompt argument ${name} must be a string`)
	}
	for (const arg of prompt.arguments ?? []) {
		if (arg.required && (!Object.hasOwn(args, arg.name) || args[arg.name] === '')) {
			throw new Error(`Missing required prompt argument: ${arg.name}`)
		}
	}
}

export function promptsOf(client: MCPClient, server: string, spec: McpServerSpec) {
	const discovery = new MCPToolDiscovery([client], {
		policies: { [server]: { allow: spec.allow, deny: spec.deny } },
	})
	const list = async (signal?: AbortSignal): Promise<readonly McpPromptListing[]> => {
		signal?.throwIfAborted()
		if (client.getState().status !== 'connected') return []
		const prompts = await discovery.discoverPromptsFrom(client)
		signal?.throwIfAborted()
		return prompts.map((prompt) => ({ ...prompt, server }))
	}
	return {
		list,
		get: async (
			name: string,
			args: Record<string, string>,
			signal?: AbortSignal,
		): Promise<string> => {
			const prompt = (await list(signal)).find((item) => item.name === name)
			if (!prompt) throw new Error('Prompt unavailable or not admitted by server policy.')
			validatePromptArguments(prompt, args)
			const result = await client.getPrompt(name, args, signal ? { signal } : undefined)
			// Bound before rendering, not after: truncation must not cut off the
			// untrusted envelope. Never fetch resource links, URLs or binary data.
			let left = MCP_OUTPUT_CHARS - 100
			const messages: typeof result.messages = []
			for (const message of result.messages) {
				if (left <= 32) break
				if (message.role !== 'user' && message.role !== 'assistant')
					throw new Error('Invalid prompt role')
				const content = message.content
				const text =
					content.type === 'text'
						? content.text
						: content.type === 'resource'
							? (content.resource.text ?? '[Non-text embedded resource omitted]')
							: '[Non-text prompt content omitted]'
				const bounded = boundedMcpText(text, left)
				left -= bounded.length + 32
				messages.push({ role: message.role, content: { type: 'text', text: bounded } })
			}
			if (messages.length < result.messages.length) {
				messages.push({
					role: 'user',
					content: {
						type: 'text',
						text: '[Additional MCP prompt messages omitted: aggregate limit reached.]',
					},
				})
			}
			return renderPromptMessages(server, name, messages)
		},
	}
}
