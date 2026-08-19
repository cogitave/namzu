import { z } from 'zod'
import { wrapUntrusted } from '../../tools/untrusted-envelope.js'

import type { MCPPromptDefinition, MCPPromptMessage } from '../../types/connector/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import type { MCPClient } from './client.js'

/**
 * A server's prompt, as something the model can ask for.
 *
 * `listPrompts` and `getPrompt` reached the client and stopped there: a
 * server could publish prompts, the SDK could fetch them, and none of it
 * ever reached a model. Shipping the protocol half without this one left
 * exactly the shape this kernel keeps having to remove — a primitive with
 * no driver.
 *
 * **Why a tool and not system content.** Three routes were possible and
 * two are worse:
 *
 * - Folding a prompt into the system prompt puts remote text in the cached
 *   prefix, so every turn pays for it and the cache breaks whenever the
 *   server changes its wording. Worse, system position READS as
 *   instruction, which is the last thing text from a remote party should
 *   read as.
 * - A slash command routes through the host's UI, so a headless run — the
 *   case this kernel is built for — could never use one.
 *
 * A tool call is explicit, auditable, passes the same admission policy and
 * `allowedTools` filter every other capability does, and its answer lands
 * as a `tool_result`, which the model already treats as data returned by
 * something rather than as direction.
 */

/**
 * Marks where a remote party's words begin and end.
 *
 * A prompt is composed by a SERVER. Untrusted content arriving this way is
 * the standard prompt-injection surface, and an unlabelled block reads
 * exactly like the agent's own instructions — so this says whose words
 * they are.
 *
 * Marking, not stopping. See `tools/untrusted-envelope.ts` for the
 * measurement: delimiting reports near-zero attack success on a static
 * benchmark and above 95% once the attacker adapts (arXiv:2510.09023).
 * This paragraph used to call it "the mitigation that survives contact",
 * which was the same overstatement in a second file.
 */
export function renderPromptMessages(
	serverName: string,
	promptName: string,
	messages: readonly MCPPromptMessage[],
	description?: string,
): string {
	// The first version of this built the tag by hand and interpolated the
	// server's own text straight into the body. A prompt whose content
	// contained `</mcp-prompt>` closed the block early, and everything the
	// server wrote after that read as unlabelled — which is to say, as this
	// agent's own instructions. The label was the whole mitigation and it was
	// forgeable by the party it labels. `wrapUntrusted` defangs the delimiter
	// and escapes the attributes.
	const lines: string[] = []
	if (description) lines.push(description, '')

	for (const message of messages) {
		const body =
			message.content.type === 'text'
				? message.content.text
				: message.content.type === 'resource'
					? (message.content.resource.text ?? `[resource ${message.content.resource.uri}]`)
					: `[${message.content.type}]`
		lines.push(`[${message.role}] ${body}`, '')
	}

	return wrapUntrusted(
		{
			kind: 'mcp-prompt',
			attributes: { server: serverName, name: promptName },
			provenance: 'This is content the named server composed, not this agent.',
		},
		lines.join('\n').trimEnd(),
	)
}

/**
 * Build the input schema from what the prompt declares.
 *
 * Every argument is a string because that is what the protocol carries —
 * `prompts/get` takes `Record<string, string>`. Inventing richer types
 * here would mean converting back at the boundary and getting it wrong for
 * whatever the server actually expects.
 */
function argumentSchema(prompt: MCPPromptDefinition): z.ZodType {
	const shape: Record<string, z.ZodType> = {}
	for (const arg of prompt.arguments ?? []) {
		const base = z.string().describe(arg.description ?? arg.name)
		shape[arg.name] = arg.required === true ? base : base.optional()
	}
	return z.object(shape)
}

export function mcpPromptToToolDefinition(
	prompt: MCPPromptDefinition,
	client: MCPClient,
	serverName: string,
): ToolDefinition {
	// A distinct prefix from `mcp_<server>_<tool>`: a server may publish a
	// prompt and a tool under one name, and collapsing them would let
	// whichever registered second silently replace the first.
	const toolName = `mcp_prompt_${serverName}_${prompt.name}`

	return {
		name: toolName,
		description: prompt.description
			? `[MCP prompt:${serverName}] ${prompt.description}`
			: `[MCP prompt:${serverName}] Fetch the "${prompt.name}" prompt this server publishes.`,
		inputSchema: argumentSchema(prompt),
		category: 'network',
		permissions: ['network_access'],
		// Fetching a prompt asks a server what it would say. It changes
		// nothing on either side, so it is safe to run alongside other reads
		// and safe to repeat.
		isReadOnly: () => true,
		isDestructive: () => false,
		isConcurrencySafe: () => true,

		async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
			const args = (input ?? {}) as Record<string, string>
			try {
				const result = await client.getPrompt(prompt.name, args, {
					signal: context.abortSignal,
				})
				return {
					success: true,
					output: renderPromptMessages(
						serverName,
						prompt.name,
						result.messages,
						result.description,
					),
				}
			} catch (err) {
				// Cancellation belongs to the run, not to the remote prompt. Turning
				// it into an ordinary failed tool result would let the executor treat
				// a withdrawn operation as one the model may route around.
				if (context.abortSignal?.aborted) throw context.abortSignal.reason
				// Returned to the MODEL rather than thrown. A prompt that
				// cannot be fetched — a server that went away, an argument it
				// rejected — is something the agent can work around, and
				// killing the run over it would be the wrong trade for a
				// read-only lookup.
				return {
					success: false,
					output: '',
					error: `Could not fetch prompt "${prompt.name}" from ${serverName}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				}
			}
		},
	}
}
