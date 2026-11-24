import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	ACPServer,
	ACP_PERMISSION_CAPABILITY,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	type Message,
	ToolManager,
	createToolPresenter,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeTempDir, removeTempDir } from '../../__fixtures__/temp-dir.js'
import { composeEnvironmentPrompt, skillFactLines } from '../../context/environment.js'
import { SKILLS_HOST_COMMAND, type skillSaveCardPayload } from '../../skills/save-card.js'
import { buildSaveSkillTool, newSkillPrompt, savedSkillLabel } from '../../skills/save.js'
import type { AgentSessionOptions, SendOptions } from '../../tui/agent.js'
import {
	QUESTION_CLOSED_NOTIFICATION,
	QUESTION_NOTIFICATION,
	createQuestionRelay,
	pickedSkillTarget,
} from '../acp-desktop-question.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime, resolveAcpSession } from '../acp.js'
import type { CommandContext } from '../types.js'

/**
 * The desktop's `save_skill`: the model drafts, the app draws the whole file on a card, and only
 * the person's own pick of a place writes it. The relay is not a permission request, so no
 * permission mode (`auto` included) has a way to answer it.
 */

let home: string
let cwd: string
beforeEach(() => {
	home = makeTempDir('namzu-skillcard-home-')
	cwd = makeTempDir('namzu-skillcard-cwd-')
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
})

const draft = {
	name: 'release-notes',
	description: 'Write release notes from merged PRs. Use when the user asks for release notes.',
	body: '# Release notes\n\n1. List merged PRs.\n2. Group them.',
}

function setup() {
	const notices: { method: string; params: Record<string, unknown> }[] = []
	const relay = createQuestionRelay((method, params) => notices.push({ method, params }))
	const tool = buildSaveSkillTool({
		cwd: () => cwd,
		home: () => home,
		sessionId: () => 'session-a',
		confirm: relay.skillSaveConfirm('session-a', () => cwd),
	})
	const run = (signal?: AbortSignal) =>
		tool.execute(
			tool.inputSchema.parse(draft) as never,
			{ abortSignal: signal } as never,
		) as Promise<{
			success: boolean
			output: string
			data?: { cancelled?: boolean; path?: string }
		}>
	const card = () => notices.find((n) => n.method === QUESTION_NOTIFICATION)
	const reply = (selected: string[]) =>
		relay.answer('session-a', card()?.params.requestId as string, {
			kind: 'answer',
			selectedOptionIds: [],
			answers: [{ questionId: 'skill-save', selectedOptionIds: selected }],
		})
	return { notices, relay, run, card, reply }
}

const userFile = () => join(home, '.namzu', 'skills', 'release-notes', 'SKILL.md')
const projectFile = () => join(cwd, '.namzu', 'skills', 'release-notes', 'SKILL.md')

describe('the skill-save request', () => {
	it('says the whole file, the targets and the options, and writes nothing while it waits', async () => {
		const { run, card, reply } = setup()
		const done = run()
		const sent = card()
		expect(sent).toBeDefined()
		const payload = sent?.params.skillSave as ReturnType<typeof skillSaveCardPayload>
		expect(payload.name).toBe('release-notes')
		expect(payload.file).toContain('name: release-notes')
		expect(payload.file).toContain('1. List merged PRs.')
		expect(payload.targets.map((t) => t.scope)).toEqual(['user', 'project'])
		expect(payload.targets[1]?.path).toContain('.namzu')
		expect(payload.shadowsExisting).toBe(false)
		const question = (sent?.params.question as { questions: { options: { id: string }[] }[] })
			.questions[0]
		expect(question?.options.map((o) => o.id)).toEqual(['user', 'project', 'cancel'])
		expect(existsSync(userFile())).toBe(false)
		expect(existsSync(projectFile())).toBe(false)
		// Only the person's answer settles it.
		reply(['cancel'])
		await done
	})

	it('saves to the person’s own skills only when they pick it', async () => {
		const { run, reply } = setup()
		const done = run()
		expect(reply(['user'])).toBe(true)
		const result = await done
		expect(result.success).toBe(true)
		expect(readFileSync(userFile(), 'utf8')).toContain('1. List merged PRs.')
		expect(existsSync(projectFile())).toBe(false)
		expect(result.output).toContain('next turn')
	})

	it('saves to the project when they pick that', async () => {
		const { run, reply } = setup()
		const done = run()
		reply(['project'])
		expect((await done).success).toBe(true)
		expect(existsSync(projectFile())).toBe(true)
		expect(existsSync(userFile())).toBe(false)
	})

	it('writes nothing on cancel, skip, abort or an answer that names no place', async () => {
		for (const answer of [['cancel'], ['both'], ['user', 'project'], []] as const) {
			const { run, reply } = setup()
			const done = run()
			reply([...answer])
			const result = await done
			expect(result.success).toBe(false)
			expect(result.data?.cancelled).toBe(true)
		}
		for (const response of [{ kind: 'skip' }, { kind: 'abort' }] as const) {
			const { run, relay, card } = setup()
			const done = run()
			relay.answer('session-a', card()?.params.requestId as string, response)
			expect((await done).data?.cancelled).toBe(true)
		}
		expect(existsSync(userFile())).toBe(false)
		expect(existsSync(projectFile())).toBe(false)
	})

	it('cancels, and closes the card, when the turn stops while the person is deciding', async () => {
		const { run, notices, card } = setup()
		const controller = new AbortController()
		const done = run(controller.signal)
		controller.abort()
		expect((await done).data?.cancelled).toBe(true)
		expect(notices.some((n) => n.method === QUESTION_CLOSED_NOTIFICATION)).toBe(true)
		expect(card()).toBeDefined()
		expect(existsSync(userFile())).toBe(false)
	})

	it('does not take an answer from another conversation', async () => {
		const { run, relay, card, reply } = setup()
		const done = run()
		expect(
			relay.answer('session-b', card()?.params.requestId as string, {
				kind: 'answer',
				selectedOptionIds: ['user'],
			}),
		).toBe(false)
		reply(['cancel'])
		await done
	})

	it('warns when the file would replace or be hidden by an existing skill', async () => {
		mkdirSync(join(home, '.namzu', 'skills', 'release-notes'), {
			recursive: true,
		})
		writeFileSync(userFile(), '---\nname: release-notes\ndescription: older one\n---\nOld body.')
		const { run, card, reply } = setup()
		const done = run()
		const payload = card()?.params.skillSave as ReturnType<typeof skillSaveCardPayload>
		expect(payload.shadowsExisting).toBe(true)
		expect(payload.targets[0]?.shadows.join(' ')).toContain('overwrites')
		reply(['cancel'])
		await done
		expect(readFileSync(userFile(), 'utf8')).toContain('Old body.')
	})
})

