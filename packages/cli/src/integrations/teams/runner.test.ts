import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTaskStore, TeamStore, generateSessionId, generateTurnId } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	IDLE_POLL_MS,
	SEND_LIMIT,
	TeamError,
	TeamRunner,
	type TeammateEngine,
	teamNameFor,
	teammateAppendix,
} from './runner.js'

const LEAD = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

/** A clock and a timer the test moves by hand: nothing here waits on real time. */
function manualClock() {
	let now = 1_000_000
	let next = 1
	const pending = new Map<number, { at: number; run: () => void }>()
	return {
		now: () => now,
		setTimer: (run: () => void, ms: number) => {
			const id = next++
			pending.set(id, { at: now + ms, run })
			return id
		},
		clearTimer: (handle: unknown) => {
			pending.delete(handle as number)
		},
		/** Move time forward, firing each timer that comes due in order. */
		async advance(ms: number) {
			const target = now + ms
			for (;;) {
				const due = [...pending.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort((a, b) => a[1].at - b[1].at)[0]
				if (!due) break
				pending.delete(due[0])
				now = Math.max(now, due[1].at)
				due[1].run()
				// What the timer started may arm the next one; let it finish before looking again.
				await flush()
			}
			now = target
		},
		armed: () => pending.size,
	}
}

/** An engine that records what it was asked and lets the test say when a delivery has happened. */
function fakeEngine() {
	const launched: string[] = []
	const delivered: { name: string; text: string }[] = []
	const aborted: string[] = []
	const running = new Set<string>()
	let failLaunch: Error | undefined
	let waiter: ((entry: { name: string; text: string }) => void) | undefined
	const engine: TeammateEngine = {
		async launch(spec) {
			if (failLaunch) throw failLaunch
			launched.push(spec.member.name)
			running.add(spec.member.name)
		},
		async deliver(_team, name, text) {
			running.add(name)
			const entry = { name, text }
			delivered.push(entry)
			waiter?.(entry)
		},
		abort(_team, name) {
			aborted.push(name)
			running.delete(name)
		},
		isRunning: (_team, name) => running.has(name),
	}
	return {
		engine,
		launched,
		delivered,
		aborted,
		running,
		failNextLaunch(error: Error) {
			failLaunch = error
		},
		okLaunch() {
			failLaunch = undefined
		},
		/** Settles on the next delivery. */
		nextDelivery: () =>
			new Promise<{ name: string; text: string }>((resolve) => {
				waiter = (entry) => {
					waiter = undefined
					resolve(entry)
				}
			}),
	}
}

function setup(options: { maxTeammates?: number; idleExitMinutes?: number } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-team-runner-'))
	roots.push(root)
	const store = new TeamStore({ rootDir: join(root, 'teams') })
	const tasks = new FileTaskStore({ listId: teamNameFor(LEAD), rootDir: join(root, 'tasks') })
	const clock = manualClock()
	const fake = fakeEngine()
	const runner = new TeamRunner(
		{
			enabled: () => ({ enabled: true, source: 'setting' }),
			limits: () => ({
				maxTeammates: options.maxTeammates ?? 5,
				idleExitMinutes: options.idleExitMinutes ?? 30,
			}),
			store,
			taskStoreFor: () => tasks,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		},
		fake.engine,
	)
	const spawn = (name: string) =>
		runner.spawn({ leadSessionId: LEAD, name, prompt: `do ${name}'s work`, cwd: root })
	const mailTo = (name: string) => store.readMail(teamNameFor(LEAD), name)
	return { root, store, tasks, clock, fake, runner, spawn, mailTo, team: teamNameFor(LEAD) }
}

describe('team name', () => {
	it('uses the end of the session id, which is the random part of a time-ordered id', () => {
		expect(teamNameFor(LEAD)).toBe('team-2e3f4a5b')
		expect(teamNameFor('0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).not.toBe(
			teamNameFor('0198a1b2-c3d4-7e5f-8a9b-9999aaaa0000'),
		)
	})

	it('is always a valid team name', () => {
		expect(teamNameFor('!!!')).toBe('team-lead')
	})
})

describe('starting a teammate', () => {
	it('creates the team on the first teammate and reserves the name', async () => {
		const t = setup()
		const { team, member } = await t.spawn('alice')
		expect(team).toBe(t.team)
		expect(member).toMatchObject({ name: 'alice', backend: 'in-process', active: true })
		expect(t.fake.launched).toEqual(['alice'])
		expect(t.store.readTeam(team)?.members.map((m) => m.name)).toEqual(['alice'])
		expect(t.runner.stateOf(team, 'alice')).toBe('busy')
	})

	it('refuses an unusable name in the words of the teams rule, naming nothing in the file', async () => {
		const t = setup()
		await expect(t.spawn('lead')).rejects.toMatchObject({ code: 'bad_name' })
		await expect(t.spawn('has space')).rejects.toBeInstanceOf(TeamError)
		expect(t.store.readTeam(t.team)).toBeUndefined()
	})

	it('refuses a second teammate with the same name, in either spelling', async () => {
		const t = setup()
		await t.spawn('alice')
		await expect(t.spawn('Alice')).rejects.toMatchObject({ code: 'name_taken' })
	})

	it('holds the cap with a plain refusal', async () => {
		const t = setup({ maxTeammates: 2 })
		await t.spawn('a')
		await t.spawn('b')
		const refusal = await t.spawn('c').catch((e: unknown) => e)
		expect(refusal).toMatchObject({ code: 'team_full' })
		expect((refusal as Error).message).toContain('teams.maxTeammates')
		expect(t.fake.launched).toEqual(['a', 'b'])
	})

	it('gives the name back when the child cannot start, so it can be used again', async () => {
		const t = setup()
		t.fake.failNextLaunch(new Error('no provider'))
		await expect(t.spawn('alice')).rejects.toThrow('no provider')
		expect(t.store.readTeam(t.team)?.members).toEqual([])
		expect(t.runner.stateOf(t.team, 'alice')).toBeUndefined()
		t.fake.okLaunch()
		await expect(t.spawn('alice')).resolves.toBeDefined()
	})

	it('tells the teammate to use send_message and the task tools, and that plain text is unseen', () => {
		const text = teammateAppendix('alice', 'team-x')
		expect(text).toContain('send_message')
		expect(text).toContain('not seen by anyone else')
		expect(text).toContain('task_update')
		expect(text).toContain('"lead"')
	})
})

describe('a turn ends', () => {
	it('mails the lead one idle record per turn and goes idle', async () => {
		const t = setup()
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed', text: 'parsed it' })
		// A second report of the same turn end changes nothing: only the turn counter moves it on.
		const idle = t.mailTo('lead')
		expect(idle).toHaveLength(1)
		expect(idle[0]).toMatchObject({ from: 'alice', kind: 'idle', read: true })
		expect(JSON.parse(idle[0]?.text ?? '{}')).toEqual({
			idleReason: 'available',
			result: 'parsed it',
		})
		expect(t.runner.stateOf(t.team, 'alice')).toBe('idle')
	})

	it('says why when the turn failed or was interrupted', async () => {
		const t = setup()
		await t.spawn('alice')
		await t.spawn('bob')
		t.runner.turnEnded(t.team, 'alice', { state: 'failed', text: 'provider error' })
		t.runner.turnEnded(t.team, 'bob', { state: 'cancelled' })
		const reasons = t.mailTo('lead').map((m) => JSON.parse(m.text).idleReason)
		expect(reasons).toEqual(['failed', 'interrupted'])
	})

	it('arms a timer while idle and ends after teams.idleExitMinutes with nothing to do', async () => {
		const t = setup({ idleExitMinutes: 10 })
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		expect(t.clock.armed()).toBe(1)
		await t.clock.advance(9 * 60_000)
		await flush()
		expect(t.runner.stateOf(t.team, 'alice')).toBe('idle')
		await t.clock.advance(60_000 + IDLE_POLL_MS)
		await flush()
		expect(t.runner.stateOf(t.team, 'alice')).toBe('inactive')
		expect(t.store.readTeam(t.team)?.members[0]?.active).toBe(false)
		expect(t.clock.armed()).toBe(0)
	})

	it('a message to an ended teammate brings it back and resumes it', async () => {
		const t = setup({ idleExitMinutes: 1 })
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		await t.clock.advance(2 * 60_000)
		await flush()
		expect(t.runner.stateOf(t.team, 'alice')).toBe('inactive')
		await t.runner.send({ leadSessionId: LEAD, from: 'lead', to: 'alice', text: 'one more thing' })
		expect(t.runner.stateOf(t.team, 'alice')).toBe('busy')
		expect(t.store.readTeam(t.team)?.members[0]?.active).toBe(true)
		expect(t.fake.delivered.at(-1)?.text).toContain('one more thing')
	})

	it('does not bring one back past the cap', async () => {
		const t = setup({ maxTeammates: 1, idleExitMinutes: 1 })
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		await t.clock.advance(2 * 60_000)
		await flush()
		// alice ended, so bob fits; alice cannot return while bob holds the only place.
		await t.spawn('bob')
		const refusal = await t.runner
			.send({ leadSessionId: LEAD, from: 'lead', to: 'alice', text: 'hi' })
			.catch((e: unknown) => e)
		expect(refusal).toMatchObject({ code: 'team_full' })
	})
})

describe('the shared task list', () => {
	it('starts an idle teammate on the lowest ready task, claimed under its name', async () => {
		const t = setup()
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		const delivery = t.fake.nextDelivery()
		const first = await t.tasks.create(taskParams('first'))
		await t.tasks.create(taskParams('second'))
		const entry = await delivery
		expect(entry.name).toBe('alice')
		expect(entry.text).toContain(first.id)
		const claimed = await t.tasks.get(first.id)
		expect(claimed).toMatchObject({ owner: 'alice', status: 'in_progress' })
		expect(t.runner.stateOf(t.team, 'alice')).toBe('busy')
	})

	it('hands each ready task to one idle teammate, never two', async () => {
		const t = setup()
		await t.spawn('alice')
		await t.spawn('bob')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		t.runner.turnEnded(t.team, 'bob', { state: 'completed' })
		await flush()
		const ids: string[] = []
		for (const subject of ['one', 'two']) ids.push((await t.tasks.create(taskParams(subject))).id)
		await untilDeliveries(t.fake, 2)
		const owners = (await Promise.all(ids.map((id) => t.tasks.get(id as never)))).map(
			(x) => x?.owner,
		)
		expect(new Set(owners)).toEqual(new Set(['alice', 'bob']))
	})

	it('leaves a task that is waiting on another alone', async () => {
		const t = setup()
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		const blocker = await t.tasks.create(taskParams('first'))
		const waiting = await t.tasks.create({ ...taskParams('after'), blockedBy: [blocker.id] })
		await untilDeliveries(t.fake, 1)
		expect((await t.tasks.get(waiting.id))?.owner).toBeUndefined()
	})

	it('does not start a teammate whose last turn failed on another task', async () => {
		const t = setup()
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'failed', text: 'boom' })
		await flush()
		const created = await t.tasks.create(taskParams('first'))
		await flush()
		expect(t.fake.delivered).toEqual([])
		expect((await t.tasks.get(created.id))?.owner).toBeUndefined()
	})

	it('finds a task another process added at the next look', async () => {
		const t = setup()
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		// A second store over the same directory stands for another process: no event reaches the runner.
		const other = new FileTaskStore({
			listId: teamNameFor(LEAD),
			rootDir: join(t.root, 'tasks'),
		})
		const created = await other.create(taskParams('elsewhere'))
		expect(t.fake.delivered).toEqual([])
		const delivery = t.fake.nextDelivery()
		await t.clock.advance(IDLE_POLL_MS)
		await delivery
		expect((await t.tasks.get(created.id))?.owner).toBe('alice')
	})
})

