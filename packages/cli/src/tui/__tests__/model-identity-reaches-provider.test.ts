import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	MockLLMProvider,
	ProviderRegistry,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { ensureRegistered } from '../../integrations/providers/register.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import { modelReminders } from '../../reminders/model.js'

it('sends known runtime selection at the provider boundary without changing the stable Namzu system prefix', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-model-reminder-'))
	const cwd = join(root, 'checkout')
	mkdirSync(cwd)
	mkdirSync(join(root, 'home'))
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
	vi.stubGlobal(
		'fetch',
		vi.fn(() => {
			throw new Error('Network forbidden in model reminder regression')
		}),
	)
	const requests: ChatCompletionParams[] = []
	await ensureRegistered('anthropic')
	vi.spyOn(ProviderRegistry, 'createProvider').mockImplementation(
		() =>
			new MockLLMProvider({
				responseText: 'done',
				onRequest: (params) =>
					requests.push({ ...params, messages: structuredClone(params.messages) }),
			}),
	)
	const { createAgentSession } = await import('../agent.js')
	const prefs: Preferences = {
		version: 3,
		providers: [{ id: 'anthropic', model: 'fixture-unknown-20261028' }],
		subagents: { active: [] },
	}
	const detected: DetectedProvider[] = [
		{
			entry: PROVIDER_REGISTRY.anthropic,
			source: { kind: 'session' },
			apiKey: 'synthetic-not-a-real-key',
			alternatives: [],
		},
	]
	const session = await createAgentSession(prefs, detected, {
		cwd,
		ephemeral: true,
		sandbox: { enabled: false },
		permissionMode: 'auto',
		limits: { maxIterations: 2 },
	})
	try {
		expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
		for await (const _ of session.send([createUserMessage('hello')])) {
			/* drain */
		}
		for await (const _ of session.send([createUserMessage('again')])) {
			/* drain */
		}
		expect(requests).toHaveLength(2)
		const system = (request: ChatCompletionParams) =>
			request.messages
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n')
		expect(system(requests[0]!)).toContain('Namzu')
		expect(system(requests[1]!)).toBe(system(requests[0]!))
		expect(system(requests[0]!)).not.toContain('Requested runtime model:')
		const reminders = requests[0]!.messages
			.filter(
				(m) =>
					m.role === 'user' && m.source?.type === 'runtime-context' && m.source.kind === 'reminder',
			)
			.map((m) => m.content)
			.join('\n')
		expect(reminders).toContain('fixture-unknown-20261028')
		expect(reminders).toContain('does not establish a knowledge cutoff')
		expect(reminders).not.toContain('October 28')
		expect(fetch).not.toHaveBeenCalled()
	} finally {
		await session.close()
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		removeTempDir(root)
	}
})

afterEach(() => vi.restoreAllMocks())

it('uses durable reminder history for deduplication, model changes and compaction', () => {
	const facts = { provider: 'fixture', model: 'unpublished-alias-20300101' }
	const text = modelReminders([], facts)[0]!
	const told = {
		role: 'user' as const,
		content: text,
		timestamp: 0,
		source: { type: 'runtime-context' as const, kind: 'reminder' as const },
	}
	expect(modelReminders([told], facts)).toEqual([])
	expect(modelReminders([told], { ...facts, model: 'another' })[0]).toContain('"another"')
	expect(modelReminders([], facts)).toEqual([text])
	expect(modelReminders([{ ...told, source: undefined }], facts)).toEqual([text])
	expect(text).not.toContain('2030-01-01')
})
