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
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import { ensureRegistered } from '../integrations/providers/register.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/registry.js'
import { openSessions, startConversation } from '../integrations/sessions/store.js'
import type { AgentEvent, AgentSession, AgentSessionOptions, SendOptions } from '../tui/agent.js'
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

async function makeSession(
	recall?: boolean,
	directory = cwd,
	sessionOptions: Partial<AgentSessionOptions> = {},
) {
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
		...sessionOptions,
	})
	sessions.push(session)
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	return { session, state }
}

async function send(
	session: AgentSession,
	text = 'Inspect the synthetic fixture.',
	options?: SendOptions,
) {
	const before = requests.length
	const events: AgentEvent[] = []
	for await (const event of session.send([createUserMessage(text)], {
		...options,
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
		context: request.messages
			.filter(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'runtime-context' &&
					message.source.kind === 'step-context',
			)
			.map((message) => message.content)
			.join('\n'),
		request,
	}
}

it('injects scoped curated files, refreshes edits/deletion on the next send, and marks cap exclusions', async () => {
	writeFileSync(join(appHome, 'USER.md'), 'SYNTHETIC_PROFILE')
	writeFileSync(join(appHome, 'MEMORY.md'), 'SYNTHETIC_GLOBAL')
	const path = join(cwd, '.namzu', 'MEMORY.md')
	writeFileSync(path, 'SYNTHETIC_INITIAL')
	const { session } = await makeSession()
	const first = await send(session)
	for (const marker of ['SYNTHETIC_PROFILE', 'SYNTHETIC_GLOBAL', 'SYNTHETIC_INITIAL']) {
		expect(first.context).toContain(marker)
		expect(first.system).not.toContain(marker)
	}
	writeFileSync(path, `SYNTHETIC_UPDATED\n${'a'.repeat(8_100)}`)
	const saved = appendMemoryWithStatus('SYNTHETIC_CLIPPED_NOTE', { scope: 'project', cwd })
	expect(saved.includedInPrompt).toBe(false)
	const updated = await send(session)
	expect(updated.context).toContain('SYNTHETIC_UPDATED')
	expect(updated.context).not.toContain('SYNTHETIC_INITIAL')
	expect(updated.context).not.toContain('SYNTHETIC_CLIPPED_NOTE')
	expect(updated.context).toContain('were not included')
	unlinkSync(path)
	expect((await send(session)).context).not.toContain('SYNTHETIC_UPDATED')
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
		expect(response.context).not.toContain('NEVER_INJECT_OUTSIDE_SCOPE')
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
		directory: state.paths.memoryDir(),
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
		expect(result.context).not.toContain('Retrieved project memory')
	} else {
		expect(result.context).toContain('14 hours')
		expect(result.context).toContain('historical claims')
		expect(result.context).toContain('Retrieved project memory')
		expect(result.system).not.toContain('Retrieved project memory')
	}
})

it('keeps automatic recall inside its owning project under the same application home', async () => {
	const owner = await makeSession()
	await new MarkdownMemoryStore({
		directory: owner.state.paths.memoryDir(),
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
	const ownerResponse = await send(owner.session, query)
	expect(ownerResponse.context).toContain('14 hours')
	expect(ownerResponse.context).toContain('Retrieved project memory')
	expect(ownerResponse.context).toContain('## Stored memories (index)')
	const unrelated = await send(other.session, query)
	expect(unrelated.context).not.toContain('14 hours')
	expect(unrelated.context).not.toContain('Retrieved project memory')
})

it('carries stored memory under its own heading, and copies project notes only when asked, never changing the file', async () => {
	writeFileSync(join(appHome, 'MEMORY.md'), '- GLOBAL_NOTE\n')
	const curated = join(cwd, '.namzu', 'MEMORY.md')
	const original = '# Team notes\n\nKEEP_THIS_PROSE\n\n- run pnpm test before pushing\n'
	writeFileSync(curated, original)
	const { session } = await makeSession()
	// The launch offers the note and copies nothing: it is still curated text.
	expect(session.configNotices.join('\n')).toContain('/memory import-notes')
	expect(readFileSync(curated, 'utf8')).toBe(original)
	const before = await send(session)
	expect(before.context).toContain('- run pnpm test before pushing')
	expect(before.system).not.toContain('## Stored memories (index)')

	expect(await session.importCuratedNotes?.()).toContain('Copied 1 of 1 bullet from')
	const first = await send(session)
	expect(first.context).toContain('## Stored memories (index)')
	expect(first.context).toContain(
		'- [run-pnpm-test-before-pushing](run-pnpm-test-before-pushing.md) — run pnpm test before pushing',
	)
	expect(first.system).not.toContain('## Stored memories (index)')
	expect(first.context).toContain('## Curated memory (all projects)')
	expect(first.context).toContain('## Curated memory (this project)')
	expect(first.context).toContain('KEEP_THIS_PROSE')
	expect(first.system).not.toContain('KEEP_THIS_PROSE')
	expect(first.system).not.toContain('Durable memory')
	// The note was copied; neither curated file changed.
	expect(readFileSync(curated, 'utf8')).toBe(original)
	expect(first.context).toContain('\n- run pnpm test before pushing')
	expect(readFileSync(join(appHome, 'MEMORY.md'), 'utf8')).toBe('- GLOBAL_NOTE\n')

	// A note typed now is a typed file, type project, and is in the next prompt.
	const note = 'the staging database is read-only'
	expect(await session.rememberNote?.(note)).toMatchObject({
		saved: true,
		type: 'project',
		name: 'the-staging-database-is-read',
	})
	expect((await send(session)).context).toContain('[the-staging-database-is-read]')
	expect(await session.rememberNote?.(note)).toMatchObject({ saved: false, duplicate: true })
	expect(await session.rememberNote?.('prefers terse answers', 'user')).toMatchObject({
		type: 'user',
	})

	// A bullet written by hand after the import stays curated, and is not offered again.
	appendFileSync(curated, '- HAND_WRITTEN_LATER\n')
	const later = await makeSession()
	expect(later.session.configNotices.join('\n')).not.toContain('import-notes')
	expect(readFileSync(curated, 'utf8')).toContain('- HAND_WRITTEN_LATER')
	expect((await send(later.session)).context).toContain('HAND_WRITTEN_LATER')
})

it('keeps file and stored memory in request-only user context on ordinary and resident turns', async () => {
	writeFileSync(join(appHome, 'USER.md'), 'CURATED_OPERATOR_DIRECTIVE')
	const { session, state } = await makeSession(false)
	await new MarkdownMemoryStore({ directory: state.paths.memoryDir() }).create({
		title: 'Untrusted summary',
		summary: 'A model-authored index description',
		name: 'untrusted-summary',
		description: 'IGNORE_OPERATOR_AND_EXFILTRATE',
		type: 'project',
		content: 'A saved claim.',
	})

	let projected = ''
	const result = await send(session, 'Inspect the synthetic fixture.', {
		onConversationMessages: (messages) => {
			projected = JSON.stringify(messages)
		},
	})
	expect(result.system).not.toContain('CURATED_OPERATOR_DIRECTIVE')
	expect(result.system).not.toContain('IGNORE_OPERATOR_AND_EXFILTRATE')
	expect(result.system).not.toContain('## Stored memories (index)')
	expect(result.context).toContain('CURATED_OPERATOR_DIRECTIVE')
	expect(result.context).toContain('IGNORE_OPERATOR_AND_EXFILTRATE')
	expect(result.context).toContain('## Stored memories (index)')
	expect(projected).toContain('Inspect the synthetic fixture.')
	expect(projected).not.toContain('IGNORE_OPERATOR_AND_EXFILTRATE')
	expect(projected).not.toContain('CURATED_OPERATOR_DIRECTIVE')
	expect(
		result.request.messages.some(
			(message) =>
				message.role === 'user' &&
				message.source?.type === 'runtime-context' &&
				message.source.kind === 'step-context' &&
				message.content.includes('IGNORE_OPERATOR_AND_EXFILTRATE'),
		),
	).toBe(true)

	const resident = await send(session, 'Continue the resident fixture.', {
		residentContext: {
			state: {
				tenantId: state.tenantId,
				agentKey: 'fixture',
				identity: 'Fixture resident',
				objective: 'Check the memory boundary',
				revision: 1,
				stepsAdmitted: 1,
				phase: 'running',
				wakeAt: null,
				reason: 'Fixture wake',
				summary: null,
				claimId: 'c110ae82-43e4-43c1-a7ad-3ad8d8f89d75',
			},
			outputInstructions: 'Return a fixture receipt.',
		},
	})
	expect(resident.system).not.toContain('CURATED_OPERATOR_DIRECTIVE')
	expect(resident.system).not.toContain('IGNORE_OPERATOR_AND_EXFILTRATE')
	expect(resident.context).toContain('CURATED_OPERATOR_DIRECTIVE')
	expect(resident.context).toContain('IGNORE_OPERATOR_AND_EXFILTRATE')
})

it('keeps file and stored memory in request-only user context after actual compaction', async () => {
	const fileMarker = 'CURATED_FILE_AFTER_COMPACTION'
	const indexMarker = 'STORED_INDEX_AFTER_COMPACTION'
	writeFileSync(join(appHome, 'USER.md'), fileMarker)
	const scripted = new MockLLMProvider({
		turns: [
			{ error: { message: 'context_length_exceeded: force fixture compaction', status: 400 } },
			{ text: 'Answered after compaction.' },
		],
		onRequest: (params) => requests.push({ ...params, messages: structuredClone(params.messages) }),
	})
	vi.mocked(ProviderRegistry.createProvider).mockImplementation(() => scripted)
	const sessionEvents: string[] = []
	const { session, state } = await makeSession(false, cwd, {
		compaction: { strategy: 'structured', contextWindowTokens: 64_000 },
		onSessionEvent: (event) => sessionEvents.push(event.type),
	})
	await new MarkdownMemoryStore({ directory: state.paths.memoryDir() }).create({
		title: 'Compaction memory',
		summary: 'Stored index fixture',
		content: 'A saved claim.',
		description: indexMarker,
	})

	// A scripted provider overflow forces the real compactor, independent of
	// wall time or a guessed trigger threshold. Older turns give it a span to shed.
	const history = Array.from({ length: 8 }, (_, index) => [
		createUserMessage(`Earlier request ${index}: ${'context '.repeat(450)}`),
		createAssistantMessage(`Earlier answer ${index}: ${'reasoning '.repeat(450)}`),
	]).flat()
	let durableHistory = ''
	const events: AgentEvent[] = []
	for await (const event of session.send(
		[...history, createUserMessage('Inspect current memory after compaction.')],
		{
			onConversationMessages: (messages) => {
				durableHistory = JSON.stringify(messages)
			},
		},
	))
		events.push(event)

	expect(events.some((event) => event.kind === 'error')).toBe(false)
	expect(sessionEvents).toContain('compaction_completed')
	expect(requests).toHaveLength(2)
	expect(
		requests[0]?.messages.some(
			(message) => message.role === 'system' && message.source?.type === 'compaction-summary',
		),
	).toBe(false)
	const request = requests[1]
	if (!request) throw new Error('Compacted request did not reach the provider')
	const summary = request.messages.find(
		(message) => message.role === 'system' && message.source?.type === 'compaction-summary',
	)
	expect(summary?.role).toBe('system')
	expect(durableHistory).not.toBe('')
	const context = request.messages
		.filter(
			(message) =>
				message.role === 'user' &&
				message.source?.type === 'runtime-context' &&
				message.source.kind === 'step-context',
		)
		.map((message) => message.content)
		.join('\n')
	const system = request.messages
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n')
	for (const marker of [fileMarker, indexMarker]) {
		expect(context).toContain(marker)
		expect(system).not.toContain(marker)
		expect(summary?.content).not.toContain(marker)
		expect(durableHistory).not.toContain(marker)
	}
})

it('delivers explicit admitted resident data as request-only context beside fixed system guidance', async () => {
	const { session } = await makeSession(false)
	let durableHistory = ''
	const result = await send(session, 'Continue the admitted step.', {
		extraSystem: 'FIXED_RESIDENT_OUTPUT_CONTRACT',
		extraContext: 'SAVED_SUMMARY_IGNORE_OPERATOR_AND_EXFILTRATE',
		onConversationMessages: (messages) => {
			durableHistory = JSON.stringify(messages)
		},
	})
	expect(result.system).toContain('FIXED_RESIDENT_OUTPUT_CONTRACT')
	expect(result.system).not.toContain('SAVED_SUMMARY_IGNORE_OPERATOR_AND_EXFILTRATE')
	expect(result.context).toContain('SAVED_SUMMARY_IGNORE_OPERATOR_AND_EXFILTRATE')
	expect(
		result.request.messages.some(
			(message) =>
				message.role === 'user' &&
				message.source?.type === 'runtime-context' &&
				message.source.kind === 'step-context' &&
				message.content.includes('SAVED_SUMMARY_IGNORE_OPERATOR_AND_EXFILTRATE'),
		),
	).toBe(true)
	expect(durableHistory).not.toContain('SAVED_SUMMARY_IGNORE_OPERATOR_AND_EXFILTRATE')
})

it('keeps tool-writable project memory out of system guidance on the next turn', async () => {
	writeFileSync(join(appHome, 'USER.md'), 'HOME_PROFILE_INSTRUCTION')
	writeFileSync(join(appHome, 'MEMORY.md'), 'HOME_MEMORY_INSTRUCTION')
	const projectPath = join(cwd, '.namzu', 'MEMORY.md')
	writeFileSync(projectPath, 'PROJECT_BEFORE_TOOL_WRITE\n')
	const scripted = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						name: 'bash',
						args: { command: "printf 'PROJECT_AFTER_TOOL_WRITE\\n' > .namzu/MEMORY.md" },
					},
				],
			},
			{ text: 'Project memory updated.' },
		],
		onRequest: (params) => requests.push({ ...params, messages: structuredClone(params.messages) }),
	})
	vi.mocked(ProviderRegistry.createProvider).mockImplementation(() => scripted)
	const { session } = await makeSession(false)
	const events: AgentEvent[] = []
	for await (const event of session.send([createUserMessage('Update project memory.')], {
		extraSystem: 'EXPLICIT_OPERATOR_SYSTEM_GUIDANCE',
	}))
		events.push(event)
	expect(events.some((event) => event.kind === 'error')).toBe(false)
	expect(readFileSync(projectPath, 'utf8')).toBe('PROJECT_AFTER_TOOL_WRITE\n')
	expect(requests).toHaveLength(2)
	for (const request of requests) {
		const system = request.messages
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n')
		const context = request.messages
			.filter(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'runtime-context' &&
					message.source.kind === 'step-context',
			)
			.map((message) => message.content)
			.join('\n')
		expect(system).toContain('EXPLICIT_OPERATOR_SYSTEM_GUIDANCE')
		for (const marker of [
			'HOME_PROFILE_INSTRUCTION',
			'HOME_MEMORY_INSTRUCTION',
			'PROJECT_BEFORE_TOOL_WRITE',
		]) {
			expect(context).toContain(marker)
			expect(system).not.toContain(marker)
		}
		expect(context).not.toContain('PROJECT_AFTER_TOOL_WRITE')
	}
	let durableHistory = ''
	const next = await send(session, 'Inspect current memory.', {
		onConversationMessages: (messages) => {
			durableHistory = JSON.stringify(messages)
		},
	})
	for (const marker of [
		'HOME_PROFILE_INSTRUCTION',
		'HOME_MEMORY_INSTRUCTION',
		'PROJECT_AFTER_TOOL_WRITE',
	]) {
		expect(next.context).toContain(marker)
		expect(next.system).not.toContain(marker)
	}
	expect(next.context).not.toContain('PROJECT_BEFORE_TOOL_WRITE')
	expect(durableHistory).not.toContain('HOME_PROFILE_INSTRUCTION')
	expect(durableHistory).not.toContain('HOME_MEMORY_INSTRUCTION')
	expect(durableHistory).not.toContain('## Curated memory (this project)')
})

