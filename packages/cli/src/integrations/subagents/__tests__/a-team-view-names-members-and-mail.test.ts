import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	FileTaskStore,
	type LLMProvider,
	MockLLMProvider,
	type MockTurn,
	TeamStore,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { teamNameFor } from '../../teams/runner.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { type SubagentCompletion, createSubagentRuntime } from '../runtime.js'

// A screen reads the team through one source: who is on it and in what state, the shared task list, and a
// call when something changes. What the lead sends to a member is recorded with what it is, and the person
// typing into a member's own view is told to the member as the person.

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const LOOKUP = '{"mode":"direct","time":"unspecified","termIds":[],"basis":[]}'

async function setup() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-team-view-'))
	roots.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const store = new TeamStore({ rootDir: join(cwd, 'teams') })
	const tasks = new FileTaskStore({
		listId: teamNameFor(String(parent.scope.sessionId)),
		rootDir: join(cwd, 'tasks'),
	})
	const requests: ChatCompletionParams[] = []
	const completions: SubagentCompletion[] = []
	const waiters: (() => void)[] = []
	const script = (params: ChatCompletionParams): MockTurn => {
		requests.push(params)
		if (requests.length > 30) return { text: 'script ran away' }
		const first = String(params.messages[0]?.content ?? '')
		if (first.includes('Resolve a conversation-history search query')) return { text: LOOKUP }
		const last = String(params.messages[params.messages.length - 1]?.content ?? '')
		if (last.includes('wrap up approve'))
			return { toolCalls: [{ id: 'bye', name: 'shutdown_response', args: { approve: true } }] }
		return { text: 'ready' }
	}
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		backgroundByDefault: true,
		ephemeral: true,
		resolveResumeHandler: () => async () => ({ action: 'approve_tools' }),
		teams: {
			enabled: () => ({ enabled: true, source: 'setting' }),
			limits: () => ({ maxTeammates: 5, idleExitMinutes: 30, shutdownGraceSeconds: 20 }),
			store,
			taskStoreFor: () => tasks,
			setTimer: () => 0,
			clearTimer: () => {},
		},
		buildProvider: () => {
			const mock = new MockLLMProvider({ nextTurn: script })
			return {
				id: 'worker',
				name: 'Worker',
				chatStream: (params) => mock.chatStream(params),
			} satisfies LLMProvider
		},
	})
	runtime.onBackgroundCompletion((completion) => {
		completions.push(completion)
		for (const wake of waiters.splice(0)) wake()
	})
	const context = {
		sessionId: parent.scope.sessionId,
		turnId: parent.scope.turnId,
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log() {},
	} as never
	return {
		runtime,
		context,
		tasks,
		requests,
		turnId: parent.scope.turnId,
		next: () => new Promise<void>((resolve) => waiters.push(resolve)),
	}
}

const spawn = (name: string) => ({ description: `${name} works`, prompt: `Work ${name}`, name })

it('lists a member with its state, and says so when the state changes', async () => {
	const t = await setup()
	try {
		const team = t.runtime.team
		expect(team).toBeDefined()
		expect(team?.members()).toEqual([])
		let heard = 0
		const off = team?.subscribe(() => {
			heard += 1
		})
		const done = t.next()
		await t.runtime.agentTool.execute(spawn('bob'), t.context)
		await done
		const members = team?.members() ?? []
		expect(members).toHaveLength(1)
		expect(members[0]).toMatchObject({ name: 'bob', state: 'idle' })
		expect(members[0]?.since).toBeGreaterThan(0)
		// The row the screen opens is the member's own.
		expect(t.runtime.activity.getSnapshot().some((row) => row.viewId === members[0]?.viewId)).toBe(
			true,
		)
		expect(heard).toBeGreaterThan(0)
		off?.()
	} finally {
		await t.runtime.close()
	}
})

