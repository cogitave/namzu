import { describe, expect, it } from 'vitest'

import type {
	AssistantMessage,
	Message,
	ToolMessage,
	UserMessage,
} from '../../../types/message/index.js'
import { bm25Score, buildIndex, indexDocument } from '../bm25.js'
import { minhash, similarity } from '../minhash.js'
import { scoreMessages } from '../score.js'
import { tokenize } from '../tokenize.js'

/**
 * The compaction pass chose what to keep by position, so a fact stated in
 * the middle of a long run aged out at the same rate as chatter. Salience
 * gives every message a number from what the kernel can observe without a
 * model. These are the four things the plan says the scorer must prove.
 */

const user = (content: string, retain = false): UserMessage => ({
	role: 'user',
	content,
	...(retain ? { retain: true } : {}),
})
const assistant = (
	content: string | null,
	calls: { id: string; name: string; args: unknown }[] = [],
): AssistantMessage => ({
	role: 'assistant',
	content,
	...(calls.length
		? {
				toolCalls: calls.map((c) => ({
					id: c.id,
					type: 'function' as const,
					function: { name: c.name, arguments: JSON.stringify(c.args) },
				})),
			}
		: {}),
})
const tool = (toolCallId: string, content: string): ToolMessage => ({
	role: 'tool',
	content,
	toolCallId,
})
const chatter = (i: number): Message[] => [
	assistant(`Working on it, step ${i}. Let me look further.`),
	user(`ok go on ${i}`),
]

describe('tokenize', () => {
	it('opens paths, identifiers and dotted keys so a part can find the whole', () => {
		const tokens = tokenize('read src/store.mjs and call removeTodo; log namzu.run.id')
		expect(tokens).toEqual(
			expect.arrayContaining([
				'src/store.mjs',
				'src',
				'store',
				'mjs',
				'removetodo',
				'remove',
				'todo',
				'namzu.run.id',
				'run',
				'id',
			]),
		)
		expect(tokens).not.toContain('and')
	})
})

describe('bm25', () => {
	it('ranks the message that names the goal above one that does not', () => {
		const docs = [
			indexDocument('the slugify function in src/slug.mjs strips accents'),
			indexDocument('I will look at the tests next'),
		]
		const index = buildIndex(docs)
		const query = tokenize('fix slugify accents')
		expect(bm25Score(index, docs[0] as never, query)).toBeGreaterThan(
			bm25Score(index, docs[1] as never, query),
		)
	})
})

describe('minhash', () => {
	it('calls two outputs the same when only a number moved', () => {
		const a = tokenize('npm test ran 7 tests, 7 passed, 0 failed in 312 ms with node --test test/')
		const b = tokenize('npm test ran 7 tests, 7 passed, 0 failed in 298 ms with node --test test/')
		const c = tokenize('git diff shows three files changed in src and one in test')
		expect(similarity(minhash(a), minhash(b))).toBeGreaterThan(0.6)
		expect(similarity(minhash(a), minhash(c))).toBeLessThan(0.3)
	})
})

describe('scoreMessages', () => {
	it('keeps a fact from turn 2 that turn 30 cites above chatter from turn 28', () => {
		const history: Message[] = [
			{ role: 'system', content: 'You are namzu.' },
			user('Fix the slug bug in src/slug.mjs'),
			assistant('Reading it', [{ id: 'c1', name: 'read', args: { path: 'src/slug.mjs' } }]),
			tool(
				'c1',
				'export function slugify(title) { return title.toLowerCase() } // in src/slug.mjs',
			),
		]
		for (let i = 0; i < 12; i += 1) history.push(...chatter(i))
		history.push(
			assistant('Editing src/slug.mjs slugify now', [
				{
					id: 'c2',
					name: 'edit',
					args: { path: 'src/slug.mjs', old_string: 'x', new_string: 'y' },
				},
			]),
			tool('c2', 'Edited src/slug.mjs'),
		)
		const scored = scoreMessages(history, {
			goal: 'Fix the slug bug in src/slug.mjs',
			keepRecentMessages: 2,
		})
		const fact = scored[3] as (typeof scored)[number]
		const noise = scored[history.length - 5] as (typeof scored)[number]
		expect(fact.role).toBe('tool')
		expect(fact.utility).toBeGreaterThan(0)
		expect(fact.relevance).toBeGreaterThan(noise.relevance)
		expect(fact.salience).toBeGreaterThan(noise.salience)
	})

	it('demotes the older of two identical reads and keeps the newer', () => {
		const history: Message[] = [
			{ role: 'system', content: 'You are namzu.' },
			user('look at package.json twice'),
			assistant(null, [{ id: 'c1', name: 'read', args: { path: 'package.json' } }]),
			tool('c1', '{ "name": "todo-cli", "scripts": { "test": "node --test" } }'),
			...chatter(1),
			...chatter(2),
			assistant(null, [{ id: 'c2', name: 'read', args: { path: 'package.json' } }]),
			tool('c2', '{ "name": "todo-cli", "scripts": { "test": "node --test" } }'),
			assistant('done'),
		]
		const scored = scoreMessages(history, { goal: 'look at package.json', keepRecentMessages: 1 })
		expect((scored[3] as never as { redundancy: number }).redundancy).toBe(1)
		expect((scored[history.length - 2] as never as { redundancy: number }).redundancy).toBe(0)
		expect((scored[3] as never as { salience: number }).salience).toBeLessThan(
			(scored[history.length - 2] as never as { salience: number }).salience,
		)
	})

	it('protects the floor, a retained turn with its pair, and the recent tail whatever their scores', () => {
		const history: Message[] = [
			{ role: 'system', content: 'You are namzu.' },
			{ role: 'system', content: 'Working memory.' },
			user('the account id is acc_42, never bill another', true),
			assistant(null, [{ id: 'c1', name: 'read', args: { path: 'a' } }]),
			tool('c1', 'unrelated output nobody cites'),
			...chatter(1),
			...chatter(2),
			...chatter(3),
			assistant(null, [{ id: 'c9', name: 'bash', args: { command: 'npm test' } }]),
			tool('c9', 'ok'),
		]
		const scored = scoreMessages(history, { goal: 'ship it', keepRecentMessages: 2 })
		expect(scored.slice(0, 2).map((s) => s.protected)).toEqual(['system-floor', 'system-floor'])
		expect(scored[2]?.protected).toBe('retain')
		expect(scored[scored.length - 1]?.protected).toBe('recent')
		expect(scored[scored.length - 2]?.protected).toBe('recent')
		// The unrelated read in the middle is nobody's: evictable.
		expect(scored[4]?.protected).toBeNull()
		// A tool result whose call sits in the recent tail is protected as its pair.
		const paired = scoreMessages(history, { goal: 'ship it', keepRecentMessages: 1 })
		expect(paired[paired.length - 2]?.protected).toBe('pair')
	})

	it('finds a file by its stem, so "store" reaches src/store.mjs', () => {
		const history: Message[] = [
			user('change the store'),
			tool('c1', 'contents of src/store.mjs: export function addTodo() {}'),
			tool('c2', 'contents of README.md: a tiny todo list'),
			assistant('ok'),
		]
		const scored = scoreMessages(history, { goal: 'change the store', keepRecentMessages: 1 })
		expect((scored[1] as never as { relevance: number }).relevance).toBeGreaterThan(
			(scored[2] as never as { relevance: number }).relevance,
		)
	})
})
