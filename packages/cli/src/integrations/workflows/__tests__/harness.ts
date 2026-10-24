import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	type StreamChunk,
	type ToolContext,
	type TurnId,
	generateTurnId,
} from '@namzu/sdk'

import { subagentParentFixture } from '../../subagents/__fixtures__/parent.js'
import { WORKFLOW_STEP_ASSIGNMENT, createSubagentRuntime } from '../../subagents/runtime.js'
import { createWorkflowHost } from '../host.js'
import type { WorkflowRunEnd } from '../registry.js'

export const TWO_PHASE_SCRIPT = `export const meta = { name: 'audit', description: 'Scan, then fix', phases: [{ title: 'Scan' }, { title: 'Fix', detail: 'safe fixes only' }] }
phase('Scan')
const found = await parallel([1, 2, 3].map((n) => () => agent('scan ' + n, { label: 'scan:' + n })))
phase('Fix')
const fixed = await parallel(found.map((f, i) => () => agent('fix ' + f, { label: 'fix:' + i })))
return { found, fixed }`

export function lastUserText(params: ChatCompletionParams): string {
	for (const message of [...params.messages].reverse()) {
		if (message.role === 'user' && typeof message.content === 'string') return message.content
	}
	return ''
}

export interface Gate {
	/** Let every agent that is waiting, and every later one, answer. */
	open(): void
	/** Let exactly one waiting agent answer. */
	release(): void
	readonly waiting: () => number
}

/**
 * A subagent runtime over a model that answers `ok:<prompt>`, optionally held
 * until the test lets it go. No clock and no sleeps: tests await the registry.
 */
export async function workflowHarness(
	options: {
		readonly held?: boolean
		readonly refusal?: string
		readonly tokenBudget?: number
		readonly limits?: { maxConcurrency?: number; maxAgents?: number }
	} = {},
) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-workflow-'))
	const runs = join(cwd, 'runs')
	const parent = await subagentParentFixture(cwd)
	const known = new Set<TurnId>([parent.scope.turnId])
	const waiters: Array<() => void> = []
	const gateWatchers: Array<() => void> = []
	let open = options.held !== true
	const gate: Gate = {
		open() {
			open = true
			for (const wake of waiters.splice(0)) wake()
		},
		release() {
			waiters.shift()?.()
		},
		waiting: () => waiters.length,
	}
	const gateChanged = (): void => {
		for (const watcher of [...gateWatchers]) watcher()
	}
	const prompts: string[] = []
	const assigned: boolean[] = []
	const runtime = await createSubagentRuntime({
		resolveParent: (turnId) =>
			parent.resolveParent(known.has(turnId) ? parent.scope.turnId : turnId),
		cwd,
		model: 'mock-model',
		tokenBudget: options.tokenBudget ?? 0,
		buildTools: () => [],
		buildProvider: () => {
			const script = new MockLLMProvider({
				nextTurn: (params) => {
					// Every workflow step opens with the assignment sentence; the tests
					// below are about the script's own prompt.
					const raw = lastUserText(params)
					const prompt = raw.startsWith(`${WORKFLOW_STEP_ASSIGNMENT}\n\n`)
						? raw.slice(WORKFLOW_STEP_ASSIGNMENT.length + 2)
						: raw
					assigned.push(raw !== prompt)
					prompts.push(prompt)
					return { text: `ok:${prompt}` }
				},
			})
			return {
				id: 'workflow-child',
				name: 'Workflow child',
				async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
					if (!open) {
						await new Promise<void>((resolve, reject) => {
							const wake = (): void => resolve()
							waiters.push(wake)
							gateChanged()
							params.signal?.addEventListener(
								'abort',
								() => {
									const at = waiters.indexOf(wake)
									if (at >= 0) waiters.splice(at, 1)
									gateChanged()
									reject(params.signal?.reason)
								},
								{ once: true },
							)
						})
					}
					yield* script.chatStream(params)
				},
			} satisfies LLMProvider
		},
	})
	const ended: WorkflowRunEnd[] = []
	const endWaiters: Array<() => void> = []
	const released: TurnId[] = []
	const host = createWorkflowHost({
		subagents: runtime,
		runsDirectory: () => runs,
		refusal: () => options.refusal,
		// The default concurrency follows this machine's CPU count; a test that
		// holds several agents at once would hang on a small CI runner.
		limitsFor: () => ({ maxConcurrency: 8, ...options.limits }),
		openRunTurn: (_origin, _runId) => {
			const turnId = generateTurnId()
			known.add(turnId)
			return {
				turnId,
				release: async () => {
					released.push(turnId)
					known.delete(turnId)
					await runtime.releaseTurn(turnId)
				},
			}
		},
		onEnd: (end) => {
			ended.push(end)
			for (const wake of endWaiters.splice(0)) wake()
		},
	})
	const context = {
		turnId: parent.scope.turnId,
		abortSignal: new AbortController().signal,
	} as unknown as ToolContext
	return {
		cwd,
		runs,
		runtime,
		host,
		gate,
		prompts,
		/** One entry per child turn: whether its prompt opened with the assignment sentence. */
		assigned,
		ended,
		released,
		context,
		start: (input: { script: string; args?: unknown }) => host.tool.execute(input, context),
		/** Resolves when `ready()` holds, re-checked on every run update and every change at the model gate. */
		async until(ready: () => boolean): Promise<void> {
			if (ready()) return
			await new Promise<void>((resolve) => {
				const check = (): void => {
					if (!ready()) return
					unsubscribe()
					gateWatchers.splice(gateWatchers.indexOf(check), 1)
					resolve()
				}
				const unsubscribe = host.registry.subscribe(check)
				gateWatchers.push(check)
			})
		},
		/** Resolves once `count` runs have ended. */
		async untilEnded(count = 1): Promise<void> {
			while (ended.length < count) await new Promise<void>((resolve) => endWaiters.push(resolve))
		},
		readJournal(runId: string): string {
			return readFileSync(join(runs, runId, 'workflow', 'journal.jsonl'), 'utf8')
		},
		async close(): Promise<void> {
			host.registry.close()
			await runtime.close()
		},
	}
}
