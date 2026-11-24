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
import { type SubagentCompletion, type SubagentMessage, createSubagentRuntime } from '../runtime.js'

// With teams on, an `Agent` call that gives a name starts a teammate: a child with its own history that
// goes idle after each turn instead of ending, shares the team's task list, and is reached by name with
// send_message. With teams off, or without a name, nothing here applies.

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

/** The task a teammate is told to take, set by the test that uses it. */
const claimTarget: { id: string } = { id: '' }

const LOOKUP = '{"mode":"direct","time":"unspecified","termIds":[],"basis":[]}'

/**
 * One scripted model for every teammate. Each kind of request is answered on purpose: the history
 * lookup the kernel makes for a turn that has history, the first turn of each teammate (told apart
 * by the brief), a teammate's reply after one of its tool calls, and a turn started by mail.
 */
function script(requests: ChatCompletionParams[]): (params: ChatCompletionParams) => MockTurn {
	return (params) => {
		requests.push(params)
		// A script that loops is a bug in the test, not a reason to hang the suite.
		if (requests.length > 40) return { text: 'script ran away' }
		const first = String(params.messages[0]?.content ?? '')
		if (first.includes('Resolve a conversation-history search query')) return { text: LOOKUP }
		const last = params.messages[params.messages.length - 1]
		const everything = JSON.stringify(params.messages)
		if (everything.includes('Work T')) {
			// Load the task tool by name, take the task, finish it (an open task would keep the turn going), then stop.
			const results = params.messages.filter((m) => m.role === 'tool').length
			if (results === 0)
				return {
					toolCalls: [{ id: 'ld', name: 'search_tools', args: { query: 'select:task_update' } }],
				}
			if (results === 1)
				return {
					toolCalls: [
						{ id: 'cl', name: 'task_update', args: { id: claimTarget.id, status: 'in_progress' } },
					],
				}
			if (results === 2)
				return {
					toolCalls: [
						{ id: 'fin', name: 'task_update', args: { id: claimTarget.id, status: 'completed' } },
					],
				}
			return { text: 'claimed and done' }
		}
		if (last?.role === 'tool') {
			return { text: 'sent' }
		}
		const lastText = String(last?.content ?? '')
		if (lastText.includes('shutdown request') && lastText.includes('wrap up approve'))
			return { toolCalls: [{ id: 'bye', name: 'shutdown_response', args: { approve: true } }] }
		if (lastText.includes('shutdown request') && lastText.includes('wrap up refuse'))
			return {
				toolCalls: [
					{
						id: 'no',
						name: 'shutdown_response',
						args: { approve: false, reason: 'one file is half written' },
					},
				],
			}
		if (lastText.includes('the answer is 42')) {
			return {
				toolCalls: [
					{
						id: 'tell',
						name: 'send_message',
						args: { to: 'lead', message: 'bob has 42', summary: 'result' },
					},
				],
			}
		}
		if (everything.includes('Work A')) {
			return {
				toolCalls: [
					{ id: 'hand', name: 'send_message', args: { to: 'bob', message: 'the answer is 42' } },
				],
			}
		}
		return { text: 'ready' }
	}
}

