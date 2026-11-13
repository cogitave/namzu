import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import {
	forkConversation,
	forkConversationBeforeUser,
	loadConversation,
	openSessions,
	readConversationFacts,
	skillHooksCarriedBy,
	startConversation,
} from '../store.js'

/**
 * The skills whose hooks a conversation attached are kept in its own log
 * (`skill_hooks_attached`), read back by the lean fold, and carried into a copy:
 * all of them into a fork, and into a branch from an earlier prompt only the ones
 * whose `skill` call the branch still holds.
 */

async function project() {
	return openSessions(mkdtempSync(join(tmpdir(), 'namzu-skill-facts-')), {
		stateRoot: mkdtempSync(join(tmpdir(), 'namzu-skill-facts-home-')),
	})
}

const user = (content: string) => ({ role: 'user', content }) as Message
const assistant = (content: string, call?: string) =>
	({
		role: 'assistant',
		content,
		...(call
			? {
					toolCalls: [
						{ id: call, type: 'function', function: { name: 'skill', arguments: '{"name":"x"}' } },
					],
				}
			: {}),
	}) as Message
const result = (call: string) =>
	({ role: 'tool', toolCallId: call, content: 'skill text' }) as Message

const kept = (skill: string, call: string, extra: Record<string, unknown> = {}) => ({
	type: 'skill_hooks_attached',
	ignorable: true,
	skill,
	directory: `/skills/${skill}`,
	grantsWithheld: false,
	toolCallId: call,
	...extra,
})

/** Two prompts, each loading one skill. */
async function twoSkillConversation() {
	const s = await project()
	const id = await startConversation(s)
	await recordTurn(
		s,
		id,
		[user('first'), assistant('', 'call_a'), result('call_a'), assistant('ok')],
		{
			records: [kept('alpha', 'call_a')],
		},
	)
	await recordTurn(
		s,
		id,
		[user('second'), assistant('', 'call_b'), result('call_b'), assistant('ok')],
		{
			records: [kept('beta', 'call_b', { grantsWithheld: true })],
		},
	)
	return { s, id }
}

describe('the skills a conversation attached hooks for', () => {
	it('are read back from the log, oldest first, with their folder and whether grants were withheld', async () => {
		const { s, id } = await twoSkillConversation()
		for (const mode of ['strict', 'tolerant'] as const) {
			const facts = await readConversationFacts(s, id, mode)
			expect(facts?.skillHooks).toEqual([
				{
					skill: 'alpha',
					directory: '/skills/alpha',
					grantsWithheld: false,
					toolCallId: 'call_a',
					toolCallIds: ['call_a'],
				},
				{
					skill: 'beta',
					directory: '/skills/beta',
					grantsWithheld: true,
					toolCallId: 'call_b',
					toolCallIds: ['call_b'],
				},
			])
		}
	})

	it('count a skill used again once, by its latest use', async () => {
		const { s, id } = await twoSkillConversation()
		await recordTurn(s, id, [user('third'), assistant('ok')], {
			records: [kept('alpha', 'call_c', { directory: '/moved/alpha' })],
		})
		const facts = await readConversationFacts(s, id, 'strict')
		expect(facts?.skillHooks.map((fact) => [fact.skill, fact.directory])).toEqual([
			['beta', '/skills/beta'],
			['alpha', '/moved/alpha'],
		])
	})

	it('are none for a conversation that never used one', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [user('hello'), assistant('hi')])
		expect((await readConversationFacts(s, id, 'strict'))?.skillHooks).toEqual([])
	})

	it('go with a fork of the whole conversation', async () => {
		const { s, id } = await twoSkillConversation()
		const forked = await forkConversation(s, id)
		const facts = await readConversationFacts(s, forked.id, 'strict')
		expect(facts?.skillHooks.map((fact) => fact.skill)).toEqual(['alpha', 'beta'])
		expect(facts?.skillHooks[1]).toMatchObject({ grantsWithheld: true, directory: '/skills/beta' })
	})

	it('go with a branch from an earlier prompt only for the skills the branch still holds', async () => {
		const { s, id } = await twoSkillConversation()
		const history = await loadConversation(s, id)
		const secondPrompt = history.filter((message) => message.role === 'user')[1] as Message
		const branch = await forkConversationBeforeUser(s, id, 1, secondPrompt as never)
		const facts = await readConversationFacts(s, branch.id, 'strict')
		expect(facts?.skillHooks.map((fact) => fact.skill)).toEqual(['alpha'])
	})

	it('go with a branch cut before a later use of a skill it used earlier', async () => {
		const { s, id } = await twoSkillConversation()
		await recordTurn(
			s,
			id,
			[user('third'), assistant('', 'call_c'), result('call_c'), assistant('ok')],
			{ records: [kept('alpha', 'call_c')] },
		)
		const history = await loadConversation(s, id)
		const secondPrompt = history.filter((message) => message.role === 'user')[1] as Message
		const branch = await forkConversationBeforeUser(s, id, 1, secondPrompt as never)
		const facts = await readConversationFacts(s, branch.id, 'strict')
		expect(facts?.skillHooks.map((fact) => fact.skill)).toEqual(['alpha'])
		// A branch of that branch, cut again, still places it by its first use.
		expect(facts?.skillHooks[0]?.toolCallIds).toEqual(['call_a'])
	})

	it('go with a branch before the first prompt for none', async () => {
		const { s, id } = await twoSkillConversation()
		const history = await loadConversation(s, id)
		const first = history.find((message) => message.role === 'user') as Message
		const branch = await forkConversationBeforeUser(s, id, 0, first as never)
		const facts = await readConversationFacts(s, branch.id, 'strict')
		expect(facts?.skillHooks).toEqual([])
	})
})

describe('which skills a copy carries', () => {
	const fact = (skill: string, toolCallId?: string) => ({
		skill,
		directory: `/skills/${skill}`,
		grantsWithheld: false,
		...(toolCallId ? { toolCallId } : {}),
	})

	it('keeps one it cannot place: no call id, or a call that was compacted out of the history', () => {
		const source = [user('q'), assistant('', 'call_new'), result('call_new')]
		const copy = [user('q')]
		const kept = skillHooksCarriedBy(
			[fact('no-id'), fact('compacted', 'call_old'), fact('later', 'call_new')],
			source,
			copy,
		)
		expect(kept.map((entry) => entry.skill)).toEqual(['no-id', 'compacted'])
	})

	it('keeps a skill used again after the cut, by its earlier use', () => {
		const source = [
			user('q1'),
			assistant('', 'call_a'),
			result('call_a'),
			user('q2'),
			assistant('', 'call_b'),
			result('call_b'),
		]
		const copy = source.slice(0, 3)
		const kept = skillHooksCarriedBy(
			[{ ...fact('twice', 'call_b'), toolCallIds: ['call_a', 'call_b'] }, fact('once', 'call_b')],
			source,
			copy,
		)
		expect(kept.map((entry) => [entry.skill, entry.toolCallIds ?? []])).toEqual([
			['twice', ['call_a']],
		])
	})

	it('keeps all of them when the whole conversation is copied', () => {
		const source = [user('q'), assistant('', 'call_new'), result('call_new')]
		expect(skillHooksCarriedBy([fact('later', 'call_new')], source, source)).toHaveLength(1)
	})
})
