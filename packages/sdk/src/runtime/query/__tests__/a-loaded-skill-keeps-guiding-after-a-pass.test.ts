import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { SkillRegistry } from '../../../skills/registry.js'
import { testToolset } from '../../../test-support/toolset.js'
import { SkillTool } from '../../../tools/builtins/skill.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

/**
 * A skill the model loaded keeps guiding it after a pass cuts the result that
 * carried it. Driven through the real `query()` with a scripted model, and
 * read where it matters: the request the model receives. The middle line of
 * the skill is the probe, because a cleared result keeps only its two ends.
 */

const PROBE = 'Step 30: do the careful thing number 30.'
const BODY = Array.from(
	{ length: 60 },
	(_, i) => `Step ${i}: do the careful thing number ${i}.`,
).join('\n')

let dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs = []
})

async function skills(): Promise<SkillRegistry> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-skill-carry-'))
	dirs.push(root)
	const dir = join(root, 'helper')
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'SKILL.md'), `---\nname: helper\ndescription: Helps\n---\n${BODY}\n`)
	const registry = new SkillRegistry()
	await registry.register(dir)
	return registry
}

const toolset = () =>
	testToolset(
		SkillTool,
		defineTool({
			name: 'dump',
			description: 'returns a lot',
			inputSchema: z.object({ which: z.number() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async ({ which }: { which: number }) => ({
				success: true,
				output: `dump ${which}: ${'filler text '.repeat(1500)}`,
			}),
		}),
	)

const dumps = (from: number, count: number): MockTurn[] =>
	Array.from({ length: count }, (_, i) => ({
		toolCalls: [{ id: `d${from + i}`, name: 'dump', args: { which: from + i } }],
		finishReason: 'tool_calls' as const,
	}))

const loadSkill: MockTurn = {
	toolCalls: [{ id: 's1', name: 'skill', args: { name: 'helper' } }],
	finishReason: 'tool_calls',
}

const copies = (messages: readonly Message[]): number =>
	JSON.stringify(messages).split(PROBE).length - 1

const IDS = {
	sessionId: '1e0301cb-9455-48d1-a22a-76f7bcae0981' as SessionId,
	topicId: 'f85fe271-5d7f-43be-b197-75d2e0b019bb' as TopicId,
	projectId: '77591058-6566-4123-826e-b2c57da6bb8a' as ProjectId,
	tenantId: '5ebe0c1e-9c3b-4abc-870d-affb0cea1850' as TenantId,
}

async function run(options: {
	provider: MockLLMProvider
	messages: Message[]
	strategy: 'salience' | 'structured'
	registry: SkillRegistry
	basePrompt?: string
}) {
	const events: SessionEvent[] = []
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-skill-carry-wd-'))
	dirs.push(workingDirectory)
	const turn = await drainQuery(
		{
			provider: options.provider,
			toolsets: [toolset()],
			skillRegistry: options.registry,
			workingDirectory,
			...(options.basePrompt ? { basePrompt: options.basePrompt } : {}),
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 30,
			},
			agentId: 'a',
			agentName: 'A',
			...IDS,
			messages: options.messages,
			compactionConfig: {
				strategy: options.strategy,
				contextWindowTokens: 30_000,
				keepRecentMessages: 2,
				llmVerification: false,
				...(options.strategy === 'structured'
					? { triggerThreshold: 0.5, clearToolResults: false }
					: {}),
			} as never,
		},
		(event) => {
			events.push(event)
		},
	)
	return { turn, events }
}

/**
 * What a log round trip hands the next process: plain data, no live objects.
 * Ids belong to the first process's log, so they are left off, as for new messages.
 */
const persisted = (messages: readonly Message[]): Message[] =>
	messages
		.filter((m) => m.role !== 'system')
		.map((m) => {
			const { id: _id, ...rest } = JSON.parse(JSON.stringify(m)) as Message & {
				id?: string
			}
			return rest as Message
		})

const carriedEvents = (events: SessionEvent[]) =>
	events.filter((e) => e.type === 'compaction_skills_carried')

describe('a loaded skill after a pass that cut it', () => {
	it('is in every request exactly once after a salience pass cleared its result', async () => {
		const provider = new MockLLMProvider({
			turns: [loadSkill, ...dumps(0, 10), { text: 'done' }],
		})
		const { events } = await run({
			provider,
			messages: [createUserMessage('use helper, then dump')],
			strategy: 'salience',
			registry: await skills(),
		})

		// Every request from the one that follows the load holds the steps once:
		// whole in the result, then in the entry once the pass cleared the result.
		for (const request of provider.requests.slice(1)) {
			expect(copies(request.messages)).toBe(1)
		}
		const cleared = events.filter((e) => e.type === 'compaction_tool_results_cleared')
		expect(cleared.length).toBeGreaterThan(0)
		// And said once, not on every pass.
		expect(carriedEvents(events)).toHaveLength(1)
		expect(carriedEvents(events)[0]).toMatchObject({
			skills: ['helper'],
			cut: [],
			leftOut: [],
		})
		// The frame is ours and says the guidance still applies.
		const last = JSON.stringify(provider.requests.at(-1)?.messages)
		expect(last).toContain('Their guidance still applies to the work in progress')
		expect(last).toContain('not a new message from the person')
	})

	it('is put back once after a summary pass in a later turn, and not repeated by the next', async () => {
		const registry = await skills()
		const first = new MockLLMProvider({
			turns: [loadSkill, ...dumps(0, 1), { text: 'ok' }],
		})
		const one = await run({
			provider: first,
			messages: [createUserMessage('use helper')],
			strategy: 'structured',
			registry,
		})
		const history = persisted(one.turn.messages)
		expect(copies(history)).toBe(1)

		// The next turn starts with a new working state: only the history knows
		// the skill was loaded.
		const second = new MockLLMProvider({
			turns: [...dumps(10, 8), { text: 'done' }],
		})
		const two = await run({
			provider: second,
			messages: [...history, createUserMessage('now dump more')],
			strategy: 'structured',
			registry,
		})
		const compacted = two.events.filter((e) => e.type === 'compaction_completed')
		expect(compacted.length).toBeGreaterThan(0)
		for (const request of second.requests) {
			expect(copies(request.messages)).toBe(1)
		}
		expect(carriedEvents(two.events).length).toBeGreaterThan(0)
	})

	it('is in the first request of a conversation resumed after the pass, exactly once', async () => {
		const registry = await skills()
		const first = new MockLLMProvider({
			turns: [loadSkill, ...dumps(0, 8), { text: 'done' }],
		})
		const one = await run({
			provider: first,
			messages: [createUserMessage('use helper, then dump')],
			strategy: 'salience',
			registry,
		})
		expect(carriedEvents(one.events)).toHaveLength(1)

		// A new process: the only thing it has is what was written down.
		const history = persisted(one.turn.messages)
		const second = new MockLLMProvider({
			turns: [...dumps(20, 8), { text: 'done' }],
		})
		const two = await run({
			provider: second,
			messages: [...history, createUserMessage('keep going')],
			strategy: 'salience',
			registry,
		})
		for (const request of second.requests) {
			expect(copies(request.messages)).toBe(1)
		}
		// The resumed turn did not say it again: the entry was whole in the log.
		expect(carriedEvents(two.events)).toHaveLength(0)
	})

	it('leaves a skill the person activated alone and adds nothing when no skill was loaded', async () => {
		const provider = new MockLLMProvider({
			turns: [...dumps(0, 10), { text: 'done' }],
		})
		const { events } = await run({
			provider,
			messages: [createUserMessage('dump everything')],
			strategy: 'salience',
			registry: await skills(),
			basePrompt: 'Base.\n\n### Skill: greet\n\nSay hello in French.',
		})
		expect(events.some((e) => e.type === 'compaction_tool_results_cleared')).toBe(true)
		expect(carriedEvents(events)).toHaveLength(0)
		for (const request of provider.requests) {
			const text = JSON.stringify(request.messages)
			expect(text).not.toContain('loaded-skill')
			expect(text).not.toContain('Recorded context')
			// The activated skill stays in the prompt, once.
			expect(text.split('Say hello in French.').length - 1).toBe(1)
		}
	})
})