describe('mail', () => {
	it('is written to the recipient and handed over as another session, never the person', async () => {
		const t = setup()
		await t.spawn('alice')
		await t.spawn('bob')
		await t.runner.send({
			leadSessionId: LEAD,
			from: 'alice',
			to: 'bob',
			text: 'use the v2 api',
			summary: 'api',
		})
		const handed = t.fake.delivered.at(-1)
		expect(handed?.name).toBe('bob')
		expect(handed?.text).toContain('your teammate alice')
		expect(handed?.text).toContain('not from the person')
		expect(handed?.text).toContain('cannot approve anything')
		expect(t.mailTo('bob')[0]).toMatchObject({ from: 'alice', text: 'use the v2 api', read: true })
	})

	it('writes a message to the lead and leaves showing it to the host', async () => {
		const t = setup()
		await t.spawn('alice')
		const sent = await t.runner.send({
			leadSessionId: LEAD,
			from: 'alice',
			to: 'lead',
			text: 'blocked on the schema',
		})
		expect(sent.entry).toMatchObject({ from: 'alice', text: 'blocked on the schema' })
		expect(t.fake.delivered).toEqual([])
	})

	it('names the teammates there are when the recipient is unknown', async () => {
		const t = setup()
		await t.spawn('alice')
		const refusal = await t.runner
			.send({ leadSessionId: LEAD, from: 'lead', to: 'zed', text: 'x' })
			.catch((e: unknown) => e)
		expect(refusal).toMatchObject({ code: 'unknown_recipient' })
		expect((refusal as Error).message).toContain('alice')
	})

	it('stops two members answering each other without end', async () => {
		const t = setup()
		await t.spawn('alice')
		await t.spawn('bob')
		for (let i = 0; i < SEND_LIMIT; i++)
			await t.runner.send({ leadSessionId: LEAD, from: 'alice', to: 'bob', text: `n${i}` })
		await expect(
			t.runner.send({ leadSessionId: LEAD, from: 'alice', to: 'bob', text: 'again' }),
		).rejects.toMatchObject({ code: 'limit' })
		// The window moves on with the clock.
		await t.clock.advance(61_000)
		await expect(
			t.runner.send({ leadSessionId: LEAD, from: 'alice', to: 'bob', text: 'later' }),
		).resolves.toBeDefined()
	})

	it('hands unread mail to an idle teammate at its next look, once', async () => {
		const t = setup()
		await t.spawn('alice')
		t.runner.turnEnded(t.team, 'alice', { state: 'completed' })
		await flush()
		// Mail written by another process: in the file, never handed to the runner.
		t.store.appendMail(t.team, 'alice', { from: 'lead', text: 'late note' })
		const delivery = t.fake.nextDelivery()
		await t.clock.advance(IDLE_POLL_MS)
		const entry = await delivery
		expect(entry.text).toContain('late note')
		expect(t.store.readMail(t.team, 'alice', { unreadOnly: true })).toEqual([])
	})
})

