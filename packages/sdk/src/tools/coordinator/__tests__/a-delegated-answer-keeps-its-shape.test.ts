/**
 * A schema-configured child answers with an OBJECT, and both delegation
 * surfaces used to hand the parent its prose instead.
 *
 * The value was never missing — `Run.structuredOutput` has carried it
 * throughout, and the eval harness reads it correctly, which is the proof the
 * parser works and only the ergonomic boundaries drop it. A supervisor fanning
 * out to five specialists received five strings and had to make the model
 * re-parse what it had just caused to be serialized.
 *
 * Both surfaces are driven because that is this file's whole subject: the
 * sibling comment in `coordinator/index.ts` records what happened last time a
 * rule lived at one delegation site only — `create_task` shipped without the
 * success check that `Agent` already had, because a review caught one site and
 * nothing carried the answer to the other.
 */

import { describe, expect, it } from 'vitest'

import type { TaskGateway, TaskHandle } from '../../../types/agent/gateway.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import { buildAgentTool } from '../agent.js'
import { buildCoordinatorTools } from '../index.js'

const taskId = 'task_child' as TaskId

/** The serialized form the child's structured answer must reach the parent as. */
const SERIALIZED = JSON.stringify({ orderId: 'A-1', refunded: true, amountUsd: 42 })

function makeContext(): ToolContext {
	return {
		runId: 'run_parent' as never,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** A child that finished, carrying both a prose result and a structured one. */
function completedChild(over: Partial<Record<string, unknown>> = {}): TaskHandle {
	return {
		taskId,
		agentId: 'refunds',
		createdAt: 0,
		completedAt: 1,
		state: 'completed',
		result: {
			status: 'completed',
			// Prose the model happened to emit earlier in the child's run. Before
			// this change it was what the parent received.
			result: 'I have finished looking into the refund.',
			structuredOutput: { orderId: 'A-1', refunded: true, amountUsd: 42 },
			...over,
		},
	} as unknown as TaskHandle
}

function fakeGateway(completed: TaskHandle): TaskGateway {
	return {
		async createTask() {
			return completed
		},
		async waitForTask() {
			return completed
		},
		async continueTask() {},
		cancelTask() {},
		getTask() {
			return completed
		},
		listTasks() {
			return [completed]
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

const AGENT_CONFIG = { workingDirectory: '/tmp/test', allowedAgentIds: ['refunds'] }

describe('the Agent tool returns the child’s structured answer', () => {
	it('hands the parent the object, not the prose beside it', async () => {
		const tool = buildAgentTool({
			gateway: fakeGateway(completedChild()),
			...AGENT_CONFIG,
		})

		const out = await tool.execute(
			{ description: 'refund', prompt: 'refund order A-1', subagent_type: 'refunds' },
			makeContext(),
		)

		expect(out.success).toBe(true)
		// Read INSIDE the untrusted envelope. A delegated answer is framed before
		// it reaches the parent model — which is correct and predates this change
		// — so the payload is what this file is about, not the wrapper.
		expect(out.output).toContain(SERIALIZED)
		// The prose is not what the parent is told. Asserting its ABSENCE is the
		// half that fails against the old behaviour — a test that only checked
		// the object was parseable would pass on a string that contained both.
		expect(out.output).not.toContain('finished looking into')
	})

	it('still returns prose for a child with no schema', async () => {
		// The preservation case. A rule that preferred the structured value
		// unconditionally would return an empty string for every ordinary child.
		const tool = buildAgentTool({
			gateway: fakeGateway(completedChild({ structuredOutput: undefined })),
			...AGENT_CONFIG,
		})

		const out = await tool.execute(
			{ description: 'refund', prompt: 'refund order A-1', subagent_type: 'refunds' },
			makeContext(),
		)

		expect(out.success).toBe(true)
		expect(out.output).toContain('I have finished looking into the refund.')
	})
})

describe('the task tools return the child’s structured answer', () => {
	function taskTool(name: string, completed: TaskHandle): ToolDefinition {
		const tools = buildCoordinatorTools({
			gateway: fakeGateway(completed),
			...AGENT_CONFIG,
		} as never)
		const found = tools.find((t) => t.name === name)
		if (!found) throw new Error(`no ${name} tool in the coordinator set`)
		return found
	}

	it('create_task hands the parent the object', async () => {
		const tool = taskTool('create_task', completedChild())

		const out = await tool.execute(
			{ agent_id: 'refunds', prompt: 'refund order A-1', description: 'refund' } as never,
			makeContext(),
		)

		expect(out.output).toContain(SERIALIZED)
		expect(out.output).not.toContain('finished looking into')
	})

	it('create_task still returns prose for a child with no schema', async () => {
		const tool = taskTool('create_task', completedChild({ structuredOutput: undefined }))

		const out = await tool.execute(
			{ agent_id: 'refunds', prompt: 'refund order A-1', description: 'refund' } as never,
			makeContext(),
		)

		expect(out.output).toContain('I have finished looking into the refund.')
	})
})
