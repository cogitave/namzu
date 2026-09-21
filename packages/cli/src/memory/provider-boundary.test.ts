/** Real CLI session -> query -> scripted provider, with only provider I/O replaced. */
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	DiskMemoryStore,
	MarkdownMemoryStore,
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
	const store = new DiskMemoryStore({
		baseDir: state.root,
		directory: join(state.root, 'memory', state.projectId),
	})
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
	await new MarkdownMemoryStore({
		directory: join(owner.state.root, 'memory', owner.state.projectId),
	}).create({
		title: 'Earlier investigation',
		summary: 'An implementation detail',
		content: 'cerulean-cache expires after 14 hours.',
	})
	const otherDirectory = join(root, 'other-checkout')
	mkdirSync(join(otherDirectory, '.git'), { recursive: true })
	const other = await makeSession(undefined, otherDirectory)
	expect(other.state.projectId).not.toBe(owner.state.projectId)
	expect(other.state.projectId).not.toBe(owner.state.projectId)
	const query = 'What is the expiry for cerulean-cache?'
	expect((await send(owner.session, query)).system).toContain('14 hours')
	const unrelated = await send(other.session, query)
	expect(unrelated.system).not.toContain('14 hours')
	expect(unrelated.system).not.toContain('Retrieved project memory')
})

it('carries stored memory under its own heading, and moves project notes only when asked', async () => {
	writeFileSync(join(appHome, 'MEMORY.md'), '- GLOBAL_NOTE\n')
	const curated = join(cwd, '.namzu', 'MEMORY.md')
	const original = '# Team notes\n\nKEEP_THIS_PROSE\n\n- run pnpm test before pushing\n'
	writeFileSync(curated, original)
	const { session } = await makeSession()
	// The launch offers the note and moves nothing: it is still curated text.
	expect(session.configNotices.join('\n')).toContain('/memory import-notes')
	expect(readFileSync(curated, 'utf8')).toBe(original)
	const before = await send(session)
	expect(before.system).toContain('- run pnpm test before pushing')
	expect(before.system).not.toContain('## Stored memories (index)')

	expect(await session.importCuratedNotes?.()).toContain('Moved 1 note from')
	const first = await send(session)
	expect(first.system).toContain('## Stored memories (index)')
	expect(first.system).toContain(
		'- [run-pnpm-test-before-pushing](run-pnpm-test-before-pushing.md) — run pnpm test before pushing',
	)
	expect(first.system).toContain('## Curated memory (all projects)')
	expect(first.system).toContain('## Curated memory (this project)')
	expect(first.system).toContain('KEEP_THIS_PROSE')
	expect(first.system).not.toContain('Durable memory')
	// The note moved; the prose and the user-scope file did not.
	expect(readFileSync(curated, 'utf8')).toBe('# Team notes\n\nKEEP_THIS_PROSE\n')
	expect(readFileSync(`${curated}.before-typed-memory`, 'utf8')).toBe(original)
	expect(readFileSync(join(appHome, 'MEMORY.md'), 'utf8')).toBe('- GLOBAL_NOTE\n')

	// A note typed now is a typed file, type project, and is in the next prompt.
	const note = 'the staging database is read-only'
	expect(await session.rememberNote?.(note)).toMatchObject({
		saved: true,
		type: 'project',
		name: 'the-staging-database-is-read',
	})
	expect((await send(session)).system).toContain('[the-staging-database-is-read]')
	expect(await session.rememberNote?.(note)).toMatchObject({ saved: false, duplicate: true })
	expect(await session.rememberNote?.('prefers terse answers', 'user')).toMatchObject({
		type: 'user',
	})

	// A bullet written by hand after the move stays curated, and is not offered again.
	appendFileSync(curated, '- HAND_WRITTEN_LATER\n')
	const later = await makeSession()
	expect(later.session.configNotices.join('\n')).not.toContain('import-notes')
	expect(readFileSync(curated, 'utf8')).toContain('- HAND_WRITTEN_LATER')
	expect((await send(later.session)).system).toContain('HAND_WRITTEN_LATER')
})
