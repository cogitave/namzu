/**
 * Clearing the conversation ends one and begins another, and the hooks are
 * told both, in the same session object.
 *
 * Drives a real session (no model: `query` is replaced) and a real shell
 * hook. What is pinned: the end hook for the old id with the clear reason, the
 * start hook for the new id with the clear source, the old conversation's
 * session-start context dropped and the new one's put in its place, a failing
 * or still-running end hook not holding the new conversation back, and the
 * `replaced` reason with a source read from the history for a resume or fork.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import {
	type Message,
	type PromptContributionRegistry,
	type SessionId,
	generateProjectId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'

import type { HooksConfig } from '../config/schema.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

// Each test starts real shell hooks, so a loaded machine may take a while; no test
// decides its outcome by how long that takes.
vi.setConfig({ testTimeout: 30_000 })

let root: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-clear-hooks-'))
	mkdirSync(join(root, '.git'))
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })
const assistant = (text: string): Message => ({ role: 'assistant', content: text, timestamp: 0 })

interface Told {
	readonly event: string
	readonly session_id: string
	readonly source?: string
	readonly reason?: string
}

function sessionContext(turn: number): string | undefined {
	const registry = queryCalls[turn]?.promptContributions as PromptContributionRegistry | undefined
	return registry
		?.list()
		.find((contribution) => contribution.id === 'namzu.hooks.session-start')
		?.render({})
		?.toString()
}

async function drain(session: { send(m: Message[]): AsyncIterable<unknown> }, m: Message[]) {
	for await (const _ of session.send(m)) {
		// drain
	}
}

/** A session whose start hook prints a different line each time it runs. */
async function sessionWith(extra: HooksConfig = {}) {
	const log = join(root, 'told.log')
	const count = join(root, 'count')
	const record = `cat >> ${JSON.stringify(log)}; echo >> ${JSON.stringify(log)}`
	const { createAgentSession } = await import('../tui/agent.js')
	// The host owns the scope and moves it in place, as the terminal does.
	const scope = {
		sessionId: '019a0000-0000-7000-8000-0000000000c1' as SessionId,
		topicId: generateTopicId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
	}
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd: root,
		scope,
		hooks: {
			session_start: [
				{
					command: `${record}; n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(count)}; echo "LINE-$n"`,
				},
			],
			session_end: [{ command: record }],
			...extra,
		},
	})
	const told = (): Told[] =>
		existsSync(log)
			? readFileSync(log, 'utf8')
					.split('\n')
					.filter((line) => line.trim() !== '')
					.map((line) => JSON.parse(line) as Told)
			: []
	return { session, told, scope }
}