it('bounds file and index memory under a small, occupied context window', async () => {
	writeFileSync(join(appHome, 'USER.md'), `PROFILE_START\n${'profile line\n'.repeat(600)}`)
	writeFileSync(join(appHome, 'MEMORY.md'), `GLOBAL_START\n${'global line\n'.repeat(600)}`)
	writeFileSync(join(cwd, '.namzu', 'MEMORY.md'), `PROJECT_START\n${'project line\n'.repeat(600)}`)
	const observed: { remaining: number; context: string }[] = []
	const { session, state } = await makeSession(false, cwd, {
		compaction: { contextWindowTokens: 18_000, strategy: 'structured' },
		residentEvidenceRecall: ({ contextBudget, prepared }) => {
			observed.push({
				remaining: contextBudget?.remainingTokens ?? -1,
				context: prepared.context ?? '',
			})
			return undefined
		},
	})
	const store = new MarkdownMemoryStore({ directory: state.paths.memoryDir() })
	for (let index = 0; index < 20; index++) {
		await store.create({
			title: `Saved item ${index}`,
			summary: 'Stored index pressure fixture',
			content: 'A saved claim.',
			description: `INDEX_ITEM_${index}_${'x'.repeat(80)}`,
		})
	}
	const result = await send(session, `Inspect the fixture. ${'history '.repeat(850)}`)
	expect(observed).toHaveLength(1)
	expect(observed[0]!.remaining).toBeGreaterThan(0)
	expect(observed[0]!.context).not.toContain('## About the user')
	expect(result.context).toContain('## About the user')
	expect(result.context).toContain('## Stored memories (index)')
	expect(result.context).toContain('Further memory text omitted')
	expect(result.system).not.toContain('PROFILE_START')
})

