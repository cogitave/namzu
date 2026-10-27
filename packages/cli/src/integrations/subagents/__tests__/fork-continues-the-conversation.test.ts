/**
 * A fork starts from the conversation of the call that launched it.
 *
 * These run the real `Agent` tool against a scripted model and read what the
 * model was sent: the caller's messages and system prompt, one answer for
 * every call in the launching message, then the directive. The property is on
 * the request the child's model receives, not on a prompt asking it to behave.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	MockLLMProvider,
	type ToolContext,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
	getBuiltinTools,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { FORK_SUBAGENT, forkSeed, isForkConversation } from '../fork.js'
import { createSubagentRuntime } from '../runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const PARENT_PROMPT = 'You are the parent session. Keep answers short.'

function call(id: string, name = 'Agent') {
	return { id, type: 'function' as const, function: { name, arguments: '{}' } }
}

/** The conversation a parent has when it issues the fork call `call_fork` beside a sibling call. */
function parentHistory(): Message[] {
	return [
		{ role: 'system', content: PARENT_PROMPT },
		createUserMessage('Survey the build scripts.'),
		{ ...createAssistantMessage('Reading them.'), toolCalls: [call('call_read', 'read')] },
		createToolMessage('scripts listing', 'call_read'),
		{
			...createAssistantMessage('Two searches in parallel.'),
			toolCalls: [call('call_fork'), call('call_other')],
		},
	]
}

async function setup(buildToolsets = () => [toolset('test', getBuiltinTools())]) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-fork-'))
	dirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const provider = new MockLLMProvider({ turns: [{ text: 'fork report' }] })
	const buildProvider = vi.fn(() => provider)
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'parent-model',
		resolveParent: parent.resolveParent,
		buildTools: buildToolsets,
		buildProvider,
	})
	const context = (
		history: readonly Message[] | undefined,
		systemPrompt: string | undefined = PARENT_PROMPT,
	): ToolContext => ({
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		toolUseId: 'call_fork',
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
		...(history
			? { conversation: { messages: () => history, systemPrompt: () => systemPrompt } }
			: {}),
	})
	return { runtime, provider, context }
}

