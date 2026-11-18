import { statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	type CliSessions,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { type AgentSession, createAgentSession } from '../agent.js'

/**
 * A scratch folder is made when a session starts, whatever kind of session it
 * is, and the model is told its path: an `exec --json` run (ephemeral) used to
 * be told nothing, and a model with nowhere to put a log or a script left it
 * in the person's folder.
 */

const roots: string[] = []
const opened: AgentSession[] = []
const catalogues: CliSessions[] = []
let temp: string

beforeEach(async () => {
	temp = await mkdtemp(join(tmpdir(), 'namzu-scratch-seam-temp-'))
	roots.push(temp)
	vi.stubEnv('NAMZU_TMPDIR', temp)
})
afterEach(async () => {
	vi.unstubAllEnvs()
	for (const session of opened.splice(0)) await session.close()
	for (const sessions of catalogues.splice(0)) closeSessions(sessions)
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.openrouter,
		source: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

async function open(provider: MockLLMProvider, hosted: boolean) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-scratch-seam-'))
	roots.push(cwd)
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	if (!hosted) {
		const bare = await createAgentSession(preferences, detected, {
			toolLoading: 'eager',
			cwd,
			sandbox: { enabled: false },
			ephemeral: true,
		})
		opened.push(bare)
		return bare
	}
	const sessions = await openSessions(cwd, {
		stateRoot: await mkdtemp(join(tmpdir(), 'namzu-scratch-seam-home-')),
	})
	roots.push(sessions.root)
	catalogues.push(sessions)
	const sessionId = await startConversation(sessions)
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot: sessions.root,
		conversationSessions: sessions,
		scope: {
			sessionId,
			topicId: sessions.topicId,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		},
		sandbox: { enabled: false },
		memory: { recall: false },
		toolLoading: 'eager',
		compaction: { recallEvidence: false },
	})
	opened.push(session)
	return session
}

describe.each([
	['an ephemeral session (exec --json, no persistence)', false],
	['a session kept on disk (the TUI, exec, ACP)', true],
] as const)('%s', (_name, hosted) => {
	it('has its scratch folder made, owner-only, and its path in the first request', async () => {
		// Every request this script holds is answered with text: nothing here
		// depends on how many extra requests the kernel makes around a turn.
		const provider = new MockLLMProvider({ turns: [{ text: 'Hello.' }, { text: 'Hello.' }] })
		const session = await open(provider, hosted)
		for await (const _event of session.send([createUserMessage('Say hello.')], {
			permissionMode: 'auto',
		})) {
			// Consume the production adapter and kernel.
		}
		const first = JSON.stringify(provider.requests[0])
		const named = /scratch folder is `([^`]+)`/.exec(first.replaceAll('\\`', '`'))?.[1]
		expect(named, first.slice(0, 400)).toBeDefined()
		const folder = named as string
		expect(folder.startsWith(temp)).toBe(true)
		expect(folder.endsWith('scratchpad')).toBe(true)
		expect(statSync(folder).isDirectory()).toBe(true)
		if (process.platform !== 'win32') expect(statSync(folder).mode & 0o777).toBe(0o700)
		// The placement rule that sends the person's non-deliverables there is in the same request.
		expect(first).toContain('Where files go')
		expect(first).toContain('never in the working directory or the home folder')
	})
})
