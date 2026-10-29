import {
	AuthorizationGate,
	type AuthorizationRule,
	NOOP_LOGGER,
	type ToolDefinition,
	type ToolManager,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { cliGate } from '../../../permissions/read-only-gate.js'
import {
	listedMcpResources,
	mcpPersonActions,
	readMentionedMcpResource,
} from '../person-session.js'
import type { McpConnection } from '../servers.js'

function fixture(rules: readonly AuthorizationRule[], review = false) {
	const list = {
		name: 'mcp__docs__list_resources',
		category: 'network',
		isReadOnly: () => true,
	} as unknown as ToolDefinition
	const read = { ...list, name: 'mcp__docs__read_resource' }
	const prompt = { ...list, name: 'mcp_prompt_docs_review' }
	const tools = new Map([list, read, prompt].map((tool) => [tool.name, tool]))
	const manager = {
		get: (name: string) => tools.get(name),
		availability: () => 'deferred',
		sourceOf: () => ({
			id: 'mcp:docs',
			kind: 'mcp_server',
			server: 'docs',
			readOnlyHintTrusted: false,
		}),
	} as unknown as ToolManager
	const connection = {
		current: () => ({ connected: [{ name: 'docs' }], failed: [], pending: [] }),
		listResources: vi.fn(async () => [{ server: 'docs', uri: 'docs://guide', name: 'guide' }]),
		readResource: vi.fn(async () => 'guide'),
		listPrompts: vi.fn(async () => []),
		getPrompt: vi.fn(async () => 'prompt'),
	} as unknown as McpConnection
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	const actions = mcpPersonActions({
		connection,
		manager: () => manager,
		gate: () => new AuthorizationGate(cliGate(rules), NOOP_LOGGER),
		...(review ? { onPermission } : {}),
	})
	return { actions, connection, onPermission }
}

describe('wave-2b MCP person-facing permission boundary', () => {
	it('source deny blocks discovery and reads without asking', async () => {
		const { actions, connection, onPermission } = fixture(
			[{ type: 'by_source', sources: ['mcp:docs'], decision: 'deny' }],
			true,
		)
		expect(await listedMcpResources(actions)).toEqual([])
		expect(await readMentionedMcpResource(actions, 'docs', 'docs://guide')).toBeNull()
		expect(connection.listResources).not.toHaveBeenCalled()
		expect(connection.readResource).not.toHaveBeenCalled()
		expect(onPermission).not.toHaveBeenCalled()
	})

	it('exact URI and prompt argument denies run before a source allowance', async () => {
		const { actions } = fixture([
			{
				type: 'argument_pattern',
				toolNames: ['mcp__docs__read_resource'],
				argument: 'uri',
				pattern: '^secret:',
				decision: 'deny',
			},
			{
				type: 'argument_pattern',
				toolNames: ['mcp_prompt_docs_review'],
				argument: 'topic',
				pattern: '^private$',
				decision: 'deny',
			},
			{ type: 'by_source', sources: ['mcp:docs'], decision: 'allow' },
		])
		expect(await actions.authorize('docs', 'resource', 'secret://x', { uri: 'secret://x' })).toBe(
			false,
		)
		expect(await actions.authorize('docs', 'prompt', 'review', { topic: 'private' })).toBe(false)
		expect(await actions.authorize('docs', 'prompt', 'review', { topic: 'public' })).toBe(true)
	})

	it('has no bypass-mode shortcut: explicit asks fail closed without a reviewer', async () => {
		const rules: AuthorizationRule[] = [
			{ type: 'by_source', sources: ['mcp:docs'], decision: 'review' },
		]
		expect(
			await fixture(rules).actions.authorize('docs', 'resource', 'docs://guide', {
				uri: 'docs://guide',
			}),
		).toBe(false)
		const { actions, onPermission } = fixture(rules, true)
		expect(
			await actions.authorize('docs', 'resource', 'docs://guide', { uri: 'docs://guide' }),
		).toBe(true)
		expect(onPermission).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCalls: [
					expect.objectContaining({
						name: 'mcp__docs__read_resource',
						input: { uri: 'docs://guide' },
					}),
				],
			}),
		)
	})

	it('uses the real source for the non-model list_prompts permission name', async () => {
		const { actions, onPermission } = fixture(
			[{ type: 'by_source', sources: ['mcp:docs'], decision: 'review' }],
			true,
		)
		expect(await actions.authorize('docs', 'list_prompts', 'list_prompts', {})).toBe(true)
		expect(onPermission).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCalls: [expect.objectContaining({ name: 'mcp__docs__list_prompts', input: {} })],
			}),
		)
	})

	it('mentions use the same gate and only fetch listed URIs', async () => {
		const { actions, connection } = fixture([
			{ type: 'by_source', sources: ['mcp:docs'], decision: 'allow' },
		])
		expect(await readMentionedMcpResource(actions, 'docs', 'docs://unlisted')).toBeNull()
		expect(connection.readResource).not.toHaveBeenCalled()
		expect(await readMentionedMcpResource(actions, 'docs', 'docs://guide')).toBe('guide')
		expect(connection.listResources).toHaveBeenCalledWith(undefined, 'docs')
	})
})