it('gives each member a colour in the order they join, keeps it, and tells a screen the mail', async () => {
	const t = await setup()
	try {
		const team = t.runtime.team
		const mail: { from: string; to: string; kind: string }[] = []
		const off = team?.onMail?.((event) =>
			mail.push({ from: event.from, to: event.to, kind: event.kind }),
		)
		let done = t.next()
		await t.runtime.agentTool.execute(spawn('bob'), t.context)
		await done
		done = t.next()
		await t.runtime.agentTool.execute(spawn('cleo'), t.context)
		await done
		const members = team?.members() ?? []
		const colors = members.map((member) => member.color)
		expect(new Set(colors).size).toBe(2)
		// The lead holds the first colour, so no teammate has it.
		const lead = team?.colorOf?.('lead')
		expect(colors).not.toContain(lead)
		// Asking again, or in another order, gives the same colour.
		expect(team?.members().map((member) => member.color)).toEqual(colors)
		expect(team?.colorOf?.('bob')).toBe(colors[0])
		// A name the team never had gets a fixed blue or pink, not a place in the order.
		expect(['blue', '#ff69b4']).toContain(team?.colorOf?.('ghost'))
		expect(team?.members()).toHaveLength(2)
		expect(mail.filter((entry) => entry.kind === 'idle' && entry.to === 'lead').length).toBe(2)
		off?.()
	} finally {
		await t.runtime.close()
	}
})

it('reads the shared task list with owner and blockers', async () => {
	const t = await setup()
	try {
		const done = t.next()
		await t.runtime.agentTool.execute(spawn('bob'), t.context)
		await done
		const first = await t.tasks.create({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			subject: 'write the parser',
			owner: 'bob',
		})
		await t.tasks.create({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			subject: 'test the parser',
			blockedBy: [first.id],
		})
		const list = (await t.runtime.team?.tasks()) ?? []
		expect(list.map((task) => task.subject)).toEqual(['write the parser', 'test the parser'])
		expect(list[0]).toMatchObject({ owner: 'bob' })
		expect(list[1]?.blockedBy).toEqual([String(first.id)])
	} finally {
		await t.runtime.close()
	}
})

it('records what the lead sent to a member as what it is', async () => {
	const t = await setup()
	try {
		const first = t.next()
		await t.runtime.agentTool.execute(spawn('bob'), t.context)
		await first
		const second = t.next()
		await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'look at the tests' },
			t.context,
		)
		await second
		const third = t.next()
		await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'wrap up approve', shutdown: true },
			t.context,
		)
		await third
		const row = t.runtime.activity.getSnapshot().find((entry) => entry.agentId !== undefined)
		const kinds = (row?.transcript ?? []).flatMap((entry) =>
			entry.kind === 'system' && entry.mail ? [entry.mail] : [],
		)
		expect(kinds).toMatchObject([
			{ kind: 'message', from: 'lead', body: 'look at the tests' },
			{ kind: 'stop', from: 'lead' },
		])
	} finally {
		await t.runtime.close()
	}
})

it('tells a member that a line typed into its own view is from the person', async () => {
	const t = await setup()
	try {
		const first = t.next()
		await t.runtime.agentTool.execute(spawn('bob'), t.context)
		await first
		const viewId = t.runtime.team?.members()[0]?.viewId ?? ''
		const second = t.next()
		await t.runtime.messageChild(viewId, 'use tabs please', t.turnId, new AbortController().signal)
		await second
		const handed = t.requests
			.map((request) => JSON.stringify(request.messages))
			.find((text) => text.includes('use tabs please'))
		expect(handed).toContain('A message from the person')
		expect(handed).toContain('not from another session in your team')
		// The member's own transcript keeps the person's words as typed.
		const row = t.runtime.activity.getSnapshot().find((entry) => entry.viewId === viewId)
		const typed = row?.transcript.find(
			(entry) => entry.kind === 'system' && entry.direction === 'operator-to-child',
		)
		expect(typed).toMatchObject({ text: 'use tabs please' })
	} finally {
		await t.runtime.close()
	}
})

it('lists an idle member as stopped once it is stopped', async () => {
	const t = await setup()
	try {
		const done = t.next()
		await t.runtime.agentTool.execute(spawn('bob'), t.context)
		await done
		const viewId = t.runtime.team?.members()[0]?.viewId ?? ''
		expect(t.runtime.stopChild(viewId)).toBe(true)
		expect(t.runtime.team?.members()[0]).toMatchObject({ name: 'bob', state: 'stopped' })
	} finally {
		await t.runtime.close()
	}
})