async function setup(options: { enabled: boolean; maxTeammates?: number; hold?: boolean }) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-teammates-'))
	roots.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const store = new TeamStore({ rootDir: join(cwd, 'teams') })
	const tasks = new FileTaskStore({
		listId: teamNameFor(String(parent.scope.sessionId)),
		rootDir: join(cwd, 'tasks'),
	})
	const requests: ChatCompletionParams[] = []
	const completions: SubagentCompletion[] = []
	const messages: SubagentMessage[] = []
	const completionWaiters: (() => void)[] = []
	const messageWaiters: (() => void)[] = []
	const hold = { enabled: options.enabled }
	const gate = deferred()
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		backgroundByDefault: true,
		// The children keep their conversations in memory, which is what a later turn resumes.
		ephemeral: true,
		resolveResumeHandler: () => async () => ({ action: 'approve_tools' }),
		teams: {
			enabled: () =>
				hold.enabled
					? { enabled: true, source: 'setting' }
					: { enabled: false, reason: 'disabled', text: 'off' },
			limits: () => ({
				maxTeammates: options.maxTeammates ?? 5,
				idleExitMinutes: 30,
				shutdownGraceSeconds: 20,
			}),
			store,
			taskStoreFor: () => tasks,
			// No timer is needed here: nothing in this test waits for time to pass.
			setTimer: () => 0,
			clearTimer: () => {},
		},
		buildProvider: () => {
			const mock = new MockLLMProvider({ nextTurn: (params) => script(requests)(params) })
			return {
				id: 'worker',
				name: 'Worker',
				async *chatStream(params) {
					// With `hold`, every request waits here until the test lets it go.
					if (options.hold) await gate.promise
					yield* mock.chatStream(params)
				},
			} satisfies LLMProvider
		},
	})
	runtime.onChildMessage((message) => {
		messages.push(message)
		for (const wake of messageWaiters.splice(0)) wake()
	})
	runtime.onBackgroundCompletion((completion) => {
		completions.push(completion)
		for (const wake of completionWaiters.splice(0)) wake()
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
		store,
		tasks,
		requests,
		completions,
		messages,
		hold,
		release: () => gate.resolve(),
		team: teamNameFor(String(parent.scope.sessionId)),
		/** Resolves when the next teammate turn ends (a completion notice reaches the lead). */
		nextCompletion() {
			const turn = deferred()
			completionWaiters.push(turn.resolve)
			return turn.promise
		},
		/** Resolves once a teammate has sent the lead a message (at once if one already has). */
		nextMessage() {
			const arrived = deferred()
			if (messages.length > 0) arrived.resolve()
			else messageWaiters.push(arrived.resolve)
			return arrived.promise
		},
		async close() {
			await runtime.close()
		},
	}
}

const spawnCall = (name: string, prompt: string) => ({
	description: `${name} works`,
	prompt,
	name,
})

it('starts a teammate for a named call: reserved in the team, working in the background', async () => {
	const t = await setup({ enabled: true })
	try {
		const done = t.nextCompletion()
		const result = await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		expect(result.success).toBe(true)
		expect(result.output).toContain('Teammate "bob" started')
		expect(result.data).toMatchObject({ teammate: 'bob', team: t.team })
		expect(t.store.readTeam(t.team)?.members.map((m) => m.name)).toEqual(['bob'])
		await done
		// The turn ended: the lead heard it like any background agent, and the mailbox keeps the idle record.
		expect(t.completions.at(-1)?.text).toContain('ready')
		const idle = t.store.readMail(t.team, 'lead')
		expect(idle).toHaveLength(1)
		expect(JSON.parse(idle[0]?.text ?? '{}')).toMatchObject({ idleReason: 'available' })
	} finally {
		await t.close()
	}
})

it('hands work between two teammates, and the lead hears the result as another session', async () => {
	const t = await setup({ enabled: true })
	try {
		const bobReady = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await bobReady
		const afterAlice = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('alice', 'Work A'), t.context)
		await afterAlice
		// Alice's turn put mail in bob's mailbox; bob resumes with it and tells the lead in turn.
		await t.nextMessage()
		expect(t.messages[0]).toMatchObject({
			agentId: 'bob',
			text: 'bob has 42',
			teammate: { team: t.team, name: 'bob' },
		})
		const mail = t.store.readMail(t.team, 'bob')
		expect(mail[0]).toMatchObject({ from: 'alice', text: 'the answer is 42', read: true })
		// What bob was handed says plainly where it came from.
		const handed = t.requests
			.map((r) => JSON.stringify(r.messages))
			.find((text) => text.includes('the answer is 42'))
		expect(handed).toContain('your teammate alice')
		expect(handed).toContain('not from the person')
	} finally {
		await t.close()
	}
})

