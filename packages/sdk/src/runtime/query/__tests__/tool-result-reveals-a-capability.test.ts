import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * `ToolResult.reveals`: the same activation `search_tools` performs
 * (`ToolRegistry.activate`), offered to any tool's own result — a "connect
 * to project X" call whose further tools should appear only once the
 * connection is made, rather than be found by lexical search or exposed
 * eagerly. See `types/tool/index.ts`'s `reveals` doc and
 * `runtime/query/executor.ts`'s finalize step.
 */

function registerOpenDoorTool(tools: ToolRegistry, reveals: readonly string[]): void {
	tools.register({
		name: 'open_door',
		description: 'Open the door to a room.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'opened', reveals }),
	})
}

function registerDeferredRoomTool(tools: ToolRegistry, name = 'room_tool'): void {
	tools.register(
		{
			name,
			description: 'Do something inside the room.',
			inputSchema: z.object({}),
			execute: async () => ({ success: true, output: 'done inside' }),
		},
		'deferred',
	)
}

async function runOpenDoor(
	tools: ToolRegistry,
	turns: readonly MockTurn[],
	allowedTools?: string[],
): Promise<{ provider: MockLLMProvider; status: string }> {
	const provider = new MockLLMProvider({ turns: [...turns] })
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-reveals-'))
	const run = await drainQuery({
		provider,
		tools,
		...(allowedTools ? { allowedTools } : {}),
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations: 5,
			maxResponseTokens: 256,
		},
		agentId: 'agent_test',
		agentName: 'Test Agent',
		messages: [createUserMessage('open the door and use what is inside')],
		workingDirectory,
		sessionId: '9d9c6b0e-6f1a-4e0e-9f2d-6b0c1a2d3e4f' as SessionId,
		topicId: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f' as TopicId,
		projectId: 'f1e2d3c4-b5a6-4978-8877-665544332211' as ProjectId,
		tenantId: 'a1b2c3d4-e5f6-4708-9900-aabbccddeeff' as TenantId,
	})
	return { provider, status: run.status }
}

describe('ToolResult.reveals activates a curated capability', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('activates a deferred name so the very next turn can call it', async () => {
		const tools = new ToolRegistry()
		registerOpenDoorTool(tools, ['room_tool'])
		registerDeferredRoomTool(tools)

		const { provider, status } = await runOpenDoor(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ toolCalls: [{ id: 'b', name: 'room_tool', args: {} }] },
			{ text: 'done' },
		])

		expect(status).toBe('completed')
		expect(tools.getAvailability('room_tool')).toBe('active')
		// The second request — issued right after `open_door`'s result — already
		// offers `room_tool`, proving activation happened at finalize, not on
		// some later pass.
		const secondRequestTools = provider.requests[1]?.tools?.map((t) => t.function.name) ?? []
		expect(secondRequestTools).toContain('room_tool')
	})

	it('does not activate a revealed name outside a narrowed allowedTools', async () => {
		const tools = new ToolRegistry()
		registerOpenDoorTool(tools, ['room_tool'])
		registerDeferredRoomTool(tools)

		const { status } = await runOpenDoor(
			tools,
			[{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] }, { text: 'done' }],
			['open_door'],
		)

		expect(status).toBe('completed')
		// Outside the turn's allow-list: still deferred, never made callable,
		// no matter what the tool's own result claimed.
		expect(tools.getAvailability('room_tool')).toBe('deferred')
	})

	it('silently ignores an unknown or misspelled name, without throwing or failing the call', async () => {
		const tools = new ToolRegistry()
		registerOpenDoorTool(tools, ['no_such_tool'])

		const { status } = await runOpenDoor(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ text: 'done' },
		])

		// Completed, not aborted or errored — a stale/misspelled name in
		// `reveals` never reaches `activate()`'s `getOrThrow`.
		expect(status).toBe('completed')
		expect(tools.has('no_such_tool')).toBe(false)
	})

	it('does not resurrect a tool a host suspended', async () => {
		const tools = new ToolRegistry()
		registerOpenDoorTool(tools, ['room_tool'])
		tools.register(
			{
				name: 'room_tool',
				description: 'Do something inside the room.',
				inputSchema: z.object({}),
				execute: async () => ({ success: true, output: 'done inside' }),
			},
			'active',
		)
		tools.suspendAll()
		expect(tools.getAvailability('room_tool')).toBe('suspended')

		const { status } = await runOpenDoor(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ text: 'done' },
		])

		expect(status).toBe('completed')
		expect(tools.getAvailability('room_tool')).toBe('suspended')
	})
})