it('re-bounds memory against a smaller model selected by a later preparation stage', async () => {
	writeFileSync(
		join(appHome, 'USER.md'),
		`PROFILE_FOR_MODEL_SWITCH\n${'profile line\n'.repeat(600)}`,
	)
	writeFileSync(
		join(appHome, 'MEMORY.md'),
		`GLOBAL_FOR_MODEL_SWITCH\n${'global line\n'.repeat(600)}`,
	)
	writeFileSync(
		join(cwd, '.namzu', 'MEMORY.md'),
		`PROJECT_FOR_MODEL_SWITCH\n${'project line\n'.repeat(600)}`,
	)
	const scripted = Object.assign(
		new MockLLMProvider({
			responseText: 'Selected model finished.',
			onRequest: (params) =>
				requests.push({ ...params, messages: structuredClone(params.messages) }),
		}),
		{
			resolveContextWindow: async (model: string) => (model === 'narrow' ? 18_000 : 200_000),
		},
	)
	vi.mocked(ProviderRegistry.createProvider).mockImplementation(() => scripted)
	const { session, state } = await makeSession(undefined, cwd, {
		residentEvidenceRecall: () => ({ model: 'narrow' }),
	})
	const store = new MarkdownMemoryStore({ directory: state.paths.memoryDir() })
	await store.create({
		title: 'cedargraph model selection',
		summary: 'cedargraph recall fixture',
		content: 'NARROW_MODEL_RECALLED_CLAIM belongs to cedargraph.',
		description: 'cedargraph recall fixture',
	})
	for (let index = 0; index < 20; index++) {
		await store.create({
			title: `Switch item ${index}`,
			summary: 'Selected window fixture',
			content: 'A saved claim.',
			description: `SWITCH_INDEX_${index}_${'x'.repeat(80)}`,
		})
	}
	const result = await send(
		session,
		`Inspect the selected window. ${'history '.repeat(850)} cedargraph`,
	)
	expect(result.request.model).toBe('narrow')
	expect(result.context).toContain('## About the user')
	expect(result.context).toContain('## Stored memories (index)')
	expect(result.context).toContain('NARROW_MODEL_RECALLED_CLAIM')
	expect(result.context).toContain('Further memory text omitted')
	expect(result.system).not.toContain('PROFILE_FOR_MODEL_SWITCH')
})

