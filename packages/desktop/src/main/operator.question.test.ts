import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { DesktopEvent, PermissionView } from '../shared/protocol.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
})

const QUESTION = {
	questionId: 'toolu_1',
	question: 'Who is the audience?',
	header: 'Audience',
	multiSelect: false,
	allowFreeText: true,
	options: [
		{ id: 'opt_1', label: 'Board', recommended: true },
		{ id: 'opt_2', label: 'Engineers', description: 'Details and diagrams' },
	],
	questions: [
		{
			id: 'toolu_1#0',
			question: 'Who is the audience?',
			header: 'Audience',
			multiSelect: false,
			allowFreeText: true,
			options: [
				{ id: 'opt_1', label: 'Board', recommended: true },
				{ id: 'opt_2', label: 'Engineers', description: 'Details and diagrams' },
			],
		},
	],
}

function harness(extraEnv: Record<string, string> = {}) {
	const events = new EventEmitter()
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: { ...process.env, FIXTURE_QUESTION: JSON.stringify(QUESTION), ...extraEnv },
		},
		(event) => events.emit('update', event),
	)
	operators.push(owner)
	const wait = (predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (predicate(event)) {
					events.off('update', receive)
					resolve(event)
				}
			}
			events.on('update', receive)
		})
	const question = async (): Promise<PermissionView> => {
		const event = await wait((event) => event.kind === 'permission')
		if (event.kind !== 'permission') throw new Error('Missing question')
		return event.request
	}
	return { owner, wait, question }
}

it('shows a question the agent asked as a waiting request that is named for the question tool', async () => {
	const { owner, question } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = question()
	const sent = owner.send(session.id, 'make the deck')
	const request = await asked
	// The conversation row reads it as "Question waiting" and never as an approval.
	expect(request.calls).toHaveLength(1)
	expect(request.calls[0]).toMatchObject({ name: 'ask_user_question', alwaysAsk: true })
	expect(request.question?.questions[0]).toMatchObject({
		id: 'toolu_1#0',
		question: 'Who is the audience?',
		multiSelect: false,
		allowFreeText: true,
	})
	expect(request.question?.questions[0]?.options[0]).toMatchObject({
		id: 'opt_1',
		label: 'Board',
		recommended: true,
	})
	expect(owner.needsYou()).toEqual([session.id])
	await owner.cancel(session.id)
	await sent
})

it('sends the answer to the engine before the card goes away, and a second answer finds nothing open', async () => {
	const { owner, question, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = question()
	const sent = owner.send(session.id, 'make the deck')
	const request = await asked
	const cleared = wait(
		(event) => event.kind === 'permission-cleared' && event.requestId === request.id,
	)
	const ended = wait(
		(event) => event.kind === 'state' && event.sessionId === session.id && !event.running,
	)
	await owner.answerQuestion(session.id, request.id, {
		kind: 'answer',
		answers: [
			{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_2'], freeText: '  the sales team ' },
		],
	})
	await cleared
	await ended
	await sent
	// The engine got the shape its relay reads: every answer by question, the words trimmed.
	const reply = (await owner.openConversation(project.id, session.id)).thread?.messages.at(-1)
	expect(reply).toMatchObject({ role: 'assistant' })
	expect((reply as { text: string }).text).toBe(
		`Answer: ${JSON.stringify({
			kind: 'answer',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_1#0', selectedOptionIds: ['opt_2'], freeText: 'the sales team' },
			],
		})}`,
	)
	await expect(owner.answerQuestion(session.id, request.id, { kind: 'skip' })).rejects.toThrow(
		'no longer open',
	)
	expect(owner.needsYou()).toEqual([])
})

it('refuses a yes or a no as the answer to a question, and an answer that does not read, and keeps the card', async () => {
	const { owner, question } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = question()
	const sent = owner.send(session.id, 'make the deck')
	const request = await asked
	expect(() => owner.respondPermission(session.id, request.id, { outcome: 'approve' })).toThrow(
		'is a question',
	)
	await expect(
		owner.answerQuestion(session.id, request.id, { kind: 'answer', answers: [{ questionId: 7 }] }),
	).rejects.toThrow('Invalid answer')
	await expect(
		owner.answerQuestion(session.id, request.id, {
			kind: 'answer',
			answers: [{ questionId: 'toolu_1#0', selectedOptionIds: [], freeText: 'x'.repeat(4001) }],
		}),
	).rejects.toThrow('under 4,000')
	// Neither refusal consumed it: it is still open and answerable.
	await owner.answerQuestion(session.id, request.id, { kind: 'skip' })
	await sent
})

it('closes the card when the reply is stopped while the question waits', async () => {
	const { owner, question, wait } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = question()
	const sent = owner.send(session.id, 'make the deck')
	const request = await asked
	const cleared = wait(
		(event) => event.kind === 'permission-cleared' && event.sessionId === session.id,
	)
	await owner.cancel(session.id)
	await cleared
	await sent
	await expect(owner.answerQuestion(session.id, request.id, { kind: 'skip' })).rejects.toThrow(
		'no longer open',
	)
})

const SKILL_CARD = {
	name: 'release-notes',
	description: 'Write release notes. Use when asked for release notes.',
	file: '---\nname: release-notes\n---\n\n1. List merged PRs.',
	hiddenCharacters: false,
	warnings: [],
	suggested: 'user',
	targets: [
		{ scope: 'user', path: '~/.namzu/skills/release-notes/SKILL.md', shadows: [] },
		{ scope: 'project', path: './.namzu/skills/release-notes/SKILL.md', shadows: [] },
	],
	shadowsExisting: false,
}

it('carries a skill the agent drafted on the waiting request, and answers it like any question', async () => {
	const { owner, question, wait } = harness({ FIXTURE_SKILL_SAVE: JSON.stringify(SKILL_CARD) })
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = question()
	const sent = owner.send(session.id, 'save the skill')
	const request = await asked
	expect(request.skillSave).toMatchObject({ name: 'release-notes', suggested: 'user' })
	expect(request.skillSave?.targets.map((target) => target.scope)).toEqual(['user', 'project'])
	// It waits for the person: it is a question, never answered by an approval.
	expect(owner.needsYou()).toEqual([session.id])
	expect(() => owner.respondPermission(session.id, request.id, { outcome: 'approve' })).toThrow(
		'answer it with its own card',
	)
	const cleared = wait(
		(event) => event.kind === 'permission-cleared' && event.requestId === request.id,
	)
	await owner.answerQuestion(session.id, request.id, {
		kind: 'answer',
		answers: [{ questionId: 'skill-save', selectedOptionIds: ['project'] }],
	})
	await cleared
	await sent
})

it('leaves a plain question without a skill', async () => {
	const { owner, question } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const asked = question()
	const sent = owner.send(session.id, 'make the deck')
	expect((await asked).skillSave).toBeUndefined()
	await owner.cancel(session.id)
	await sent
})