it('gives a teammate the team task list, claiming under its own name', async () => {
	const t = await setup({ enabled: true })
	try {
		const done = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await done
		// The teammate's tools list: task tools come from the team's list (deferred, loaded by name).
		const tools = t.requests
			.filter((r) => JSON.stringify(r.messages).includes('teammate in the team'))
			.flatMap((r) => (r.tools ?? []).map((tool) => tool.function.name))
		expect(tools).toContain('send_message')
		expect(tools).toContain('search_tools')
		// And a new task wakes it: it claims the task under its name and works on it.
		const resumed = t.nextCompletion()
		const created = await t.tasks.create({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			subject: 'Check the parser',
			description: 'look at it',
		})
		await resumed
		expect(await t.tasks.get(created.id)).toMatchObject({ owner: 'bob', status: 'in_progress' })
	} finally {
		await t.close()
	}
})

it("a teammate's own claim through the task tools carries its name", async () => {
	const t = await setup({ enabled: true })
	try {
		const created = await t.tasks.create({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			subject: 'Take me',
			description: 'x',
		})
		claimTarget.id = created.id
		const done = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work T'), t.context)
		await done
		expect(await t.tasks.get(created.id)).toMatchObject({ owner: 'bob', status: 'completed' })
	} finally {
		await t.close()
	}
})

it('refuses over the cap and a taken name without starting anything', async () => {
	const t = await setup({ enabled: true, maxTeammates: 1 })
	try {
		const done = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await done
		const full = await t.runtime.agentTool.execute(spawnCall('carol', 'Work C'), t.context)
		expect(full).toMatchObject({ success: false })
		expect(full.error).toContain('teams.maxTeammates')
		const taken = await t.runtime.agentTool.execute(spawnCall('bob', 'Work B again'), t.context)
		expect(taken.error).toContain('already a teammate')
		expect(t.store.readTeam(t.team)?.members.map((m) => m.name)).toEqual(['bob'])
		const reserved = await t.runtime.agentTool.execute(spawnCall('lead', 'x'), t.context)
		expect(reserved.error).toContain('reserved')
	} finally {
		await t.close()
	}
})

it('a message from the lead to a teammate by name resumes it', async () => {
	const t = await setup({ enabled: true })
	try {
		const first = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await first
		const second = t.nextCompletion()
		const sent = await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'the answer is 42' },
			t.context,
		)
		expect(sent.success).toBe(true)
		expect(sent.output).toContain('Message sent to teammate bob')
		await second
		await t.nextMessage()
		expect(t.messages[0]?.text).toBe('bob has 42')
	} finally {
		await t.close()
	}
})

it('a teammate the lead stopped stays stopped: it is not woken by mail or by a task', async () => {
	const t = await setup({ enabled: true, hold: true })
	try {
		const ended = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		// Its first turn is held at the model: stop it there, then let the held request go.
		const stopped = await t.runtime.stopTaskTool.execute({ id: 'bob' }, t.context)
		expect(stopped.success).toBe(true)
		t.release()
		await ended
		const before = t.requests.length
		const refused = await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'wake up' },
			t.context,
		)
		expect(refused.success).toBe(false)
		const created = await t.tasks.create({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			subject: 'later',
			description: 'x',
		})
		// A look at the list that nobody answers: nothing asked the model, and nobody owns the task.
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(t.requests.length).toBe(before)
		expect((await t.tasks.get(created.id))?.owner).toBeUndefined()
		expect(t.store.readTeam(t.team)?.members[0]?.active).toBe(false)
	} finally {
		await t.close()
	}
})

it('an idle teammate can be stopped too: it takes no more mail and claims no more tasks', async () => {
	const t = await setup({ enabled: true })
	try {
		const done = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await done
		const stopped = await t.runtime.stopTaskTool.execute({ id: 'bob' }, t.context)
		expect(stopped.success).toBe(true)
		expect(stopped.output).toContain('Teammate stopped')
		const before = t.requests.length
		const refused = await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'wake up' },
			t.context,
		)
		expect(refused.success).toBe(false)
		const created = await t.tasks.create({
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			subject: 'later',
			description: 'x',
		})
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(t.requests.length).toBe(before)
		expect((await t.tasks.get(created.id))?.owner).toBeUndefined()
		expect(t.store.readTeam(t.team)?.members[0]?.active).toBe(false)
		// Stopping it again says it is already stopped rather than touching anything.
		const again = await t.runtime.stopTaskTool.execute({ id: 'bob' }, t.context)
		expect(again.output).toContain('already ended')
	} finally {
		await t.close()
	}
})

