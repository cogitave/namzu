import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { BidiRunEvent } from '../../../types/bidi/index.js'
import { createMockBidiProvider } from '../mock.js'
import { startBidiRun } from '../session.js'

/**
 * Every other seam in this kernel is turn-based by construction: a run
 * has iterations, an iteration sends a complete message list and reads a
 * stream back, and a checkpoint is taken between two of them. A duplex
 * session has none of those boundaries — input keeps arriving while
 * output is still being produced — so the two properties that matter
 * here do not exist in the turn-based path at all: a tool must not stall
 * the stream, and an interruption must invalidate work in flight.
 */

function slowTool(name: string, gate: Promise<void>) {
	return defineTool({
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => {
			await gate
			return { success: true, output: `${name} finished` }
		},
	})
}

function open(gate?: Promise<void>) {
	const tools = new ToolRegistry()
	tools.register(slowTool('lookup', gate ?? Promise.resolve()))
	const provider = createMockBidiProvider()
	return { tools, provider }
}

const collectEvents = async (run: { events(): AsyncIterable<BidiRunEvent> }, until: number) => {
	const seen: BidiRunEvent[] = []
	for await (const event of run.events()) {
		seen.push(event)
		if (seen.length >= until) break
	}
	return seen
}

describe('a session with no turn boundary', () => {
	it('carries the model text through', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'text', text: 'hello there' })
		const seen = await collectEvents(run, 1)

		expect(seen[0]).toMatchObject({ type: 'text', text: 'hello there' })
		await run.close()
	})

	it('answers a tool call on the same session', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const seen = await collectEvents(run, 2)

		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'tool_completed'])
		expect(provider.session()?.sent).toContainEqual({
			toolResult: 't1',
			output: 'lookup finished',
			isError: false,
		})
		await run.close()
	})

	it('keeps delivering model output while a tool is still running', async () => {
		// The property the turn-based loop never needs: awaiting a tool
		// inline would stall the very stream an interruption arrives on.
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const { tools, provider } = open(gate)
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		provider.session()?.push({ type: 'text', text: 'still talking' })

		const seen = await collectEvents(run, 2)
		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'text'])

		release?.()
		await run.close()
	})

	it('abandons a tool answer when the human speaks over the model', async () => {
		// Delivering it would put a stale answer into a conversation that
		// has moved on.
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const { tools, provider } = open(gate)
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		provider.session()?.push({ type: 'interrupted' })
		release?.()

		const seen = await collectEvents(run, 3)
		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'interrupted', 'tool_abandoned'])
		// Nothing was sent back for it.
		expect(provider.session()?.sent).toEqual([])
		await run.close()
	})

	it('answers a tool that finished before the interruption', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const seen = await collectEvents(run, 2)
		provider.session()?.push({ type: 'interrupted' })

		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'tool_completed'])
		expect(provider.session()?.sent).toHaveLength(1)
		await run.close()
	})

	it('reports a tool failure rather than dropping it', async () => {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'lookup',
				description: 'lookup',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: false, output: '', error: 'the lookup failed' }),
			}),
		)
		const provider = createMockBidiProvider()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const seen = await collectEvents(run, 2)

		expect(seen[1]).toMatchObject({ type: 'tool_completed', isError: true })
		expect(provider.session()?.sent).toContainEqual({
			toolResult: 't1',
			output: 'the lookup failed',
			isError: true,
		})
		await run.close()
	})

	it('stops reading a driver that keeps talking after it hung up', async () => {
		// A driver that says it closed and then carries on is misbehaving,
		// and a loop that kept forwarding would hand a consumer output from
		// a session it was told had ended.
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'closed' })
		provider.session()?.push({ type: 'text', text: 'still here' })

		const seen: BidiRunEvent[] = []
		for await (const event of run.events()) seen.push(event)

		expect(seen.map((e) => e.type)).toEqual(['closed'])
	})

	it('ends the event stream when the far side closes', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'closed', reason: 'the far side hung up' })

		const seen: BidiRunEvent[] = []
		for await (const event of run.events()) seen.push(event)

		expect(seen).toEqual([{ type: 'closed', runId: run.runId, reason: 'the far side hung up' }])
	})
})