describe('the fork sub-agent', () => {
	it('is offered, and the schema accepts it', async () => {
		const { runtime } = await setup()
		try {
			expect(runtime.allowedAgentIds).toContain(FORK_SUBAGENT)
			expect(
				runtime.agentTool.inputSchema.safeParse({
					description: 'survey',
					prompt: 'Count the scripts.',
					subagent_type: FORK_SUBAGENT,
				}).success,
			).toBe(true)
			expect(runtime.agentTool.description).toContain('"fork"')
		} finally {
			await runtime.close()
		}
	})

	it('sends its model the caller’s conversation, the caller’s prompt and the directive', async () => {
		const { runtime, provider, context } = await setup()
		try {
			const result = await runtime.agentTool.execute(
				{
					description: 'survey',
					prompt: 'Count the scripts and report the number.',
					subagent_type: FORK_SUBAGENT,
					run_in_background: false,
				},
				context(parentHistory()),
			)
			// The report comes back like any other child's.
			expect(result.success).toBe(true)
			expect(result.output).toContain('fork report')

			expect(provider.requests).toHaveLength(1)
			const request = provider.requests[0]
			// Same model as the caller.
			expect(request).toMatchObject({ model: 'parent-model' })
			const messages = request?.messages ?? []
			const system = messages.filter((m) => m.role === 'system')
			expect(system.map((m) => m.content).join('\n')).toContain(PARENT_PROMPT)
			// The inherited conversation, in order, ends at the launching message.
			const conversation = messages.filter((m) => m.role !== 'system')
			expect(conversation.map((m) => m.role)).toEqual([
				'user',
				'assistant',
				'tool',
				'assistant',
				'tool',
				'tool',
				'user',
			])
			expect(conversation[0]).toMatchObject({ content: 'Survey the build scripts.' })
			// Every call in the launching message is answered; the fork's own says so.
			const answers = conversation.filter((m) => m.role === 'tool').slice(1)
			expect(answers.map((m) => (m.role === 'tool' ? m.toolCallId : ''))).toEqual([
				'call_fork',
				'call_other',
			])
			expect(String(answers[0]?.content)).toContain('started you as a fork')
			expect(String(answers[1]?.content)).toContain('belongs to your parent')
			// The directive is the last message and carries the prompt.
			const last = conversation.at(-1)
			expect(String(last?.content)).toContain('Count the scripts and report the number.')
			expect(String(last?.content)).toContain('You cannot start sub-agents or further forks')
			// The caller's prompt is not extended by the fresh sub-agent's own.
			expect(system.map((m) => m.content).join('\n')).not.toContain(
				'You cannot see the parent conversation',
			)
		} finally {
			await runtime.close()
		}
	})

	it('hands its model the same tools as any other child and no way to delegate', async () => {
		const { runtime, provider, context } = await setup()
		try {
			await runtime.agentTool.execute(
				{ description: 'survey', prompt: 'Go.', subagent_type: FORK_SUBAGENT },
				context(parentHistory()),
			)
			const names = (provider.requests[0]?.tools ?? []).map((tool) => tool.function.name)
			for (const name of ['read', 'write', 'edit', 'bash']) expect(names).toContain(name)
			expect(names).not.toContain('Agent')
		} finally {
			await runtime.close()
		}
	})

	it('refuses to start from a fork’s own conversation', async () => {
		const { runtime, provider, context } = await setup()
		try {
			const first = await runtime.agentTool.execute(
				{ description: 'survey', prompt: 'Go.', subagent_type: FORK_SUBAGENT },
				context(parentHistory()),
			)
			expect(first.success).toBe(true)
			const sent = provider.requests[0]?.messages ?? []
			expect(isForkConversation(sent)).toBe(true)
			provider.requests.length = 0
			const nested = await runtime.agentTool.execute(
				{ description: 'again', prompt: 'Go again.', subagent_type: FORK_SUBAGENT },
				context(sent),
			)
			expect(nested.success).toBe(false)
			expect(nested.error ?? nested.output).toContain('cannot start another fork')
			expect(provider.requests).toHaveLength(0)
		} finally {
			await runtime.close()
		}
	})

	it('refuses a model, provider, effort or role, which would make it a different worker', async () => {
		const { runtime, provider, context } = await setup()
		try {
			for (const extra of [{ model: 'other' }, { role: 'You are a poet.' }]) {
				const result = await runtime.agentTool.execute(
					{ description: 'survey', prompt: 'Go.', subagent_type: FORK_SUBAGENT, ...extra },
					context(parentHistory()),
				)
				expect(result.success).toBe(false)
				expect(result.error ?? result.output).toContain('runs on your model')
			}
			expect(provider.requests).toHaveLength(0)
		} finally {
			await runtime.close()
		}
	})

	it('refuses, and says what to do instead, when no conversation is available', async () => {
		const { runtime, provider, context } = await setup()
		try {
			const result = await runtime.agentTool.execute(
				{ description: 'survey', prompt: 'Go.', subagent_type: FORK_SUBAGENT },
				context(undefined),
			)
			expect(result.success).toBe(false)
			expect(result.error ?? result.output).toContain('general-purpose sub-agent')
			expect(provider.requests).toHaveLength(0)
		} finally {
			await runtime.close()
		}
	})

	it('needs the same approval as any other change-making child', async () => {
		const { runtime } = await setup()
		try {
			expect(
				runtime.launchesReadOnlyAgent({
					description: 'survey',
					prompt: 'Go.',
					subagent_type: FORK_SUBAGENT,
				}),
			).toBe(false)
		} finally {
			await runtime.close()
		}
	})
})

describe('the messages a fork starts from', () => {
	it('answers every call of the launching message and drops what came after it', () => {
		const history = [
			...parentHistory(),
			createToolMessage('late result', 'call_other'),
			createUserMessage('a later message'),
		]
		const seed = forkSeed(history, 'call_fork')
		expect(seed.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'assistant',
			'tool',
			'tool',
		])
		expect(JSON.stringify(seed)).not.toContain('a later message')
		expect(JSON.stringify(seed)).not.toContain('late result')
	})

	it('cuts back to the last complete exchange when the launching message is not there', () => {
		const seed = forkSeed(parentHistory(), 'call_missing')
		expect(seed.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
	})

	it('keeps a compaction summary and leaves out the plain system prompt', () => {
		const summary: Message = {
			role: 'system',
			content: 'Summary of earlier work.',
			source: { type: 'compaction-summary' },
		}
		const seed = forkSeed(
			[{ role: 'system', content: 'prompt' }, summary, ...parentHistory().slice(1)],
			'call_fork',
		)
		expect(seed[0]).toBe(summary)
		expect(seed.filter((m) => m.role === 'system')).toHaveLength(1)
	})
})
