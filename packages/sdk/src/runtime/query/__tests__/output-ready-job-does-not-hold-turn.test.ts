import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { WaitForJobTool } from '../../../tools/builtins/wait-for-job.js'
import { defineTool } from '../../../tools/defineTool.js'
import type {
	BackgroundJobOutputWaitOptions,
	BackgroundJobOutputWaitResult,
} from '../../../types/job/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry, type StartJobParams } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'

const StartTool = defineTool({
	name: 'start',
	description: 'starts a controlled server',
	inputSchema: z.object({}),
	category: 'shell',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: true,
	execute: async (_, context) => {
		const job = context.backgroundJobs!.start({
			command: 'synthetic server',
			workingDirectory: context.workingDirectory,
		})
		return { success: true, output: `started ${job.id}` }
	},
})

afterEach(() => vi.useRealTimers())

describe('output readiness expresses observation, not wait-until-exit intent', () => {
	it.each(['matched', 'timeout'] as const)(
		'lets the real query finish with a live session server after %s',
		async (expected) => {
			vi.useFakeTimers()
			const child = Object.assign(new EventEmitter(), {
				pid: undefined,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			})
			let notifyWaiting = () => {}
			const didWait = new Promise<void>((resolve) => {
				notifyWaiting = resolve
			})
			class ControlledJobs extends BackgroundJobRegistry {
				override start(params: StartJobParams) {
					const record = super.start({
						...params,
						spawn: () => ({ child: child as unknown as ReturnType<typeof spawn> }),
					})
					if (expected === 'matched') child.stdout.write('READY\n')
					return record
				}
				override waitForOutput(
					id: string,
					opts: BackgroundJobOutputWaitOptions,
				): Promise<BackgroundJobOutputWaitResult> {
					const observing = super.waitForOutput(id, opts)
					notifyWaiting()
					return observing
				}
			}
			const registry = new ControlledJobs()
			const sessionId = generateSessionId()
			const provider = new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'start', name: 'start', args: {} }] },
					{
						toolCalls: [
							{
								id: 'observe',
								name: 'wait_for_job',
								args: { id: 'job_1', output_contains: 'READY', timeout_ms: 10 },
							},
						],
					},
					{
						text:
							expected === 'matched'
								? 'The server printed its marker.'
								: 'The marker was not observed yet.',
					},
				],
			})
			const running = drainQuery({
				provider,
				toolsets: [testToolset(StartTool, WaitForJobTool)],
				agentId: 'readiness-fixture',
				agentName: 'Readiness fixture',
				messages: [
					{
						role: 'user',
						content:
							'Start the server, observe readiness once, then answer without waiting for its exit.',
					},
				],
				workingDirectory: process.cwd(),
				projectId: generateProjectId(),
				sessionId,
				tenantId: generateTenantId(),
				topicId: generateTopicId(),
				turnConfig: { model: 'mock', maxIterations: 5, tokenBudget: 200_000, timeoutMs: 30_000 },
				backgroundJobs: registry,
				backgroundJobOwner: sessionId,
			})
			await didWait
			if (expected === 'timeout') await vi.advanceTimersByTimeAsync(10)
			// Await the real completion; no timer race decides whether the turn settled.
			const result = await running
			expect(result.status).toBe('completed')
			expect(provider.requests).toHaveLength(3)
			expect(registry.get('job_1').status).toBe('running')
			expect(JSON.stringify(provider.requests[2])).toContain(
				expected === 'matched' ? 'Output marker observed' : 'wall timeout',
			)
			child.emit('close', 0, null)
		},
	)
})
