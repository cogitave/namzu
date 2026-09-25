import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { Toolset } from '../../../toolsets/types.js'
import { deferred, filtered, readyWhen } from '../../../toolsets/wrappers.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

/**
 * `ToolResult.reveals` loads deferred schemas through the same receipt path
 * as `search_tools`. A host-owned readiness check is a separate prerequisite
 * for a connection-dependent tool. See `types/tool/index.ts` and
 * `runtime/query/executor.ts`'s finalize step.
 */

function openDoorTool(reveals: readonly string[]): ToolDefinition {
	return {
		name: 'open_door',
		description: 'Open the door to a room.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'opened', reveals }),
	}
}

function roomTool(name = 'room_tool'): ToolDefinition {
	return {
		name,
		description: 'Do something inside the room.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'done inside' }),
	}
}

function doorAndRoom(reveals: readonly string[]): readonly Toolset[] {
	return [testToolset(openDoorTool(reveals)), deferred(testToolset(roomTool()))]
}

async function runOpenDoor(
	tools: readonly Toolset[],
	turns: readonly MockTurn[],
	allowedTools?: string[],
): Promise<{ provider: MockLLMProvider; status: string }> {
	const provider = new MockLLMProvider({ turns: [...turns] })
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-reveals-'))
	const run = await drainQuery({
		provider,
		toolsets: tools,
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

async function runOpenDoorWithMessages(
	tools: readonly Toolset[],
	turns: readonly MockTurn[],
): Promise<{ status: string; messages: readonly Message[] }> {
	const provider = new MockLLMProvider({ turns: [...turns] })
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-reveals-'))
	const run = await drainQuery({
		provider,
		toolsets: tools,
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
	return { status: run.status, messages: run.messages }
}

describe('ToolResult.reveals activates a curated capability', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('activates a deferred name so the very next turn can call it', async () => {
		const tools = doorAndRoom(['room_tool'])

		const { provider, status } = await runOpenDoor(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ toolCalls: [{ id: 'b', name: 'room_tool', args: {} }] },
			{ text: 'done' },
		])

		expect(status).toBe('completed')
		expect(new ToolManager({ toolsets: tools, messages: () => [] }).availability('room_tool')).toBe(
			'deferred',
		)
		// The second request — issued right after `open_door`'s result — already
		// offers `room_tool`, proving activation happened at finalize, not on
		// some later pass.
		const secondRequestTools = provider.requests[1]?.tools?.map((t) => t.function.name) ?? []
		expect(secondRequestTools).toContain('room_tool')
	})

	it('also persists the revealed name on the tool message, for ToolManager.availability to derive from', async () => {
		const tools = doorAndRoom(['room_tool'])

		const { status, messages } = await runOpenDoorWithMessages(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ toolCalls: [{ id: 'b', name: 'room_tool', args: {} }] },
			{ text: 'done' },
		])

		expect(status).toBe('completed')
		const openDoorResult = messages.find((m) => m.role === 'tool' && m.toolCallId === 'a')
		expect(openDoorResult?.role).toBe('tool')
		expect(
			openDoorResult && 'revealedTools' in openDoorResult
				? openDoorResult.revealedTools
				: undefined,
		).toEqual([{ name: 'room_tool', sourceId: 'test', sourceKind: 'host_tool' }])
		expect(
			new ToolManager({
				toolsets: tools,
				messages: () => messages,
			}).availability('room_tool'),
		).toBe('active')
	})

	it('does not activate a revealed name outside a narrowed allowedTools', async () => {
		const tools = doorAndRoom(['room_tool'])

		const { status, provider } = await runOpenDoor(
			tools,
			[{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] }, { text: 'done' }],
			['open_door'],
		)

		expect(status).toBe('completed')
		// Outside the turn's allow-list: still deferred, never made callable,
		// no matter what the tool's own result claimed.
		expect(provider.requests[1]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'room_tool',
		)
	})

	it('keeps a connected capability out of search until the host reports ready', async () => {
		let connected = false
		let entered = false
		const connector: ToolDefinition = {
			...openDoorTool(['room_tool']),
			async execute() {
				connected = true
				return { success: true, output: 'connected', reveals: ['room_tool'] }
			},
		}
		const room: ToolDefinition = {
			...roomTool(),
			async execute() {
				entered = true
				return { success: true, output: 'entered' }
			},
		}
		const tools = [testToolset(connector), readyWhen(deferred(testToolset(room)), () => connected)]
		const { provider, status } = await runOpenDoor(tools, [
			{
				toolCalls: [{ id: 's', name: 'search_tools', args: { query: 'room_tool' } }],
			},
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ toolCalls: [{ id: 'b', name: 'room_tool', args: {} }] },
			{ text: 'done' },
		])
		expect(status).toBe('completed')
		expect(entered).toBe(true)
		expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'room_tool',
		)
		expect(provider.requests[1]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'room_tool',
		)
		expect(provider.requests[2]?.tools?.map((tool) => tool.function.name)).toContain('room_tool')
	})

	it('does not make a deferred tool callable when its revealing call fails', async () => {
		const failingDoor: ToolDefinition = {
			...openDoorTool(['room_tool']),
			execute: async () => ({
				success: false,
				output: 'offline',
				error: 'offline',
				reveals: ['room_tool'],
			}),
		}
		const tools = [testToolset(failingDoor), deferred(testToolset(roomTool()))]
		const { status, messages } = await runOpenDoorWithMessages(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ text: 'done' },
		])
		expect(status).toBe('completed')
		expect(messages.find((message) => message.role === 'tool')?.revealedTools).toBeUndefined()
		expect(
			new ToolManager({
				toolsets: tools,
				messages: () => messages,
			}).availability('room_tool'),
		).toBe('deferred')
	})

	it('silently ignores an unknown or misspelled name, without throwing or failing the call', async () => {
		const tools = [testToolset(openDoorTool(['no_such_tool']))]

		const { status } = await runOpenDoor(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ text: 'done' },
		])

		// Completed, not aborted or errored — a stale/misspelled name in
		// `reveals` never makes the unknown name callable.
		expect(status).toBe('completed')
		expect(new ToolManager({ toolsets: tools, messages: () => [] }).has('no_such_tool')).toBe(false)
	})

	it('does not resurrect a tool the host filtered out', async () => {
		const tools = [
			testToolset(openDoorTool(['room_tool'])),
			filtered(deferred(testToolset(roomTool())), () => false),
		]
		expect(tools[1]?.tools()).toEqual([])

		const { status, provider } = await runOpenDoor(tools, [
			{ toolCalls: [{ id: 'a', name: 'open_door', args: {} }] },
			{ text: 'done' },
		])

		expect(status).toBe('completed')
		expect(provider.requests[1]?.tools?.map((tool) => tool.function.name)).not.toContain(
			'room_tool',
		)
	})
})