describe('what the transcript says of a save', () => {
	it('gives the saved line the desktop reads its card from, and a cancelled line otherwise', async () => {
		const { run, reply } = setup()
		const tool = buildSaveSkillTool({
			cwd: () => cwd,
			home: () => home,
			sessionId: () => undefined,
			confirm: async () => 'user',
		})
		const done = run()
		reply(['user'])
		const result = await done
		const view = tool.presentResult?.(draft, result as never)
		expect(view).toMatchObject({ kind: 'generic', presentation: 'activity' })
		expect((view as { label: string }).label).toBe(
			savedSkillLabel(
				'release-notes',
				(result as { data?: { displayPath?: string } }).data?.displayPath ?? '',
			),
		)
		expect((view as { label: string }).label).toMatch(
			/^Saved skill "release-notes" to .*SKILL\.md$/,
		)
		const cancelled = tool.presentResult?.(draft, {
			success: false,
			output: '',
			data: { cancelled: true },
		} as never)
		expect(cancelled).toMatchObject({ outcome: 'cancelled' })
	})
})

describe('the tool is ready when the draft is shown', () => {
	it('rides every request, so saving is never a search first', async () => {
		const { EAGER_TOOLS_WHEN_DEFERRED } = await import('../../tui/agent.js')
		expect(EAGER_TOOLS_WHEN_DEFERRED as readonly string[]).toContain('save_skill')
	})
})

describe('pickedSkillTarget', () => {
	it('is a place only for exactly one of user or project', () => {
		const answer = (ids: string[]) =>
			({
				kind: 'answer',
				selectedOptionIds: [],
				answers: [{ questionId: 'skill-save', selectedOptionIds: ids }],
			}) as const
		expect(pickedSkillTarget(answer(['user']))).toBe('user')
		expect(pickedSkillTarget(answer(['project']))).toBe('project')
		expect(pickedSkillTarget(answer(['cancel']))).toBe('cancel')
		expect(pickedSkillTarget(answer(['user', 'project']))).toBe('cancel')
		expect(pickedSkillTarget({ kind: 'skip' })).toBe('cancel')
		expect(
			pickedSkillTarget({
				kind: 'answer',
				selectedOptionIds: [],
				answers: [{ questionId: 'other', selectedOptionIds: ['user'] }],
			}),
		).toBe('cancel')
	})
})

