import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	DiskSessionLog,
	type LLMProvider,
	MockLLMProvider,
	ProviderError,
	ProviderRegistry,
	createUserMessage,
} from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type AgentEvent, createAgentSession } from '../agent.js'

it('resumes a real paused ephemeral turn from memory and keeps that conversation across sends', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-ephemeral-pause-'))
	const requests: ChatCompletionParams[] = []
	const provider: LLMProvider = {
		id: 'anthropic',
		name: 'fixture',
		async *chatStream(params) {
			requests.push(params)
			if (requests.length === 1) {
				yield { id: 'partial', delta: { content: 'partial' } }
				// Mid-stream failures park immediately; no real-time retry delay is raced.
				throw new ProviderError({
					code: 'overloaded',
					providerId: 'anthropic',
					message: 'try later',
					status: 529,
				})
			}
			yield* new MockLLMProvider({ turns: [{ text: 'resumed answer' }] }).chatStream(params)
		},
	}
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'anthropic' }],
		subagents: { active: [] },
	}
	const detected: DetectedProvider[] = [
		{
			entry: PROVIDER_REGISTRY.anthropic,
			source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		},
	]
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: join(cwd, 'state'),
		ephemeral: true,
		sandbox: { enabled: false },
		deferEffortCatalogue: true,
	})
	const disk = vi.spyOn(DiskSessionLog, 'at')
	try {
		const first: AgentEvent[] = []
		for await (const event of session.send([createUserMessage('first question')])) first.push(event)
		const paused = first.find((event) => event.kind === 'paused')
		expect(paused, JSON.stringify(first)).toBeDefined()
		if (paused?.kind !== 'paused') throw new Error('fixture did not pause')
		const resumed: AgentEvent[] = []
		for await (const event of session.resumePaused({
			turnId: paused.turnId,
			checkpointId: paused.checkpointId,
		}))
			resumed.push(event)
		expect(resumed.filter((event) => event.kind === 'error')).toEqual([])
		expect(resumed.map((event) => (event.kind === 'delta' ? event.text : '')).join('')).toBe(
			'resumed answer',
		)
		const next: AgentEvent[] = []
		for await (const event of session.send([createUserMessage('next question')])) next.push(event)
		expect(next.filter((event) => event.kind === 'error')).toEqual([])
		expect(requests).toHaveLength(3)
		expect(
			requests[1]?.messages.some(
				(message) =>
					typeof message.content === 'string' && message.content.includes('first question'),
			),
		).toBe(true)
		expect(
			requests[2]?.messages.some(
				(message) =>
					typeof message.content === 'string' && message.content.includes('resumed answer'),
			),
		).toBe(true)
		expect(disk).not.toHaveBeenCalled()
	} finally {
		await session.close()
		vi.restoreAllMocks()
		removeTempDir(cwd)
	}
})

it('does not open a disk log when no transient checkpoint log was retained', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-ephemeral-missing-'))
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({
		provider: new MockLLMProvider({ turns: [] }),
	} as never)
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'anthropic' }],
		subagents: { active: [] },
	}
	const detected: DetectedProvider[] = [
		{
			entry: PROVIDER_REGISTRY.anthropic,
			source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		},
	]
	const session = await createAgentSession(preferences, detected, {
		cwd,
		ephemeral: true,
		stateRoot: join(cwd, 'state'),
		sandbox: { enabled: false },
	})
	const disk = vi.spyOn(DiskSessionLog, 'at')
	try {
		expect(() => session.resumePaused({ turnId: 'missing' })).toThrow('No transient checkpoint log')
		expect(disk).not.toHaveBeenCalled()
	} finally {
		await session.close()
		vi.restoreAllMocks()
		removeTempDir(cwd)
	}
})
