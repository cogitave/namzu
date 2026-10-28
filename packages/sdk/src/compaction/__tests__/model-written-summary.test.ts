import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import type { TokenUsage } from '../../types/common/index.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '../../types/message/index.js'
import { WorkingStateManager } from '../manager.js'
import { compactNow } from '../manual.js'
import {
	type CompactionSummaryRoute,
	extractSummary,
	fitTranscript,
	renderTranscript,
	replaceableSummaries,
	summarizeWithModel,
} from '../model-summary.js'
import { COMPACTION_HEADER } from '../summary.js'

/**
 * A model the host sets aside writes the compaction summary. The
 * conversation here has the shape of a refactor session: two long requests
 * with limits, tool reads, one failing command, and an unfinished step.
 */

const FIRST_ASK =
	'Please refactor the loader so that it caches results by absolute path. We must keep Node 20 support and never change the public API.'
const SECOND_ASK = 'Now write src/loader.ts with that design. Do not touch the lockfile.'

const SCRIPTED_SUMMARY = `<summary>
1. The person's requests: "${FIRST_ASK}" then "${SECOND_ASK}"
2. Current work: src/loader.ts is written; the empty path case still fails.
3. Next step: fix the empty path case ("Tests still failing on the empty path case").
</summary>`

function conversation(): Message[] {
	return [
		createSystemMessage('you are a helper'),
		createUserMessage(FIRST_ASK),
		createAssistantMessage('', [
			{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"sub/x.ts"}' } },
		]),
		createToolMessage(`1\texport const x = 1\n${'filler line\n'.repeat(400)}END-OF-FILE`, 'c1'),
		createAssistantMessage(
			'The decision is to keep the cache keyed by path. I will implement the loader next.',
		),
		createUserMessage(SECOND_ASK),
		createAssistantMessage('', [
			{ id: 'c2', type: 'function', function: { name: 'bash', arguments: '{"command":"false"}' } },
		]),
		{ ...createToolMessage('exit code 1', 'c2'), isError: true },
		createAssistantMessage('Done writing the loader. Tests still failing on the empty path case.'),
		createUserMessage('what is next?'),
		createAssistantMessage('Checking.'),
		createUserMessage('go on'),
		createAssistantMessage('Working.'),
	]
}

const config = CompactionConfigSchema.parse({
	strategy: 'structured',
	keepRecentMessages: 4,
	clearToolResults: false,
	llmVerification: false,
	richStateThreshold: 100,
})

function route(provider: MockLLMProvider): CompactionSummaryRoute {
	return { provider, model: 'small-1', providerId: 'mock' }
}

const sent = (provider: MockLLMProvider): string =>
	provider.requests[0]?.messages.map((m) => String(m.content)).join('\n=====\n') ?? ''

