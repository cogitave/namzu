import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type Toolset,
	createUserMessage,
	drainQuery,
	toolset,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { type SubagentCompletion, createSubagentRuntime } from '../runtime.js'

/**
 * With an operator watching (`backgroundByDefault`), `Agent` runs in the
 * background unless told otherwise, the turn ends when the model has answered,
 * the agent keeps running after the turn is released, and its end is reported
 * once through `onBackgroundCompletion`.
 *
 * Nothing here measures time: the child is held on a promise the test resolves.
 */

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

const workdirs: string[] = []
afterEach(() => {
	for (const cwd of workdirs.splice(0)) removeTempDir(cwd)
})

const CHILD_RESULT = 'LATE_CHILD_RESULT: the beta branch is 719.'

async function launchWithoutAskingForBackground(options: {
	backgroundByDefault: boolean
	/** Ask for a foreground agent whose wait the operator's next message releases. */
	foregroundReleasedByInput?: boolean
}) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-outlive-'))
	workdirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const childStarted = deferred<AbortSignal>()
	const childRelease = deferred<void>()
	const childScript = new MockLLMProvider({ turns: [{ text: CHILD_RESULT }] })
	const runtime = await createSubagentRuntime({
		resolveParent: (turnId) => parent.resolveParent(turnId),
		cwd,
		model: 'mock-model',
		tokenBudget: 1_000_000,
		backgroundByDefault: options.backgroundByDefault,
		...(options.foregroundReleasedByInput
			? {
					// The operator types once the child is running: the wait is released.
					resolveWaitForInbound: () => () => childStarted.promise.then(() => undefined),
				}
			: {}),
		resolveResumeHandler: () => async () => ({ action: 'continue' }),
		buildTools: (): readonly Toolset[] => [],
		buildProvider: () =>
			({
				id: 'held-child',
				name: 'Held child',
				async *chatStream(params: ChatCompletionParams) {
					childStarted.resolve(params.signal as AbortSignal)
					await childRelease.promise
					yield* childScript.chatStream(params)
				},
			}) satisfies LLMProvider,
	})
	const completions: SubagentCompletion[] = []
	runtime.onBackgroundCompletion((completion) => completions.push(completion))
	const gateway = await runtime.gatewayForTurn(parent.scope.turnId)
	const completionInbox = await runtime.completionInboxForTurn(parent.scope.turnId)
	const parentScript = new MockLLMProvider({
		nextTurn: (_params, index) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 'launch',
								name: 'Agent',
								// No run_in_background: the default decides.
								args: {
									description: 'beta lookup',
									prompt: 'Find the beta branch id.',
									...(options.foregroundReleasedByInput ? { run_in_background: false } : {}),
								},
							},
						],
					}
				: { text: 'Started the lookup.' },
	})
	const requests: ChatCompletionParams[] = []
	const provider: LLMProvider = {
		id: 'parent',
		name: 'Parent',
		chatStream(params) {
			requests.push(params)
			return parentScript.chatStream(params)
		},
	}
	return {
		parent,
		runtime,
		gateway,
		completionInbox,
		completions,
		requests,
		childStarted,
		childRelease,
		run: () =>
			drainQuery({
				provider,
				toolsets: [toolset('test', [runtime.agentTool])],
				taskScheduler: gateway,
				completionInbox,
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 10_000,
					tokenBudget: 1_000_000,
					maxIterations: 10,
					permissionMode: 'auto',
				},
				agentId: 'namzu',
				agentName: 'namzu',
				messages: [createUserMessage('Look up the beta branch.')],
				workingDirectory: cwd,
				...parent.scope,
			}),
	}
}

it('ends the turn with the agent running, keeps it alive past the release, and reports its end once', async () => {
	const t = await launchWithoutAskingForBackground({ backgroundByDefault: true })
	try {
		const turn = await t.run()
		// The turn is over although the child has not produced anything.
		expect(turn.messages.at(-1)?.content).toBe('Started the lookup.')
		expect(t.requests).toHaveLength(2)
		expect(turn.abandonedTaskIds).toBeUndefined()
		const [task] = t.gateway.listTasks()
		expect(task?.state).not.toBe('completed')

		await t.runtime.releaseTurn(t.parent.scope.turnId)
		const signal = await t.childStarted.promise
		// Released, not stopped: the agent is still running, and still listed.
		expect(signal.aborted).toBe(false)
		expect(t.gateway.listTasks().every((entry) => entry.state !== 'canceled')).toBe(true)
		expect(t.completions).toEqual([])

		t.childRelease.resolve()
		await t.gateway.waitForTask(task?.taskId as never)
		await Promise.resolve()
		expect(t.completions).toHaveLength(1)
		expect(t.completions[0]).toMatchObject({
			state: 'completed',
			description: 'beta lookup',
			parentSessionId: String(t.parent.scope.sessionId),
		})
		expect(t.completions[0]?.text).toContain('LATE_CHILD_RESULT')
	} finally {
		t.childRelease.resolve()
		await t.runtime.close()
	}
})

it('stops a background agent when the session closes', async () => {
	const t = await launchWithoutAskingForBackground({ backgroundByDefault: true })
	await t.run()
	await t.runtime.releaseTurn(t.parent.scope.turnId)
	const signal = await t.childStarted.promise
	await t.runtime.close()
	expect(signal.aborted).toBe(true)
	t.childRelease.resolve()
})

it('keeps the original contract without the option: the release cancels what is left', async () => {
	const t = await launchWithoutAskingForBackground({ backgroundByDefault: false })
	try {
		// No default background, so the Agent call waits for the child; release it first.
		t.childRelease.resolve()
		const turn = await t.run()
		expect(turn.messages.some((m) => String(m.content).includes('LATE_CHILD_RESULT'))).toBe(true)
	} finally {
		await t.runtime.close()
	}
})

it('keeps a foreground agent whose wait the operator released, like a background one', async () => {
	// Releasing the wait moves the agent to the background: it is not stopped
	// with the turn, and its end is reported once.
	const t = await launchWithoutAskingForBackground({
		backgroundByDefault: true,
		foregroundReleasedByInput: true,
	})
	try {
		await t.run()
		const [task] = t.gateway.listTasks()
		expect(task?.state).not.toBe('completed')
		await t.runtime.releaseTurn(t.parent.scope.turnId)
		const signal = await t.childStarted.promise
		expect(signal.aborted).toBe(false)
		expect(t.gateway.listTasks().every((entry) => entry.state !== 'canceled')).toBe(true)
		t.childRelease.resolve()
		await t.gateway.waitForTask(task?.taskId as never)
		await Promise.resolve()
		expect(t.completions).toHaveLength(1)
		expect(t.completions[0]).toMatchObject({ state: 'completed', description: 'beta lookup' })
	} finally {
		t.childRelease.resolve()
		await t.runtime.close()
	}
})
