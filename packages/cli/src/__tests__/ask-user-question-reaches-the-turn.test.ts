/**
 * `ask_user_question` is mounted where somebody can answer, and the answer
 * the operator gives is the answer the model gets.
 *
 * The SDK tool parks the run through the handler it was BUILT with; the CLI
 * builds it once per session and routes the park to the turn's `onQuestion`.
 * So the hop that can silently break is the routing: a tool that exists,
 * parks, and returns "the user did not answer" because the holder was never
 * filled. These execute the registered tool after a real `send()` and read
 * what it returns.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { type Message, type ToolContext, type ToolDefinition, asRunId } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import type { QuestionFn, UserQuestion } from '../tui/agent.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let root: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-ask-'))
	mkdirSync(join(root, '.git'))
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

async function openSession(askUser: boolean) {
	const { createAgentSession } = await import('../tui/agent.js')
	return createAgentSession(prefs, detectedAnthropic(), {
		cwd: root,
		...(askUser ? { askUser: true } : {}),
	})
}

async function sendOnce(
	session: Awaited<ReturnType<typeof openSession>>,
	onQuestion?: QuestionFn,
): Promise<ToolDefinition | undefined> {
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	for await (const _ of session.send(messages, onQuestion ? { onQuestion } : {})) {
		// drain
	}
	// The LAST call: a test that opens a second session must read that
	// session's registry, not the first one's with its first answerer.
	const tools = queryCalls.at(-1)?.tools as { get(name: string): ToolDefinition | undefined }
	return tools.get('ask_user_question')
}

const askInput = {
	question: 'Which audience is this for?',
	header: 'Audience',
	options: [
		{ label: 'Board (Recommended)', description: 'High level, few slides' },
		{ label: 'Engineers', description: 'Details and diagrams' },
	],
}

function toolContext(): ToolContext {
	return {
		runId: asRunId('run_ask'),
		toolUseId: 'toolu_ask_1',
		abortSignal: new AbortController().signal,
	} as unknown as ToolContext
}

describe('ask_user_question', () => {
	it('is mounted only for a session that said somebody can answer', async () => {
		expect((await openSession(true)).toolNames()).toContain('ask_user_question')
		expect((await openSession(false)).toolNames()).not.toContain('ask_user_question')
	})

	it("routes the question to the turn's answerer and returns their choice to the model", async () => {
		const session = await openSession(true)
		let asked: UserQuestion | undefined
		const tool = await sendOnce(session, async (question) => {
			asked = question
			return { kind: 'answer', selectedOptionIds: [question.options[1]?.id ?? ''] }
		})
		if (!tool) throw new Error('the question tool was not in the registry the turn ran with')

		const result = await tool.execute(askInput, toolContext())

		expect(asked?.question).toBe('Which audience is this for?')
		expect(asked?.header).toBe('Audience')
		expect(asked?.options.map((o) => o.label)).toEqual(['Board (Recommended)', 'Engineers'])
		expect(result.success).toBe(true)
		expect(result.output).toContain('User answered "Which audience is this for?": "Engineers"')
	})

	it('carries free text, and reports a skip as no answer rather than a choice', async () => {
		const session = await openSession(true)
		const tool = await sendOnce(session, async () => ({
			kind: 'answer',
			selectedOptionIds: [],
			freeText: 'the sales team',
		}))
		if (!tool) throw new Error('no tool')
		expect((await tool.execute(askInput, toolContext())).output).toContain(
			'in their own words: "the sales team"',
		)

		const skipped = await sendOnce(await openSession(true), async () => ({ kind: 'skip' }))
		if (!skipped) throw new Error('no tool')
		const result = await skipped.execute(askInput, toolContext())
		expect(result.success).toBe(true)
		expect(result.output).toContain('did not answer')
	})

	it('reports no answer when the turn brought nobody to ask', async () => {
		const session = await openSession(true)
		const tool = await sendOnce(session)
		if (!tool) throw new Error('no tool')

		const result = await tool.execute(askInput, toolContext())

		expect(result.output).toContain('did not answer')
	})
})
