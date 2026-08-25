import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type ProjectId,
	RunCancelled,
	type SessionId,
	type StreamChunk,
	type TenantId,
	ToolRegistry,
	type TopicId,
	cancelCauseOf,
	createUserMessage,
	drainQuery,
	getBuiltinTools,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createSubagentRuntime } from '../runtime.js'

interface Deferred<T> {
	readonly promise: Promise<T>
	resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void
	return {
		promise: new Promise<T>((settle) => {
			resolve = settle
		}),
		resolve,
	}
}

describe('a CLI blocking delegation ends with its parent', () => {
	const workdirs: string[] = []

	afterEach(() => {
		for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	})

	it.each([
		['the parent query is cancelled after launch', 'caller-live', 'cancelled', 1] as const,
		['the parent query is cancelled during construction', 'caller-late', 'cancelled', 1] as const,
		['the subagent runtime is closed', 'runtime', 'completed', 2] as const,
	])(
		'aborts the real child transport as parent when %s',
		async (_label, authority, expectedStatus, expectedParentRequests) => {
			const workingDirectory = mkdtempSync(join(tmpdir(), 'namzu-child-cancel-'))
			workdirs.push(workingDirectory)
			const releaseChild = deferred<void>()
			const childStarted = deferred<void>()
			const childFinished = deferred<void>()
			const creationStarted = deferred<void>()
			const releaseCreation = deferred<void>()
			let childSignal: AbortSignal | undefined
			let childCalls = 0
			const markerPath = join(workingDirectory, 'late-marker.txt')
			const childScript = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'call_late_marker',
								name: 'write',
								args: { path: 'late-marker.txt', content: 'must not be written' },
							},
						],
					},
					{ text: 'child finished' },
				],
			})
			const childProvider: LLMProvider = {
				id: 'held-child',
				name: 'Held Child',
				chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
					childCalls++
					childSignal = params.signal
					childStarted.resolve(undefined)
					return (async function* () {
						try {
							// Deliberately ignore the abort until the test releases us. The
							// runtime must fence the later tool call, not merely ask this
							// hostile transport to cooperate.
							await releaseChild.promise
							yield* childScript.chatStream(params)
						} finally {
							childFinished.resolve(undefined)
						}
					})()
				},
			}
			const runtime = await createSubagentRuntime({
				cwd: workingDirectory,
				model: 'mock-model',
				buildProvider: () => childProvider,
				...(authority === 'caller-late'
					? {
							readEnvironment: async () => {
								creationStarted.resolve(undefined)
								await releaseCreation.promise
								return ''
							},
						}
					: {}),
				buildTools: () => {
					const tools = new ToolRegistry()
					const write = getBuiltinTools().find((tool) => tool.name === 'write')
					if (!write) throw new Error('write tool fixture is missing')
					tools.register(write)
					return tools
				},
			})
			const parentTools = new ToolRegistry()
			parentTools.register(runtime.agentTool)
			const parentProvider = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'call_delegate',
								name: 'Agent',
								args: {
									description: 'held child',
									prompt: 'attempt the late marker',
								},
							},
						],
						finishReason: 'tool_calls',
					},
					{ text: 'must not need another turn' },
				],
			})
			const caller = new AbortController()
			const pending = drainQuery({
				provider: parentProvider,
				tools: parentTools,
				runConfig: {
					model: 'mock-model',
					timeoutMs: 10_000,
					tokenBudget: 100_000,
					maxIterations: 4,
					maxResponseTokens: 256,
					permissionMode: 'auto',
				},
				toolTimeoutMs: 60_000,
				agentId: 'namzu',
				agentName: 'namzu',
				messages: [createUserMessage('delegate this')],
				workingDirectory,
				sessionId: 'ses_child_cancel' as SessionId,
				topicId: 'top_child_cancel' as TopicId,
				projectId: 'prj_child_cancel' as ProjectId,
				tenantId: 'tnt_child_cancel' as TenantId,
				signal: caller.signal,
			})

			if (authority === 'caller-late') {
				await creationStarted.promise
				expect(childCalls).toBe(0)
			} else await childStarted.promise
			let firstClose: Promise<void> | undefined
			if (authority !== 'runtime') caller.abort(new RunCancelled('user'))
			else {
				firstClose = runtime.close()
				expect(runtime.close()).toBe(firstClose)
				await firstClose
			}
			const run = await Promise.race([
				pending,
				new Promise<never>((_resolve, reject) => {
					setTimeout(() => reject(new Error('parent query did not settle')), 1_000)
				}),
			])

			expect(run.status).toBe(expectedStatus)
			if (authority === 'caller-late') {
				expect(childCalls).toBe(0)
				releaseCreation.resolve(undefined)
				await waitFor(() => runtime.gateway.listTasks().some((task) => task.state === 'canceled'))
				expect(childCalls).toBe(0)
			} else {
				expect(childSignal?.aborted).toBe(true)
				expect(cancelCauseOf(childSignal?.reason)).toBe('parent')
			}
			if (!firstClose) {
				firstClose = runtime.close()
				expect(runtime.close()).toBe(firstClose)
				await firstClose
			}
			releaseChild.resolve(undefined)
			if (childCalls > 0) {
				await Promise.race([
					childFinished.promise,
					new Promise<never>((_resolve, reject) => {
						setTimeout(() => reject(new Error('hostile child stream did not unwind')), 1_000)
					}),
				])
			}
			expect(existsSync(markerPath)).toBe(false)
			expect(parentProvider.requests).toHaveLength(expectedParentRequests)
		},
	)
})

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise<void>((resolve) => setTimeout(resolve, 5))
	}
	throw new Error('late CLI child was not cancelled')
}
