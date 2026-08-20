import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	MockLLMProvider,
	ProviderRegistry,
	type UserMessage,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

const roots: string[] = []

afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic' }],
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

const projectSnapshots = (messages: readonly Message[]) =>
	messages.filter(
		(message): message is UserMessage =>
			message.role === 'user' && message.source?.type === 'project-instructions',
	)

it('discovers nested policy in request two, publishes one snapshot, and rehydrates it', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-live-session-policy-'))
	roots.push(cwd)
	mkdirSync(join(cwd, '.git'))
	mkdirSync(join(cwd, 'packages', 'a'), { recursive: true })
	writeFileSync(join(cwd, 'AGENTS.md'), 'Root policy.')
	writeFileSync(join(cwd, 'packages', 'a', 'AGENTS.md'), 'Nested policy v1.')
	writeFileSync(join(cwd, 'packages', 'a', 'file.ts'), 'export const value = 1\n')

	const firstProvider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'read', args: { path: 'packages/a/file.ts' } }] },
			{ text: 'done' },
		],
	})
	const secondProvider = new MockLLMProvider({ responseText: 'resumed' })
	vi.spyOn(ProviderRegistry, 'create')
		.mockReturnValueOnce({ provider: firstProvider } as never)
		.mockReturnValueOnce({ provider: secondProvider } as never)

	const { createAgentSession } = await import('../agent.js')
	const first = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
	})
	let settled: readonly Message[] = []
	try {
		for await (const _event of first.send([createUserMessage('inspect the nested file')], {
			onConversationMessages: (messages) => {
				settled = messages
			},
		})) {
			// drain
		}
	} finally {
		await first.close()
	}

	expect(firstProvider.requests).toHaveLength(2)
	const firstRequest = firstProvider.requests[0]?.messages as Message[]
	const secondRequest = firstProvider.requests[1]?.messages as Message[]
	expect(projectSnapshots(firstRequest)).toHaveLength(1)
	expect(projectSnapshots(firstRequest)[0]?.content).toContain('Root policy.')
	expect(projectSnapshots(firstRequest)[0]?.content).not.toContain('Nested policy v1.')
	expect(projectSnapshots(secondRequest)).toHaveLength(1)
	expect(projectSnapshots(secondRequest)[0]?.content).toContain('Nested policy v1.')
	expect(projectSnapshots(settled)).toHaveLength(1)
	expect(projectSnapshots(settled)[0]?.source).toMatchObject({
		files: ['AGENTS.md', 'packages/a/AGENTS.md'],
	})

	// Persisted text is not authority. A reconstructed session follows the
	// validated source path and re-reads the file before its first request.
	writeFileSync(join(cwd, 'packages', 'a', 'AGENTS.md'), 'Nested policy v2.')
	const resumed = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
	})
	try {
		for await (const _event of resumed.send([...settled, createUserMessage('continue')])) {
			// drain
		}
	} finally {
		await resumed.close()
	}
	const resumedRequest = secondProvider.requests[0]?.messages as Message[]
	expect(projectSnapshots(resumedRequest)).toHaveLength(1)
	expect(projectSnapshots(resumedRequest)[0]?.content).toContain('Nested policy v2.')
	expect(projectSnapshots(resumedRequest)[0]?.content).not.toContain('Nested policy v1.')
})