describe('/clear and /new', () => {
	it('end the old conversation with the clear reason and begin the new one with the clear source', async () => {
		const { session, told, scope } = await sessionWith()
		const first = scope.sessionId
		await drain(session, [user('one')])
		const second = '019a0000-0000-7000-8000-0000000000c2' as SessionId
		scope.sessionId = second
		await session.changeConversation?.({ from: first, reason: 'clear', starting: 'clear' })
		await drain(session, [user('fresh')])

		expect(told().map((t) => [t.event, t.session_id, t.source ?? t.reason])).toEqual([
			['session_start', first, 'startup'],
			['session_end', first, 'clear'],
			['session_start', second, 'clear'],
		])
	})

	it('replace the old conversation’s session-start context with the new one’s', async () => {
		const { session, scope } = await sessionWith()
		const first = scope.sessionId
		await drain(session, [user('one')])
		await drain(session, [user('one'), assistant('ok'), user('two')])
		scope.sessionId = '019a0000-0000-7000-8000-0000000000c2' as SessionId
		await session.changeConversation?.({ from: first, reason: 'clear', starting: 'clear' })
		await drain(session, [user('fresh')])

		const frame = (line: string) => `Context from the operator's hooks:\n\n${line}`
		expect(sessionContext(0)).toBe(frame('LINE-1'))
		expect(sessionContext(1)).toBe(frame('LINE-1'))
		expect(sessionContext(2), 'the new conversation reads what its own hooks said').toBe(
			frame('LINE-2'),
		)
	})

	it('leave the new conversation with no context when its hooks say nothing', async () => {
		const log = join(root, 'told.log')
		const { createAgentSession } = await import('../tui/agent.js')
		const scope = {
			sessionId: '019a0000-0000-7000-8000-0000000000c1' as SessionId,
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
		}
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: root,
			scope,
			hooks: {
				// Speaks only the first time it runs.
				session_start: [
					{
						command: `if [ -f ${JSON.stringify(log)} ]; then :; else echo ran > ${JSON.stringify(log)}; echo "Deploys are frozen."; fi`,
					},
				],
			},
		})
		const first = scope.sessionId
		await drain(session, [user('one')])
		scope.sessionId = '019a0000-0000-7000-8000-0000000000c2' as SessionId
		await session.changeConversation?.({ from: first, reason: 'clear', starting: 'clear' })
		await drain(session, [user('fresh')])

		expect(sessionContext(0)).toContain('Deploys are frozen.')
		expect(sessionContext(1)).toBeUndefined()
	})

	it('are not held back by an end hook that fails', async () => {
		const { session, told, scope } = await sessionWith({
			session_end: [{ command: 'cat > /dev/null; echo nope >&2; exit 1' }],
		})
		const first = scope.sessionId
		await drain(session, [user('one')])
		scope.sessionId = '019a0000-0000-7000-8000-0000000000c2' as SessionId
		await expect(
			session.changeConversation?.({ from: first, reason: 'clear', starting: 'clear' }),
		).resolves.toBeUndefined()
		await drain(session, [user('fresh')])
		expect(told().at(-1)).toMatchObject({ event: 'session_start', source: 'clear' })
	})

	it('are not held back by an end hook that is still running', async () => {
		// The hook waits for a file the test writes later; nothing here depends on
		// how fast the machine is, only on the new conversation not waiting for it.
		const release = join(root, 'release')
		const began = join(root, 'began')
		const { session, told, scope } = await sessionWith({
			session_end: [
				{
					command: `cat > /dev/null; echo 1 > ${JSON.stringify(began)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done`,
				},
			],
		})
		const first = scope.sessionId
		await drain(session, [user('one')])
		scope.sessionId = '019a0000-0000-7000-8000-0000000000c2' as SessionId
		const ending = session.changeConversation?.({ from: first, reason: 'clear', starting: 'clear' })
		await drain(session, [user('fresh')])
		expect(told().at(-1)).toMatchObject({ event: 'session_start', source: 'clear' })
		expect(sessionContext(1)).toContain('LINE-2')
		writeFileSync(release, '')
		await ending
	})
})

describe('a conversation opened in place of this one (resume, fork, rewind)', () => {
	it('ends the old one as replaced and begins the other by its history', async () => {
		const { session, told, scope } = await sessionWith()
		const first = scope.sessionId
		await drain(session, [user('one')])
		const second = '019a0000-0000-7000-8000-0000000000c3' as SessionId
		scope.sessionId = second
		await session.changeConversation?.({ from: first, reason: 'replaced' })
		await drain(session, [user('earlier'), assistant('ok'), user('now')])

		expect(told().map((t) => [t.event, t.session_id, t.source ?? t.reason])).toEqual([
			['session_start', first, 'startup'],
			['session_end', first, 'replaced'],
			['session_start', second, 'resume'],
		])
		expect(sessionContext(1)).toContain('LINE-2')
	})
})

describe('when the session object itself closes', () => {
	it('ends the conversation as exit by default and as replaced when the host swaps the session', async () => {
		for (const [reason, expected] of [
			[undefined, 'exit'],
			['replaced', 'replaced'],
		] as const) {
			queryCalls.length = 0
			const { session, told, scope } = await sessionWith()
			await drain(session, [user('one')])
			await session.close(reason)
			expect(told().at(-1)).toMatchObject({
				event: 'session_end',
				session_id: scope.sessionId,
				reason: expected,
			})
			rmSync(join(root, 'told.log'))
			rmSync(join(root, 'count'))
		}
	})

	it('waits for the end hooks of conversations left behind', async () => {
		const { session, told, scope } = await sessionWith()
		const first = scope.sessionId
		await drain(session, [user('one')])
		scope.sessionId = '019a0000-0000-7000-8000-0000000000c2' as SessionId
		// Not awaited, as the terminal does not: close must still see it through.
		void session.changeConversation?.({ from: first, reason: 'clear', starting: 'clear' })
		await session.close()
		expect(told().map((t) => [t.event, t.session_id, t.reason ?? t.source])).toEqual([
			['session_start', first, 'startup'],
			['session_end', first, 'clear'],
			['session_end', scope.sessionId, 'exit'],
		])
	})
})