describe('the request the summary model gets', () => {
	it('carries the person’s own words, the failed call and a trimmed tool result', async () => {
		const small = new MockLLMProvider({ turns: [{ text: SCRIPTED_SUMMARY }] })
		const manager = new WorkingStateManager(config)
		const text = await summarizeWithModel({
			manager,
			olderMessages: conversation().slice(1, 9),
			config,
			resolveRoute: async () => route(small),
		})

		expect(text).toContain('Current work')
		const request = sent(small)
		expect(small.requests[0]?.model).toBe('small-1')
		expect(small.requests[0]?.maxTokens).toBe(4096)
		expect(request).toContain(`[person]: ${FIRST_ASK}`)
		expect(request).toContain(`[person]: ${SECOND_ASK}`)
		expect(request).toContain('[tool result, failed]: exit code 1')
		expect(request).toContain('[tool call] read({"path":"sub/x.ts"})')
		// The 400-line file is cut: its first lines and its last line stay, the middle goes.
		expect(request).toContain('export const x = 1')
		expect(request).toContain('END-OF-FILE')
		expect(request).toContain('characters left out')
		expect(request.length).toBeLessThan(8_000)
	})

	it('names current work and next step as sections, and frames the transcript as data', async () => {
		const small = new MockLLMProvider({ turns: [{ text: SCRIPTED_SUMMARY }] })
		await summarizeWithModel({
			manager: new WorkingStateManager(config),
			olderMessages: conversation().slice(1, 9),
			config,
			resolveRoute: async () => route(small),
		})
		const [system, user] = small.requests[0]?.messages ?? []
		expect(String(system?.content)).toContain('Current work')
		expect(String(system?.content)).toContain('Next step')
		expect(String(system?.content)).toContain('quoted in their own words')
		expect(String(system?.content)).not.toMatch(/\b(CRITICAL|MUST|NEVER)\b/)
		expect(small.requests[0]?.tools).toBeUndefined()
		const tag = /<(namzu-transcript-[0-9a-f]+)>/.exec(String(user?.content))?.[1]
		expect(tag).toBeDefined()
		expect(String(user?.content)).toContain(`</${tag}>`)
		expect(String(user?.content).trimEnd().endsWith('eight sections.')).toBe(true)
	})

	it('labels a runtime note apart from what the person typed', () => {
		const note: Message = {
			...createUserMessage('<reminder>stay on task</reminder>'),
			source: { type: 'runtime-context', kind: 'reminder' },
		} as Message
		const entries = renderTranscript([note, createUserMessage('hello')], { toolResultChars: 100 })
		expect(entries.join('\n')).toContain('[person]: hello')
		expect(entries.join('\n')).not.toContain('stay on task')
	})

	it('hands over an earlier summary and drops what a pass restored after it', async () => {
		const earlier = `${COMPACTION_HEADER}\n\nTask: port the store.\n\n## Restored after compaction\n\n### File: a.ts\n\nSECRET-BODY`
		const bodies = replaceableSummaries([
			createSystemMessage('prompt'),
			createSystemMessage(earlier),
			{ ...createSystemMessage(`${COMPACTION_HEADER}\n\nPinned one`), retain: true },
		])
		expect(bodies).toHaveLength(1)
		expect(bodies[0]).toContain('Task: port the store.')
		expect(bodies[0]).not.toContain('SECRET-BODY')

		const small = new MockLLMProvider({ turns: [{ text: SCRIPTED_SUMMARY }] })
		await summarizeWithModel({
			manager: new WorkingStateManager(config),
			olderMessages: conversation().slice(1, 9),
			previousSummaries: bodies,
			config,
			resolveRoute: async () => route(small),
		})
		expect(sent(small)).toContain('Task: port the store.')
	})

	it('puts what /compact asked to keep in its own marked block', async () => {
		const small = new MockLLMProvider({ turns: [{ text: SCRIPTED_SUMMARY }] })
		await summarizeWithModel({
			manager: new WorkingStateManager(config),
			olderMessages: conversation().slice(1, 9),
			config,
			instructions: 'keep the decisions',
			resolveRoute: async () => route(small),
		})
		expect(sent(small)).toMatch(/<namzu-operator-request-[0-9a-f]+>[\s\S]*keep the decisions/)
	})
})

describe('a transcript longer than the budget', () => {
	it('keeps the first request and the newest entries behind a marked gap', () => {
		const entries = [
			'[person]: FIRST',
			...Array.from({ length: 50 }, (_, i) => `[assistant]: step ${i} ${'x'.repeat(100)}`),
			'[person]: LAST',
		]
		const fitted = fitTranscript(entries, 1_500)
		expect(fitted.length).toBeLessThanOrEqual(1_500)
		expect(fitted).toContain('[person]: FIRST')
		expect(fitted).toContain('[person]: LAST')
		expect(fitted).toContain('left out to fit')
		expect(fitted).not.toContain('step 3 ')
	})
})

describe('the reply', () => {
	it.each([
		['<analysis>scratch</analysis><summary>kept</summary>', 'kept'],
		['preamble <summary>cut off before the clos', 'cut off before the clos'],
		['no tags at all', undefined],
		['<summary>   </summary>', undefined],
	])('reads %j', (reply, expected) => {
		expect(extractSummary(reply)).toBe(expected)
	})
})