it('closing the runtime cancels a teammate that is mid-turn, so its turn never reaches the model', async () => {
	const t = await setup({ enabled: true, hold: true })
	await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
	// The turn is held at the model. Closing cancels it; letting the held request go changes nothing.
	const closing = t.close()
	t.release()
	await closing
	await new Promise<void>((resolve) => setImmediate(resolve))
	expect(t.requests.filter((r) => JSON.stringify(r.messages).includes('Work B'))).toEqual([])
})

it('ends the team when the runtime closes: the team directory is gone, the task list stays', async () => {
	const t = await setup({ enabled: true })
	const done = t.nextCompletion()
	await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
	await done
	const created = await t.tasks.create({
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		subject: 'keep me',
		description: 'x',
	})
	await t.close()
	expect(t.store.readTeam(t.team)).toBeUndefined()
	expect((await t.tasks.get(created.id))?.subject).toBe('keep me')
})

it('with teams off, a named call is the plain sub-agent it always was', async () => {
	const t = await setup({ enabled: false })
	try {
		const result = await t.runtime.agentTool.execute(
			{ ...spawnCall('bob', 'Work B'), run_in_background: true },
			t.context,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('It can also be addressed as "bob"')
		expect(result.output).not.toContain('Teammate')
		expect(t.store.readTeam(t.team)).toBeUndefined()
		expect(t.store.listTeams()).toEqual([])
	} finally {
		await t.close()
	}
})

it('with teams on, an unnamed call is still a plain sub-agent', async () => {
	const t = await setup({ enabled: true })
	try {
		const result = await t.runtime.agentTool.execute(
			{ description: 'one job', prompt: 'Work B', run_in_background: true },
			t.context,
		)
		expect(result.success).toBe(true)
		expect(result.output).not.toContain('Teammate')
		expect(t.store.listTeams()).toEqual([])
	} finally {
		await t.close()
	}
})

it('the lead asks a teammate to shut down: it approves, leaves the team and its name is free', async () => {
	const t = await setup({ enabled: true })
	try {
		const first = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await first
		const second = t.nextCompletion()
		const asked = await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'wrap up approve', shutdown: true },
			t.context,
		)
		expect(asked.success).toBe(true)
		expect(asked.output).toContain('Shutdown requested')
		await second
		expect(t.messages.at(-1)).toMatchObject({ agentId: 'bob', description: 'shutdown approved' })
		expect(t.store.readTeam(t.team)?.members).toEqual([])
		// What bob read says it is a request from another session, and how to answer.
		const handed = t.requests
			.map((r) => JSON.stringify(r.messages))
			.find((text) => text.includes('wrap up approve'))
		expect(handed).toContain('shutdown_response')
		expect(handed).toContain('not the person')
		const again = await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		expect(again.success).toBe(true)
	} finally {
		await t.close()
	}
})

it('a teammate that refuses a shutdown stays in the team, and the lead gets its reason', async () => {
	const t = await setup({ enabled: true })
	try {
		const first = t.nextCompletion()
		await t.runtime.agentTool.execute(spawnCall('bob', 'Work B'), t.context)
		await first
		const second = t.nextCompletion()
		await t.runtime.sendMessageTool.execute(
			{ task_id: 'bob', message: 'wrap up refuse', shutdown: true },
			t.context,
		)
		await second
		expect(t.messages.at(-1)?.text).toContain('one file is half written')
		expect(t.store.readTeam(t.team)?.members.map((m) => m.name)).toEqual(['bob'])
	} finally {
		await t.close()
	}
})