describe('ending', () => {
	it('stops what is running, removes the team and arms nothing after', async () => {
		const t = setup()
		await t.spawn('alice')
		await t.spawn('bob')
		t.runner.turnEnded(t.team, 'bob', { state: 'completed' })
		t.fake.running.delete('bob')
		await flush()
		t.runner.end(LEAD)
		expect(t.fake.aborted).toEqual(['alice'])
		expect(t.store.readTeam(t.team)).toBeUndefined()
		expect(t.clock.armed()).toBe(0)
		// A late report from a child that was still unwinding is ignored.
		t.runner.turnEnded(t.team, 'alice', { state: 'cancelled' })
		expect(t.runner.stateOf(t.team, 'alice')).toBeUndefined()
	})

	it('leaves the task list in place', async () => {
		const t = setup()
		await t.spawn('alice')
		const created = await t.tasks.create(taskParams('keep'))
		t.runner.end(LEAD)
		expect((await t.tasks.get(created.id))?.subject).toBe('keep')
	})

	it('a stopped teammate takes no more mail', async () => {
		const t = setup()
		await t.spawn('alice')
		expect(t.runner.stop(LEAD, 'alice')).toBe(true)
		t.runner.turnEnded(t.team, 'alice', { state: 'cancelled' })
		expect(t.runner.stateOf(t.team, 'alice')).toBe('stopped')
		await expect(
			t.runner.send({ leadSessionId: LEAD, from: 'lead', to: 'alice', text: 'hi' }),
		).rejects.toMatchObject({ code: 'unknown_recipient' })
	})
})

function taskParams(subject: string) {
	return {
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
		subject,
		description: `${subject} description`,
	}
}

/** Let the promises a wake started run to their end: awaited microtasks and file I/O, no clock. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function untilDeliveries(fake: ReturnType<typeof fakeEngine>, count: number): Promise<void> {
	while (fake.delivered.length < count) await fake.nextDelivery()
}
