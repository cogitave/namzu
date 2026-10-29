/**
 * The curated memory travels as a reminder through the real AgentSession, so
 * the conversation holds it and the provider can cache it, instead of the
 * request adding it again, uncached, at every step.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, ReminderSource } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

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

let cwd: string
beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-memory-reminder-'))
	mkdirSync(join(cwd, '.namzu'), { recursive: true })
})
afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(cwd)
})

const DETECTED = [
	{
		entry: {
			id: 'anthropic',
			label: 'anthropic',
			defaultModel: 'fixture-model',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
} as Preferences

async function remindersOf(call: Record<string, unknown> | undefined): Promise<string> {
	const source = call?.reminders as ReminderSource
	const messages: Message[] = [{ role: 'user', content: 'hi', timestamp: 0 }]
	const out = await source({
		sessionId: 'session' as never,
		turnId: 'turn' as never,
		iteration: 1,
		messages,
	})
	return (out ?? []).join('\n')
}

async function contextOf(call: Record<string, unknown> | undefined): Promise<string> {
	const steps = (call?.prepareStep ?? []) as Array<
		(arg: { prepared: { context: string }; contextBudget?: undefined }) => unknown
	>
	let context = ''
	for (const step of steps) {
		const result = (await step({ prepared: { context } })) as { context?: string } | undefined
		if (typeof result?.context === 'string') context = result.context
	}
	return context
}

it('sends the curated project memory as a reminder and keeps it out of the request context', async () => {
	writeFileSync(join(cwd, '.namzu', 'MEMORY.md'), '- Releases go out on Thursdays.\n')
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, DETECTED, { cwd })
	try {
		for await (const _event of session.send([])) {
			// drain the mocked turn
		}
	} finally {
		await session.close()
	}
	const [call] = queryCalls
	expect(await remindersOf(call)).toContain('Releases go out on Thursdays.')
	expect(await contextOf(call)).not.toContain('Releases go out on Thursdays.')
	expect(String(call?.systemPrompt)).not.toContain('Releases go out on Thursdays.')
})
