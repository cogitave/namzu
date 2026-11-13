import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	MockLLMProvider,
	type MockTurn,
	ProviderRegistry,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	type CliSessions,
	closeSessions,
	loadResumableConversation,
	openSessions,
	readConversationRecords,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, createAgentSession } from '../agent.js'

/**
 * A conversation that used a skill with hooks and is continued gets them back
 * before its first tool call, through the real session, a scripted model and
 * a real hook command; a conversation that never used one reads nothing and
 * writes nothing for skills.
 */

const { restoreCalls, factReads } = vi.hoisted(() => ({
	restoreCalls: { count: 0 },
	factReads: { count: 0 },
}))
vi.mock('../../skills/restore-skill-hooks.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../skills/restore-skill-hooks.js')>()
	return {
		...actual,
		restoreSkillHooks: (...args: Parameters<typeof actual.restoreSkillHooks>) => {
			restoreCalls.count += 1
			return actual.restoreSkillHooks(...args)
		},
		readSkillNow: (...args: Parameters<typeof actual.readSkillNow>) => actual.readSkillNow(...args),
	}
})
vi.mock('../../integrations/sessions/store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/sessions/store.js')>()
	return {
		...actual,
		readConversationFacts: (...args: Parameters<typeof actual.readConversationFacts>) => {
			factReads.count += 1
			return actual.readConversationFacts(...args)
		},
	}
})

const roots: string[] = []
const opened: AgentSession[] = []
const catalogues: CliSessions[] = []
afterEach(async () => {
	for (const session of opened.splice(0)) await session.close()
	for (const sessions of catalogues.splice(0)) closeSessions(sessions)
	vi.restoreAllMocks()
	restoreCalls.count = 0
	factReads.count = 0
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: 'gpt-4o' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.openai,
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

const GUARD = [
	'hooks:',
	'  PreToolUse:',
	'    - matcher: Bash',
	'      hooks:',
	'        - type: command',
	'          command: echo "the skill guard refuses this" >&2; exit 2',
]

function writeSkill(cwd: string, hookLines: readonly string[]): string {
	const dir = join(cwd, '.namzu', 'skills', 'guarded')
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'SKILL.md'),
		[
			'---',
			'name: guarded',
			'description: guards its shell',
			...hookLines,
			'---',
			'Be careful.',
		].join('\n'),
	)
	return dir
}

const user = (text: string) => ({ role: 'user', content: text }) as Message
const assistant = (text: string, call?: string) =>
	({
		role: 'assistant',
		content: text,
		...(call
			? {
					toolCalls: [
						{
							id: call,
							type: 'function',
							function: { name: 'skill', arguments: '{"name":"guarded"}' },
						},
					],
				}
			: {}),
	}) as Message

async function conversationThatUsedTheSkill(skillDirectory: string | undefined) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-skill-back-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd, {
		stateRoot: await mkdtemp(join(tmpdir(), 'namzu-skill-back-home-')),
	})
	roots.push(sessions.root)
	catalogues.push(sessions)
	const id = await startConversation(sessions)
	await recordTurn(
		sessions,
		id,
		[
			user('use the guarded skill'),
			assistant('', 'call_skill'),
			{ role: 'tool', toolCallId: 'call_skill', content: 'Be careful.' } as Message,
			assistant('loaded'),
		],
		skillDirectory === undefined
			? {}
			: {
					records: [
						{
							type: 'skill_hooks_attached',
							ignorable: true,
							skill: 'guarded',
							directory: skillDirectory,
							grantsWithheld: false,
							toolCallId: 'call_skill',
						},
					],
				},
	)
	return { cwd, sessions, id }
}