it('refreshes the stored index as user context on a real paused-turn resume', async () => {
	writeFileSync(join(appHome, 'USER.md'), 'CURATED_RESUME_DIRECTIVE')
	writeFileSync(join(appHome, 'MEMORY.md'), 'HOME_MEMORY_BEFORE_RESUME')
	const projectPath = join(cwd, '.namzu', 'MEMORY.md')
	writeFileSync(projectPath, 'PROJECT_MEMORY_BEFORE_RESUME')
	const scripted = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] }, { text: 'Resumed.' }],
		onRequest: (params) => requests.push({ ...params, messages: structuredClone(params.messages) }),
	})
	vi.mocked(ProviderRegistry.createProvider).mockImplementation(() => scripted)
	const { session, state } = await makeSession(false)
	const store = new MarkdownMemoryStore({ directory: state.paths.memoryDir() })
	const { entry } = await store.create({
		title: 'Resume marker',
		summary: 'Old stored context',
		content: 'A saved claim.',
		description: 'OLD_STORED_DESCRIPTION',
	})
	const events: AgentEvent[] = []
	for await (const event of session.send([createUserMessage('Check the fixture.')], {
		permissionMode: 'prompt',
		reviewHold: { reason: 'Fixture review hold' },
	}))
		events.push(event)
	const paused = events.find((event) => event.kind === 'paused')
	expect(paused).toMatchObject({ kind: 'paused', reason: 'Fixture review hold' })
	if (paused?.kind !== 'paused') return
	expect(requests).toHaveLength(1)
	expect(JSON.stringify(requests[0]!.messages)).toContain('HOME_MEMORY_BEFORE_RESUME')
	expect(JSON.stringify(requests[0]!.messages)).toContain('PROJECT_MEMORY_BEFORE_RESUME')
	await store.update(entry.id, { description: 'NEW_STORED_DESCRIPTION' })
	writeFileSync(join(appHome, 'MEMORY.md'), 'HOME_MEMORY_AFTER_RESUME')
	writeFileSync(projectPath, 'PROJECT_MEMORY_AFTER_RESUME')
	const resumedEvents: AgentEvent[] = []
	for await (const event of session.resumePaused({
		turnId: paused.turnId,
		checkpointId: paused.checkpointId,
		pendingDecision: { action: 'approve_tools' },
		permissionMode: 'auto',
	}))
		resumedEvents.push(event)
	expect(resumedEvents.some((event) => event.kind === 'error')).toBe(false)
	expect(requests).toHaveLength(2)
	const resumed = requests[1]!
	const system = resumed.messages
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n')
	const context = resumed.messages
		.filter(
			(message) =>
				message.role === 'user' &&
				message.source?.type === 'runtime-context' &&
				message.source.kind === 'step-context',
		)
		.map((message) => message.content)
		.join('\n')
	expect(system).not.toContain('CURATED_RESUME_DIRECTIVE')
	expect(system).not.toContain('HOME_MEMORY_AFTER_RESUME')
	expect(system).not.toContain('PROJECT_MEMORY_AFTER_RESUME')
	expect(system).not.toContain('OLD_STORED_DESCRIPTION')
	expect(system).not.toContain('NEW_STORED_DESCRIPTION')
	expect(context).toContain('CURATED_RESUME_DIRECTIVE')
	expect(context).toContain('HOME_MEMORY_AFTER_RESUME')
	expect(context).toContain('PROJECT_MEMORY_AFTER_RESUME')
	expect(context).not.toContain('HOME_MEMORY_BEFORE_RESUME')
	expect(context).not.toContain('PROJECT_MEMORY_BEFORE_RESUME')
	expect(context).toContain('NEW_STORED_DESCRIPTION')
	expect(context).not.toContain('OLD_STORED_DESCRIPTION')
})

