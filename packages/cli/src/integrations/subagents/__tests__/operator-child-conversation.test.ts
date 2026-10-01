import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	SessionPaths,
	asTaskId,
	defineTool,
	generateTurnId,
	mcpJsonSchemaToZod,
	toolset,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { readChildOperatorNotices } from '../operator-journal.js'
import { createSubagentRuntime } from '../runtime.js'

const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDir(directory)
})
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('Expected retained evidence')
	return value
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-operator-child-'))
	directories.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const nextTurn = generateTurnId()
	const paths = new SessionPaths({
		home: join(cwd, 'state'),
		slug: 'operator-child',
	})
	const context = {
		...parent.scope,
		abortSignal: new AbortController().signal,
		workingDirectory: cwd,
		env: {},
		log() {},
	}
	return {
		cwd,
		parent,
		nextTurn,
		paths,
		context,
		resolveParent: (turnId: typeof nextTurn) =>
			parent.resolveParent(turnId === nextTurn ? parent.scope.turnId : turnId),
	}
}

it('continues a dynamic child across parent turns with fresh task/provider and original history', async () => {
	const f = await fixture()
	const providers: MockLLMProvider[] = []
	const runtime = await createSubagentRuntime({
		...f,
		model: 'mock',
		buildTools: () => [],
		buildProvider: () => {
			const provider = new MockLLMProvider({
				turns: [{ text: providers.length ? 'SECOND_RESULT' : 'FIRST_RESULT' }],
			})
			providers.push(provider)
			return provider
		},
	})
	try {
		const first = await runtime.agentTool.execute(
			{
				description: 'specialist',
				prompt: 'ORIGINAL_TASK',
				role: 'Keep your evidence.',
			},
			f.context,
		)
		expect(first.success).toBe(true)
		const old = required(runtime.activity.getSnapshot()[0])
		const original = required((await runtime.gatewayForTurn(f.parent.scope.turnId)).listTasks()[0])
		await runtime.releaseTurn(f.parent.scope.turnId)
		const receipt = await runtime.messageChild(
			old.viewId,
			'FOLLOW_UP_TASK',
			f.nextTurn,
			f.context.abortSignal,
		)
		expect(receipt.kind).toBe('started')
		expect(receipt.taskId).not.toBe(original.taskId)
		expect(receipt.sessionId).toBe(old.sessionId)
		const newTask = await (await runtime.gatewayForTurn(f.nextTurn)).waitForTask(
			asTaskId(receipt.taskId),
		)
		expect(newTask.state).toBe('completed')
		expect(original.state).toBe('completed')
		expect(runtime.activity.getSnapshot()).toHaveLength(1)
		expect(runtime.activity.getSnapshot()[0]).toMatchObject({
			viewId: old.viewId,
			sessionId: old.sessionId,
			taskId: receipt.taskId,
		})
		expect(providers).toHaveLength(2)
		const secondRequest = JSON.stringify(required(required(providers[1]).requests[0]).messages)
		expect(secondRequest).toContain('ORIGINAL_TASK')
		expect(secondRequest).toContain('FIRST_RESULT')
		expect(secondRequest).toContain('FOLLOW_UP_TASK')
		expect(receipt.parentNotice).toContain('not a child-authored claim')
		expect((await readChildOperatorNotices(f.paths, f.parent.scope.sessionId))[0]?.text).toBe(
			receipt.parentNotice,
		)
		const journal = readFileSync(
			join(
				f.paths.sessionDir({ sessionId: f.parent.scope.sessionId }),
				'child-operator-messages.jsonl',
			),
			'utf8',
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		expect(journal.map((row) => row.status)).toEqual(['submitted', 'accepted'])
		expect(journal[1]).toMatchObject({
			source: 'operator',
			taskId: receipt.taskId,
			message: 'FOLLOW_UP_TASK',
		})
	} finally {
		await runtime.close()
	}
})

it('queues operator input while a child tool is held and consumes it after the tool result', async () => {
	const f = await fixture()
	const entered = deferred<void>()
	const release = deferred<void>()
	const requests: ChatCompletionParams[] = []
	const script = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'held-call', name: 'held', args: {} }] },
			{ text: 'CORRECTED_RESULT' },
		],
	})
	const runtime = await createSubagentRuntime({
		...f,
		model: 'mock',
		resolveResumeHandler: () => async (request) =>
			request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		buildProvider: (): LLMProvider => ({
			id: 'child',
			name: 'child',
			async *chatStream(params) {
				requests.push(params)
				yield* script.chatStream(params)
			},
		}),
		buildTools: () => [
			toolset('test', [
				defineTool({
					name: 'held',
					description: 'A controlled child read.',
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: false,
					inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
					async execute() {
						entered.resolve()
						await release.promise
						return { success: true, output: 'HELD_TOOL_RESULT' }
					},
				}),
			]),
		],
	})
	try {
		await runtime.agentTool.execute(
			{ description: 'held', prompt: 'Work.', run_in_background: true },
			f.context,
		)
		await entered.promise
		const child = required(runtime.activity.getSnapshot()[0])
		const receipt = await runtime.messageChild(
			child.viewId,
			'DIRECT_OPERATOR_CORRECTION',
			f.nextTurn,
			f.context.abortSignal,
		)
		expect(receipt.kind).toBe('queued')
		expect(receipt.taskId).toBe(child.taskId)
		expect(requests).toHaveLength(1)
		release.resolve()
		await (await runtime.gatewayForTurn(f.parent.scope.turnId)).waitForTask(
			asTaskId(receipt.taskId),
		)
		expect(requests).toHaveLength(2)
		const messages = JSON.stringify(required(requests[1]).messages)
		expect(messages.indexOf('HELD_TOOL_RESULT')).toBeLessThan(
			messages.indexOf('DIRECT_OPERATOR_CORRECTION'),
		)
		expect(messages).toContain('DIRECT_OPERATOR_CORRECTION')
		expect(
			required(runtime.activity.getSnapshot()[0]).transcript.some(
				(row) => row.kind === 'system' && row.direction === 'operator-to-child',
			),
		).toBe(true)
	} finally {
		release.resolve()
		await runtime.close()
	}
})

it('refuses stale screens, blank messages and another parent without creating a notice', async () => {
	const f = await fixture()
	const other = await subagentParentFixture(f.cwd)
	let foreign = false
	const runtime = await createSubagentRuntime({
		...f,
		model: 'mock',
		resolveParent: (turnId) =>
			foreign ? other.resolveParent(other.scope.turnId) : f.resolveParent(turnId),
		buildTools: () => [],
		buildProvider: () => new MockLLMProvider({ turns: [{ text: 'done' }] }),
	})
	try {
		await runtime.agentTool.execute({ description: 'child', prompt: 'Work.' }, f.context)
		const child = required(runtime.activity.getSnapshot()[0])
		await expect(
			runtime.messageChild(child.viewId, ' ', f.nextTurn, f.context.abortSignal),
		).rejects.toThrow('characters')
		foreign = true
		await expect(
			runtime.messageChild(child.viewId, 'wrong parent', f.nextTurn, f.context.abortSignal),
		).rejects.toThrow('different parent')
		foreign = false
		runtime.activity.reset()
		await expect(
			runtime.messageChild(child.viewId, 'stale screen', f.nextTurn, f.context.abortSignal),
		).rejects.toThrow('no longer owned')
	} finally {
		await runtime.close()
	}
})