async function continueIt(
	setup: { cwd: string; sessions: CliSessions; id: Awaited<ReturnType<typeof startConversation>> },
	turns: MockTurn[],
	prompt = 'now run ls',
) {
	// A turn that has history first makes one small request to look the history up;
	// the fake answers it on its own terms, then the scripted turns follow.
	const provider = new MockLLMProvider({ turns: [HISTORY_LOOKUP, ...turns] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const session = await createAgentSession(preferences, detected, {
		cwd: setup.cwd,
		stateRoot: setup.sessions.root,
		conversationSessions: setup.sessions,
		scope: {
			sessionId: setup.id,
			topicId: setup.sessions.topicId,
			projectId: setup.sessions.projectId,
			tenantId: setup.sessions.tenantId,
		},
		sandbox: { enabled: false },
		memory: { recall: false },
		folderTrusted: true,
	})
	opened.push(session)
	const lines: string[] = []
	session.skillHooks?.subscribe((line) => lines.push(line))
	const history = await loadResumableConversation(setup.sessions, setup.id)
	for await (const _event of session.send([...history, createUserMessage(prompt)], {
		permissionMode: 'auto',
	})) {
		// drain
	}
	return { provider, session, lines }
}

const HISTORY_LOOKUP: MockTurn = { text: '{"mode":"none"}' }
const bashLs: MockTurn = { toolCalls: [{ id: 'run-1', name: 'bash', args: { command: 'ls' } }] }

function toolResultOf(provider: MockLLMProvider, id: string): string {
	const message = provider.requests
		.flatMap((request) => request.messages)
		.find((candidate) => candidate.role === 'tool' && candidate.toolCallId === id)
	return String(message?.content ?? '')
}

describe('a continued conversation that used a skill with a guard', () => {
	it('refuses the forbidden command: the guard is back before the first tool call', async () => {
		const setup = await conversationThatUsedTheSkill(undefined)
		const dir = writeSkill(setup.cwd, GUARD)
		// The record is written after the file exists, as a real use would.
		await recordTurn(setup.sessions, setup.id, [user('again'), assistant('ok')], {
			records: [
				{
					type: 'skill_hooks_attached',
					ignorable: true,
					skill: 'guarded',
					directory: dir,
					grantsWithheld: false,
				},
			],
		})
		const { provider, session, lines } = await continueIt(setup, [bashLs, { text: 'done' }])
		expect(toolResultOf(provider, 'run-1')).toContain('the skill guard refuses this')
		expect(session.skillHooks?.attached().map((row) => row.skill)).toEqual(['guarded'])
		expect(lines).toEqual([])
	})

	it('is told, to the person and to the model, when the skill file is gone: the command is not guarded', async () => {
		const setup = await conversationThatUsedTheSkill(undefined)
		const dir = writeSkill(setup.cwd, GUARD)
		await recordTurn(setup.sessions, setup.id, [user('again'), assistant('ok')], {
			records: [
				{
					type: 'skill_hooks_attached',
					ignorable: true,
					skill: 'guarded',
					directory: dir,
					grantsWithheld: false,
				},
			],
		})
		await rm(dir, { recursive: true })
		const { provider, session, lines } = await continueIt(setup, [bashLs, { text: 'done' }])
		expect(toolResultOf(provider, 'run-1')).not.toContain('the skill guard refuses this')
		expect(session.skillHooks?.attached()).toEqual([])
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('Skill guarded')
		expect(lines[0]).toContain('its file is gone')
		const told = provider.requests
			.flatMap((request) => request.messages)
			.map((message) => (typeof message.content === 'string' ? message.content : ''))
			.join('\n')
		expect(told).toContain(String(lines[0]))
	})

	it('attaches them once for the conversation: a later turn does not attach them a second time', async () => {
		const setup = await conversationThatUsedTheSkill(undefined)
		const dir = writeSkill(setup.cwd, GUARD)
		await recordTurn(setup.sessions, setup.id, [user('again'), assistant('ok')], {
			records: [
				{
					type: 'skill_hooks_attached',
					ignorable: true,
					skill: 'guarded',
					directory: dir,
					grantsWithheld: false,
				},
			],
		})
		const { session } = await continueIt(setup, [
			bashLs,
			{ text: 'done' },
			HISTORY_LOOKUP,
			{ text: 'and done again' },
		])
		const history = await loadResumableConversation(setup.sessions, setup.id)
		for await (const _event of session.send([...history, createUserMessage('and again')], {
			permissionMode: 'auto',
		})) {
			// drain
		}
		expect(session.skillHooks?.attached()).toHaveLength(1)
		expect(restoreCalls.count).toBe(1)
	})
})

describe('a conversation that never used a skill with hooks', () => {
	it('reads nothing and writes nothing for skills, whether it is new or continued', async () => {
		// New: one prompt, no earlier turn, a skill with hooks sits in the folder unused.
		const fresh = await conversationThatUsedTheSkill(undefined)
		writeSkill(fresh.cwd, GUARD)
		const emptyId = await startConversation(fresh.sessions)
		const provider = new MockLLMProvider({ turns: [{ text: 'hello' }] })
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const session = await createAgentSession(preferences, detected, {
			cwd: fresh.cwd,
			stateRoot: fresh.sessions.root,
			conversationSessions: fresh.sessions,
			scope: {
				sessionId: emptyId,
				topicId: fresh.sessions.topicId,
				projectId: fresh.sessions.projectId,
				tenantId: fresh.sessions.tenantId,
			},
			sandbox: { enabled: false },
			memory: { recall: false },
			folderTrusted: true,
		})
		opened.push(session)
		const before = factReads.count
		for await (const _event of session.send([createUserMessage('hi')], {
			permissionMode: 'auto',
		})) {
			// drain
		}
		expect(factReads.count - before, 'no conversation facts were read for skills').toBe(0)
		expect(restoreCalls.count).toBe(0)
		expect(session.skillHooks?.attached()).toEqual([])

		// Continued, with turns but no skill record: the log is looked at, no skill file is read.
		const continued = await continueIt(fresh, [{ text: 'fine' }])
		expect(restoreCalls.count).toBe(0)
		expect(continued.session.skillHooks?.attached()).toEqual([])
		expect(continued.lines).toEqual([])
		const records = (await readConversationRecords(fresh.sessions, fresh.id))?.records ?? []
		expect(records.filter((record) => record.type === 'skill_hooks_attached')).toEqual([])
	})
})
