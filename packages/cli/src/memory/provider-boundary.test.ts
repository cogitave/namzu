/** Real CLI session -> query -> scripted provider, with only provider I/O replaced. */
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	DiskMemoryStore,
	MockLLMProvider,
	ProviderRegistry,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { ensureRegistered } from '../integrations/providers/register.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/registry.js'
import { openSessions, startConversation } from '../integrations/sessions/store.js'
import type { AgentEvent, AgentSession } from '../tui/agent.js'
import { appendMemoryWithStatus } from './store.js'

let root: string
let appHome: string
let cwd: string
const requests: ChatCompletionParams[] = []
const sessions: AgentSession[] = []
const prefs: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-4-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['anthropic'],
		source: { kind: 'session' },
		apiKey: 'synthetic-not-a-real-key',
		alternatives: [],
	},
]

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'namzu-memory-provider-'))
	appHome = join(root, 'app-home')
	cwd = join(root, 'checkout')
	mkdirSync(appHome)
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(cwd, '.namzu'))
	vi.stubEnv('NAMZU_HOME', appHome)
	vi.stubGlobal(
		'fetch',
		vi.fn(() => {
			throw new Error('Network forbidden in memory regression')
		}),
	)
	requests.length = 0
	await ensureRegistered('anthropic')
	vi.spyOn(ProviderRegistry, 'createProvider').mockImplementation(
		() =>
			new MockLLMProvider({
				responseText: 'Scripted response.',
				onRequest: (params) =>
					requests.push({ ...params, messages: structuredClone(params.messages) }),
			}),
	)
})

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()))
	expect(fetch).not.toHaveBeenCalled()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function makeSession(recall?: boolean, directory = cwd) {
	const state = await openSessions(directory, { stateRoot: appHome })
	const scope = {
		sessionId: await startConversation(state),
		topicId: state.topicId,
		projectId: state.projectId,
		tenantId: state.tenantId,
	}
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detected, {
		cwd: directory,
		stateRoot: appHome,
		scope,
		sandbox: { enabled: false },
		permissionMode: 'auto',
		limits: { maxIterations: 2, tokenBudget: 100_000 },
		...(recall === undefined ? {} : { memory: { recall } }),
	})
	sessions.push(session)
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	return { session, state }
}

async function send(session: AgentSession, text = 'Inspect the synthetic fixture.') {
	const before = requests.length
	const events: AgentEvent[] = []
	for await (const event of session.send([createUserMessage(text)], {
		signal: AbortSignal.timeout(8_000),
	}))
		events.push(event)
	expect(requests.length, JSON.stringify(events)).toBe(before + 1)
	const request = requests.at(-1)!
	return {
		events,
		system: request.messages
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n'),
	}
}

it('injects scoped curated files, refreshes edits/deletion on the next send, and marks cap exclusions', async () => {
	writeFileSync(join(appHome, 'USER.md'), 'SYNTHETIC_PROFILE')
	writeFileSync(join(appHome, 'MEMORY.md'), 'SYNTHETIC_GLOBAL')
	const path = join(cwd, '.namzu', 'MEMORY.md')
	writeFileSync(path, 'SYNTHETIC_INITIAL')
	const { session } = await makeSession()
	const first = await send(session)
	for (const marker of ['SYNTHETIC_PROFILE', 'SYNTHETIC_GLOBAL', 'SYNTHETIC_INITIAL'])
		expect(first.system).toContain(marker)
	writeFileSync(path, `SYNTHETIC_UPDATED\n${'a'.repeat(8_100)}`)
	const saved = appendMemoryWithStatus('SYNTHETIC_CLIPPED_NOTE', { scope: 'project', cwd })
	expect(saved.includedInPrompt).toBe(false)
	const updated = await send(session)
	expect(updated.system).toContain('SYNTHETIC_UPDATED')
	expect(updated.system).not.toContain('SYNTHETIC_INITIAL')
	expect(updated.system).not.toContain('SYNTHETIC_CLIPPED_NOTE')
	expect(updated.system).toContain('were not included')
	unlinkSync(path)
	expect((await send(session)).system).not.toContain('SYNTHETIC_UPDATED')
})

it.skipIf(process.platform === 'win32')(
	'excludes escaping memory from actual requests and emits an operator diagnostic',
	async () => {
		const outside = join(root, 'outside.md')
		writeFileSync(outside, 'NEVER_INJECT_OUTSIDE_SCOPE')
		symlinkSync(outside, join(cwd, '.namzu', 'MEMORY.md'))
		const { session } = await makeSession()
		const response = await send(session)
		expect(response.system).not.toContain('NEVER_INJECT_OUTSIDE_SCOPE')
		expect(response.events).toContainEqual({
			kind: 'context',
			text: expect.stringContaining('outside its allowed scope'),
			shed: false,
		})
	},
)

it.each([undefined, false])('recalls a persisted body-only fact with recall=%s', async (recall) => {
	const state = await openSessions(cwd, { stateRoot: appHome })
	const store = new DiskMemoryStore({ baseDir: state.projectStateRoot })
	await store.create({
		title: 'Earlier investigation',
		summary: 'An implementation detail',
		content: 'cerulean-cache expires after 14 hours.',
	})
	const { session } = await makeSession(recall)
	const result = await send(session, 'What is the expiry for cerulean-cache?')
	if (recall === false) {
		expect(result.system).not.toContain('14 hours')
		expect(result.system).not.toContain('Retrieved project memory')
	} else {
		expect(result.system).toContain('14 hours')
		expect(result.system).toContain('historical claims')
		expect(result.system).toContain('Retrieved project memory')
	}
})

it('keeps automatic recall inside its owning project under the same application home', async () => {
	const owner = await makeSession()
	await new DiskMemoryStore({ baseDir: owner.state.projectStateRoot }).create({
		title: 'Earlier investigation',
		summary: 'An implementation detail',
		content: 'cerulean-cache expires after 14 hours.',
	})
	const otherDirectory = join(root, 'other-checkout')
	mkdirSync(join(otherDirectory, '.git'), { recursive: true })
	const other = await makeSession(undefined, otherDirectory)
	expect(other.state.projectId).not.toBe(owner.state.projectId)
	expect(other.state.projectStateRoot).not.toBe(owner.state.projectStateRoot)
	const query = 'What is the expiry for cerulean-cache?'
	expect((await send(owner.session, query)).system).toContain('14 hours')
	const unrelated = await send(other.session, query)
	expect(unrelated.system).not.toContain('14 hours')
	expect(unrelated.system).not.toContain('Retrieved project memory')
})