describe('when the model summary is not used', () => {
	const run = async (
		resolveRoute: Parameters<typeof summarizeWithModel>[0]['resolveRoute'],
		over: Partial<Parameters<typeof summarizeWithModel>[0]> = {},
	) => {
		const reasons: string[] = []
		const text = await summarizeWithModel({
			manager: new WorkingStateManager(config),
			olderMessages: conversation().slice(1, 9),
			config,
			resolveRoute,
			onFallback: (reason) => reasons.push(reason),
			...over,
		})
		return { text, reasons }
	}

	it('says so when no model is set aside, or the host has no hook', async () => {
		expect(await run(async () => undefined)).toEqual({ text: undefined, reasons: ['no_route'] })
		expect(await run(undefined)).toEqual({ text: undefined, reasons: [] })
	})

	it('falls back when the route cannot be resolved', async () => {
		const out = await run(async () => {
			throw new Error('no credential')
		})
		expect(out).toEqual({ text: undefined, reasons: ['failed'] })
	})

	it('falls back when the call fails', async () => {
		const small = new MockLLMProvider({
			turns: [{ error: { message: 'overloaded', status: 503 } }],
		})
		const out = await run(async () => route(small))
		expect(out).toEqual({ text: undefined, reasons: ['failed'] })
	})

	it('falls back when the reply has no summary', async () => {
		const small = new MockLLMProvider({ turns: [{ text: 'I cannot help with that.' }] })
		const out = await run(async () => route(small))
		expect(out).toEqual({ text: undefined, reasons: ['empty'] })
	})

	it('is off when the config turns it off', async () => {
		const small = new MockLLMProvider({ turns: [{ text: SCRIPTED_SUMMARY }] })
		const out = await run(async () => route(small), { config: { ...config, modelSummary: false } })
		expect(out.text).toBeUndefined()
		expect(small.requests).toHaveLength(0)
	})

	it('passes a cancellation on instead of falling back', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(
			summarizeWithModel({
				manager: new WorkingStateManager(config),
				olderMessages: conversation().slice(1, 9),
				config,
				signal: controller.signal,
				resolveRoute: async () => route(new MockLLMProvider({ turns: [{ text: 'x' }] })),
			}),
		).rejects.toThrow()
	})

	it('sends less when the model’s window is too small, then gives up', async () => {
		const small = new MockLLMProvider({
			turns: [{ error: { message: 'prompt is too long', status: 400 } }],
		})
		const out = await run(async () => route(small))
		expect(small.requests).toHaveLength(4)
		expect(out.reasons).toEqual(['empty'])
	})
})

describe('a host-triggered compaction', () => {
	const summaryOf = (messages: readonly Message[]): string =>
		String(
			messages.find((m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER))
				?.content,
		)
	const main = () => new MockLLMProvider({ turns: [{ text: 'main model reply' }] })

	it('writes the summary with the small model and reports its tokens', async () => {
		const small = new MockLLMProvider({
			turns: [
				{
					text: SCRIPTED_SUMMARY,
					usage: { promptTokens: 900, completionTokens: 80, totalTokens: 980 },
				},
			],
		})
		const primary = main()
		const result = await compactNow({
			messages: conversation(),
			config,
			provider: primary,
			summaryRoute: async () => route(small),
		})

		const body = summaryOf(result!.messages)
		expect(body).toContain('2. Current work: src/loader.ts is written')
		expect(body).toContain('3. Next step: fix the empty path case')
		expect(body).toContain(FIRST_ASK)
		expect(primary.requests).toHaveLength(0)
		expect(result!.usage.totalTokens).toBe(980)
	})

	it('keeps the extracted summary and finishes when the small model fails', async () => {
		const small = new MockLLMProvider({ turns: [{ error: { message: 'down', status: 503 } }] })
		const result = await compactNow({
			messages: conversation(),
			config,
			provider: main(),
			summaryRoute: async () => route(small),
		})

		const body = summaryOf(result!.messages)
		expect(body).toContain(COMPACTION_HEADER)
		expect(body).not.toContain('Current work')
		expect(body).toContain('refactor the loader')
		expect(result!.usage.totalTokens).toBe(0)
	})

	it('keeps the extracted summary when no small model is set', async () => {
		const result = await compactNow({
			messages: conversation(),
			config,
			provider: main(),
			summaryRoute: async () => undefined,
		})
		expect(summaryOf(result!.messages)).not.toContain('Current work')
	})

	it('counts nothing for a call that did not run', async () => {
		const usage: TokenUsage[] = []
		const small = new MockLLMProvider({ turns: [{ text: 'no tags' }] })
		await summarizeWithModel({
			manager: new WorkingStateManager(config),
			olderMessages: conversation().slice(1, 9),
			config,
			onUsage: (u) => usage.push(u),
			resolveRoute: async () => route(small),
		})
		// A reply without a summary was still paid for, and is counted once.
		expect(usage).toHaveLength(1)
	})
})