describe('what the engine tells the model and the app about skills', () => {
	it('registers a `skills` command the app’s composer offers, spelled as keywords', async () => {
		const commands = new HostCommandRegistry()
		commands.register(SKILLS_HOST_COMMAND)
		const listed = commands.describe()
		expect(listed.map((c) => c.name)).toEqual(['skills'])
		expect(listed[0]?.hint).toBe('new [what the skill should do]')
		expect(JSON.stringify(listed)).not.toContain('-')
		const outcome = await commands.dispatch('/skills new weekly report')
		expect(outcome).toEqual({
			kind: 'prompt',
			text: newSkillPrompt('weekly report'),
		})
		expect((await commands.dispatch('/skills'))?.kind).toBe('refused')
	})

	it('says to save with the tool where there is one, and never sends a person to a terminal', () => {
		const facts = (save: boolean) => skillFactLines(save).join('\n')
		expect(facts(true)).toContain('save_skill')
		expect(facts(true)).toContain('without exploring the file system')
		expect(facts(true)).toContain('Do not tell them to open a terminal')
		expect(facts(false)).toContain('saving is not available in this place')
		expect(facts(false)).not.toMatch(/\/skills new|run (it )?in (a|the) terminal/i)
		const prompt = composeEnvironmentPrompt({ host: 'desktop', skills: { save: true } } as never, {
			stable: true,
		})
		expect(prompt).toContain('skill-creator')
		expect(prompt).toContain('Never write a SKILL.md into a skills folder by hand')
	})

	it('has a skill-creator that no longer sends anyone to a terminal', () => {
		const text = readFileSync(
			new URL('../../../skills/skill-creator/SKILL.md', import.meta.url),
			'utf8',
		).replace(/\s+/g, ' ')
		expect(text).not.toMatch(/tell the operator to run/i)
		expect(text).not.toContain('interactive terminal')
		expect(text).toContain('saving is not available in this place')
		expect(text).toContain('do not explore the file system')
	})
})

describe('which sessions are offered save_skill', () => {
	async function sessionOptions(announce: boolean): Promise<AgentSessionOptions> {
		const seen: AgentSessionOptions[] = []
		const sent: MCPJsonRpcMessage[] = []
		let handler: ((message: MCPJsonRpcMessage) => void) | undefined
		const waiting = new Map<string | number, (message: MCPJsonRpcMessage) => void>()
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			send: async (message) => {
				sent.push(message)
				if (message.id !== undefined) waiting.get(message.id)?.(message)
			},
			onMessage: (next) => {
				handler = next
			},
			onClose: () => {},
			onError: () => {},
			isConnected: () => true,
		}
		const reply = (id: number) =>
			new Promise<MCPJsonRpcMessage>((resolve) => {
				const earlier = sent.find((m) => m.id === id)
				if (earlier) resolve(earlier)
				else waiting.set(id, resolve)
			})
		const deps = {
			probe: vi.fn(async () => ({
				preferences: {
					version: 3,
					providers: [{ id: 'mock' }],
					subagents: { active: [] },
				},
				needsRepickReason: null,
				detected: [],
			})),
			createSession: vi.fn(async (_p: unknown, _d: unknown, options: AgentSessionOptions) => {
				seen.push(options)
				return {
					hasProvider: true as const,
					errorHint: null,
					mcpFailed: [],
					close: async () => {},
					send: async function* (_messages: readonly Message[], _send?: SendOptions) {
						yield { kind: 'done', stopReason: 'end_turn' } as const
					},
				}
			}),
			decideTrust: ({ cwd: dir }: { cwd: string }) => ({
				allowed: true as const,
				cwd: dir,
			}),
			resolveProjectContext: (ctx: CommandContext) => ctx,
			resolveSession: (id: string) => resolveAcpSession(id, async () => undefined),
		} as unknown as AcpRuntimeDependencies
		const runtime = createCliAcpRuntime(
			{
				config: {},
				formatter: {
					name: 'text',
					print: () => {},
					info: () => {},
					error: () => {},
				},
			} as CommandContext,
			deps,
			announce ? { announce: () => {} } : {},
		)
		const server = new ACPServer({
			transport,
			gateway: runtime.gateway,
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
			agentInfo: { name: 'namzu', version: 'test' },
			newSessionId: () => 'session-a',
		})
		await server.start()
		handler?.({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: [ACP_PERMISSION_CAPABILITY] },
		})
		await reply(1)
		handler?.({
			jsonrpc: '2.0',
			id: 2,
			method: 'session/new',
			params: { cwd: '/canonical/a' },
		})
		await reply(2)
		handler?.({
			jsonrpc: '2.0',
			id: 3,
			method: 'session/prompt',
			params: { sessionId: 'session-a', prompt: 'can you create a skill?' },
		})
		await reply(3)
		await server.stop()
		await runtime.close()
		const first = seen[0]
		if (!first) throw new Error('no session was created')
		return first
	}

	it('gives the desktop host the tool, with the question relay behind it', async () => {
		const options = await sessionOptions(true)
		expect((options.extraTools ?? []).map((tool) => tool.name)).toEqual(['save_skill'])
	})

	it('leaves it out of a host with no app to confirm in', async () => {
		const options = await sessionOptions(false)
		expect(options.extraTools).toBeUndefined()
	})
})