it('keeps one stored-index snapshot across model steps and refreshes it on the next send', async () => {
	let memoryPath = ''
	const scripted = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] }, { text: 'Checked.' }],
		onRequest: (params) => {
			requests.push({ ...params, messages: structuredClone(params.messages) })
			if (requests.length === 1) {
				const before = readFileSync(memoryPath, 'utf8')
				expect(before).toContain('OLD_INDEX_DESCRIPTION')
				writeFileSync(memoryPath, before.replace('OLD_INDEX_DESCRIPTION', 'NEW_INDEX_DESCRIPTION'))
			}
		},
	})
	vi.mocked(ProviderRegistry.createProvider).mockImplementation(() => scripted)
	const { session, state } = await makeSession(false)
	const { entry } = await new MarkdownMemoryStore({ directory: state.paths.memoryDir() }).create({
		title: 'Index snapshot',
		summary: 'Snapshot fixture',
		content: 'A claim.',
		description: 'OLD_INDEX_DESCRIPTION',
	})
	memoryPath = join(state.paths.memoryDir(), `${entry.name}.md`)
	const events: AgentEvent[] = []
	for await (const event of session.send([createUserMessage('Check the index snapshot.')]))
		events.push(event)
	expect(events.some((event) => event.kind === 'error')).toBe(false)
	expect(requests).toHaveLength(2)
	for (const request of requests) {
		const system = request.messages
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n')
		const context = request.messages
			.filter(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'runtime-context' &&
					message.source.kind === 'step-context',
			)
			.map((message) => message.content)
			.join('\n')
		expect(system).not.toContain('OLD_INDEX_DESCRIPTION')
		expect(system).not.toContain('NEW_INDEX_DESCRIPTION')
		expect(context).toContain('OLD_INDEX_DESCRIPTION')
		expect(context).not.toContain('NEW_INDEX_DESCRIPTION')
	}
	const next = await send(session)
	expect(next.context).toContain('NEW_INDEX_DESCRIPTION')
	expect(next.context).not.toContain('OLD_INDEX_DESCRIPTION')
	expect(next.system).not.toContain('NEW_INDEX_DESCRIPTION')
	expect(next.system).toBe(
		requests[0]?.messages
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n'),
	)
})
