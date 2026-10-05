import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	BackgroundJobRegistry,
	type ComputerUseHost,
	DiskSessionLog,
	type Message,
	MockLLMProvider,
	PLAN_MODE_REFUSAL,
	type PalEnvironmentLease,
	PalRuntime,
	ProviderRegistry,
	type Sandbox,
	type SandboxId,
	type SessionEvent,
	type SessionRecord,
	createUserMessage,
	findPendingCheckpoint,
	generateSessionId,
	generateTurnId,
	preparePalReferenceImages,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { PROVIDER_REGISTRY, type Preferences } from '../integrations/providers/index.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import type { PermissionMode } from '../permissions/mode.js'
import { createAgentSession } from '../tui/agent.js'
import {
	type CliPalReviewActionsOptions,
	type PalReviewAction,
	createCliPalReviewActions,
} from './actions.js'
import { palSessionEnvironment } from './agent-session.js'
import { claimPalConversation } from './conversations.js'
import { readPalWaitingReview } from './review.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

const referenceImage = {
	type: 'image' as const,
	mediaType: 'image/png',
	data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADUlEQVR4XmOoAAMoBQAnbgWhheklIAAAAABJRU5ErkJggg==',
}

function installReferenceGuest(computer: PalEnvironmentLease) {
	vi.mocked(computer.sandbox.exec).mockImplementation(async (command, args) => {
		if (command !== 'python3' || !args?.[2]) throw new Error('Unexpected reference guest command.')
		const request = JSON.parse(args[2]) as {
			phase: string
			items: { name: string }[]
		}
		return {
			exitCode: 0,
			stdout:
				request.phase === 'preflight'
					? JSON.stringify(request.items.map((item) => item.name))
					: request.phase === 'commit'
						? 'references-ready'
						: '',
			stderr: '',
			timedOut: false,
			durationMs: 0,
		}
	})
}

const fixtureProviderId = 'openai'
let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-agent-'))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
function lease(palId: string, generation = 1): PalEnvironmentLease {
	const sandbox: Sandbox = {
		id: generateSessionId() as unknown as SandboxId,
		status: 'ready',
		rootDir: '/home/namzu/workspace',
		environment: 'linux-namespace',
		readFile: vi.fn(async () => Buffer.from('guest contents')),
		writeFile: vi.fn(async () => {}),
		listFiles: vi.fn(async () => []),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: 'guest command result',
			stderr: '',
			timedOut: false,
			durationMs: 0,
		})),
		destroy: vi.fn(async () => {}),
	}
	return {
		palId,
		generation,
		environmentId: `guest:${generation}`,
		sandbox,
		computerUseHost: {
			id: 'guest-display',
			getDisplayGeometry: async () => ({
				width: 1280,
				height: 800,
				scaleFactor: 1,
			}),
			capabilities: {
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: false,
				clipboard: false,
			},
			execute: vi.fn(async () => {
				throw new Error('unused')
			}),
		} satisfies ComputerUseHost,
		release: vi.fn(async () => {}),
	}
}
async function fixture(
	provider: MockLLMProvider,
	onSessionEvent?: (event: SessionEvent) => void,
	conversationOnly = false,
) {
	const pal = createPal({
		name: 'News researcher',
		purpose: 'Separate AI news by model.\nUse primary sources.',
		model: { provider: 'openai', model: 'pinned-model' },
	})
	const id = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, id)
	const state = await openSessions(pal.workspace)
	const original = lease(pal.id)
	const replacement = lease(pal.id, 2)
	const acquire = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(replacement)
	const runtime = new PalRuntime({
		store: getCliPalStore(),
		environments: { acquire },
	})
	if (!conversationOnly) await runtime.startComputer(pal.id)
	const construct = vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const scope = {
		sessionId: id,
		projectId: state.projectId,
		topicId: state.topicId,
		tenantId: state.tenantId,
	}
	const reopen = (
		permissionMode?: PermissionMode,
		rules?: NonNullable<Parameters<typeof createAgentSession>[2]>['rules'],
	) =>
		createAgentSession(
			{
				version: 3,
				providers: [{ id: 'openai', model: 'pinned-model' }],
			} as Preferences,
			[
				{
					entry: PROVIDER_REGISTRY[fixtureProviderId],
					apiKey: 'host-provider-secret',
					source: { kind: 'env', envName: 'OPENAI_API_KEY' },
					alternatives: [],
				},
			],
			{
				cwd: pal.workspace,
				onSessionEvent,
				scope,
				conversationSessions: state,
				...(permissionMode ? { permissionMode } : {}),
				...(rules ? { rules } : {}),
				palEnvironment: conversationOnly
					? palSessionEnvironment(runtime, pal, id)
					: {
							definition: pal,
							lease: original,
							admit: (signal) =>
								runtime.admit({
									palId: pal.id,
									revision: 1,
									conversationId: id,
									signal,
								}),
						},
			},
		)
	const agent = await reopen()
	return {
		pal,
		id,
		state,
		agent,
		reopen,
		runtime,
		original,
		replacement,
		construct,
		acquire,
		scope,
	}
}
it('puts the pinned model and purpose into the actual provider request and keeps host policy out', async () => {
	const provider = new MockLLMProvider({ responseText: 'Ready' })
	const f = await fixture(provider)
	writeFileSync(join(f.pal.workspace, 'AGENTS.md'), 'HOST_ONLY_POLICY')
	updatePal(f.pal.id, 1, {
		name: 'Updated researcher',
		purpose: 'New purpose',
		model: { provider: 'openai', model: 'changed-model' },
	})
	try {
		for await (const _event of f.agent.send([createUserMessage('Start research')])) {
		}
		expect(f.construct).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'pinned-model',
				apiKey: 'host-provider-secret',
			}),
		)
		expect(provider.requests).toHaveLength(1)
		const request = provider.requests[0]
		expect(request?.model).toBe('pinned-model')
		expect(JSON.stringify(request)).toContain('Separate AI news by model.')
		expect(JSON.stringify(request)).toContain('News researcher')
		expect(JSON.stringify(request)).toContain('You are \\"Updated researcher\\"')
		expect(JSON.stringify(request)).toContain('host-authored onboarding greeting')
		expect(JSON.stringify(request)).toContain('persistent Namzu Pal')
		expect(JSON.stringify(request)).toContain('follow their language and conversational tone')
		expect(JSON.stringify(request)).toContain('raw tool results, command logs')
		expect(JSON.stringify(request)).not.toContain('New purpose')
		expect(JSON.stringify(request)).not.toContain('HOST_ONLY_POLICY')
		expect(JSON.stringify(request)).not.toContain('host-provider-secret')
		expect(f.agent.agentIds).toEqual([])
		expect(f.agent.mcpConnected).toEqual([])
		expect(f.agent.toolNames()).not.toContain('schedule_task')
		expect(f.original.sandbox.destroy).not.toHaveBeenCalled()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('answers offline with pinned identity and zero guest or host tool definitions', async () => {
	const provider = new MockLLMProvider({ responseText: "I'm your Pal. Let's chat." })
	const f = await fixture(provider, undefined, true)
	try {
		for await (const _event of f.agent.send([createUserMessage('Who are you?')])) {
		}
		expect(provider.requests).toHaveLength(1)
		expect(provider.requests[0]?.tools ?? []).toEqual([])
		expect(JSON.stringify(provider.requests[0])).toContain('You can still chat.')
		expect(f.acquire).not.toHaveBeenCalled()
		expect(f.runtime.computer(f.pal.id)).toBeNull()
		expect(f.agent.toolNames()).toEqual([])
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('refuses hallucinated guest tools offline without executing on the host or starting a computer', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] },
			{ text: 'Computer access is unavailable.' },
		],
	})
	const f = await fixture(provider, undefined, true)
	try {
		for await (const _event of f.agent.send([createUserMessage('Run a command')])) {
		}
		expect(provider.requests.every((request) => (request.tools?.length ?? 0) === 0)).toBe(true)
		expect(f.acquire).not.toHaveBeenCalled()
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(f.original.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.runtime.computer(f.pal.id)).toBeNull()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('updates capabilities after explicit guest start, takeover and return without recreating the chat session', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ text: 'Offline chat' },
			{ toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] },
			{ text: 'Guest work completed' },
			{ text: 'Chat while you control the guest' },
			{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
			{ text: 'Guest control returned' },
		],
	})
	const f = await fixture(provider, undefined, true)
	let mode: 'pal' | 'operator' = 'pal'
	const control = {
		get mode() {
			return mode
		},
		takeOver: async () => {
			mode = 'operator'
		},
		returnControl: async () => {
			mode = 'pal'
		},
		executeInput: vi.fn(async () => ({ type: 'ok' as const })),
	}
	f.acquire.mockReset().mockResolvedValue({ ...f.original, operatorControl: control })
	const chat = async (text: string) => {
		for await (const _event of f.agent.send([createUserMessage(text)])) {
		}
	}
	try {
		await chat('Hi')
		await f.runtime.startComputer(f.pal.id)
		await chat('Show guest cwd')
		expect(f.original.sandbox.exec).toHaveBeenCalledTimes(1)
		await f.runtime.takeOver(f.pal.id, 1)
		await chat('Keep chatting')
		expect(provider.requests[3]?.tools ?? []).toEqual([])
		expect(f.original.sandbox.exec).toHaveBeenCalledTimes(1)
		await f.runtime.returnControl(f.pal.id, 1)
		await chat('Read guest notes')
		expect(f.original.sandbox.readFile).toHaveBeenCalledTimes(1)
		expect(provider.requests[0]?.tools ?? []).toEqual([])
		expect(provider.requests[1]?.tools?.map((tool) => tool.function.name)).toContain('bash')
		expect(provider.requests[4]?.tools?.map((tool) => tool.function.name)).toContain('read')
		expect(f.acquire).toHaveBeenCalledTimes(1)
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('delivers saved artifact pixels and generic work guidance through the actual Pal provider request', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'view_image', args: { path: 'design.png' } }] },
			{ text: 'I inspected the saved design.' },
		],
	})
	const f = await fixture(provider)
	vi.mocked(f.original.sandbox.readFile).mockResolvedValue(
		Buffer.from(referenceImage.data, 'base64'),
	)
	try {
		for await (const _event of f.agent.send([createUserMessage('Inspect the saved design.')])) {
		}
		expect(f.original.sandbox.readFile).toHaveBeenCalledWith(
			'design.png',
			expect.objectContaining({ offset: 0, length: 16 * 1024 * 1024 + 1 }),
		)
		const request = JSON.stringify(provider.requests[1])
		expect(request).toContain('"type":"image"')
		expect(request).toContain('"mediaType":"image/png"')
		expect(request).toContain('shown at 2x2')
		expect(request).toContain('saved artifact is not a current computer_use screenshot')
		expect(request).toContain('graphics, documents, spreadsheets, browsers, code')
		expect(request).toContain('verify_outputs only as a file presence check')
		expect(f.original.computerUseHost.execute).not.toHaveBeenCalled()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('refuses artifact reads for a provider that accepts attachments but cannot receive tool images', async () => {
	const provider = new MockLLMProvider({
		capabilities: {
			supportsTools: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
			supportsVision: true,
			supportsToolResultImages: false,
		},
		turns: [
			{ toolCalls: [{ name: 'view_image', args: { path: 'design.png' } }] },
			{ text: 'I cannot inspect saved images with this provider.' },
		],
	})
	const f = await fixture(provider)
	try {
		for await (const _event of f.agent.send([createUserMessage('Inspect the saved design.')])) {
		}
		expect(f.original.sandbox.readFile).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests[1])).toContain('No image was read or shown')
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('routes file reads and shell commands to the current admitted guest after restart', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
			{ toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] },
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		await f.runtime.stopComputer(f.pal.id)
		await f.runtime.startComputer(f.pal.id)
		for await (const _event of f.agent.send([createUserMessage('Read notes and show cwd')])) {
		}
		expect(f.original.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(f.replacement.sandbox.readFile).toHaveBeenCalled()
		expect(f.replacement.sandbox.exec).toHaveBeenCalled()
		expect(JSON.stringify(provider.requests)).toContain('guest contents')
		expect(f.replacement.sandbox.destroy).not.toHaveBeenCalled()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('refuses a changed mutable conversation scope before admitting a turn', async () => {
	const provider = new MockLLMProvider({ responseText: 'Must not run' })
	const f = await fixture(provider)
	try {
		f.scope.sessionId = generateSessionId()
		await expect(
			f.agent
				.send([createUserMessage('Wrong session')])
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toThrow('switching its session')
		expect(provider.requests).toEqual([])
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
it('checks current pause state before the next guest operation within a turn', async () => {
	let pause = () => {}
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
			{ text: 'Must not continue' },
		],
		onRequest: () => pause(),
	})
	const f = await fixture(provider)
	pause = () => {
		updatePal(f.pal.id, 1, { paused: true })
	}
	try {
		const events = []
		for await (const event of f.agent.send([createUserMessage('Read notes')])) events.push(event)
		expect(f.original.sandbox.readFile).not.toHaveBeenCalled()
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect(JSON.stringify(events)).toContain('paused')
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('allows cleanup retry when guest job termination failed', async () => {
	const f = await fixture(new MockLLMProvider({ responseText: 'Unused' }))
	const kill = vi
		.spyOn(BackgroundJobRegistry.prototype, 'killOwner')
		.mockRejectedValueOnce(new Error('guest cancellation unconfirmed'))
	try {
		await expect(f.agent.close()).rejects.toThrow('unconfirmed')
		await expect(f.agent.close()).resolves.toBeUndefined()
		expect(kill).toHaveBeenCalledTimes(2)
	} finally {
		kill.mockRestore()
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('rechecks pause at the provider boundary after an iteration event yielded', async () => {
	let pause = () => {}
	const provider = new MockLLMProvider({ responseText: 'Must not run' })
	const f = await fixture(provider, (event) => {
		if (event.type === 'iteration_started') pause()
	})
	pause = () => {
		updatePal(f.pal.id, 1, { paused: true })
	}
	try {
		const events = []
		for await (const event of f.agent.send([createUserMessage('Begin work')])) events.push(event)
		expect(provider.requests).toEqual([])
		expect(JSON.stringify(events)).toContain('paused')
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('rechecks dispatch consent after the iteration event and before provider entry', async () => {
	let revoked = false
	const provider = new MockLLMProvider({
		responseText: 'Must not run after revocation',
	})
	const f = await fixture(provider, (event) => {
		if (event.type === 'iteration_started') revoked = true
	})
	try {
		const events = []
		for await (const event of f.agent.send([createUserMessage('Begin authorized work')], {
			assertExecutionAllowed: () => {
				if (revoked) throw new Error('Directed consent was revoked.')
			},
		}))
			events.push(event)
		expect(JSON.stringify(events)).toContain('revoked')
		expect(provider.requests).toEqual([])
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('settles failed admission cleanup, refuses another send, and retains authority for close retry', async () => {
	const f = await fixture(new MockLLMProvider({ responseText: 'The query completed.' }))
	const admit = f.runtime.admit.bind(f.runtime)
	const release = vi.fn()
	vi.spyOn(f.runtime, 'admit').mockImplementation(async (request) => {
		const admission = await admit(request)
		release
			.mockRejectedValueOnce(new Error('Admission release was not confirmed.'))
			.mockRejectedValueOnce(new Error('Admission release still was not confirmed.'))
			.mockImplementation(() => admission.release())
		return { ...admission, release }
	})
	try {
		await expect(
			(async () => {
				for await (const _event of f.agent.send([createUserMessage('Finish this work')])) {
				}
			})(),
		).rejects.toThrow('not confirmed')
		expect(f.runtime.busy(f.pal.id)).toBe(true)
		await expect(
			f.agent
				.send([createUserMessage('Unsafe overlapping work')])
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toThrow('cleanup')
		// Await the real cleanup promise; no real-time race may classify a hang.
		await expect(f.agent.close()).rejects.toThrow('still was not confirmed')
		expect(f.runtime.busy(f.pal.id)).toBe(true)
		await expect(f.agent.close()).resolves.toBeUndefined()
		expect(release).toHaveBeenCalledTimes(3)
		expect(f.runtime.busy(f.pal.id)).toBe(false)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

async function records(f: Awaited<ReturnType<typeof fixture>>): Promise<SessionRecord[]> {
	const log = DiskSessionLog.at(f.state.paths, { sessionId: f.id })
	const result: SessionRecord[] = []
	for await (const { record } of log.read({ mode: 'strict' })) result.push(record)
	return result
}

it('imports current inline references only through the admitted guest tool and retains original history', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'import_reference_images', args: {} }] },
			{ text: 'The reference is ready in my computer.' },
		],
	})
	const f = await fixture(provider)
	installReferenceGuest(f.original)
	const message = createUserMessage('Use this reference in the design application.', [
		referenceImage,
	])
	const original = structuredClone(message)
	try {
		for await (const _event of f.agent.send([message])) {
		}
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\/home\/namzu\/workspace\/\.namzu\/reference-imports\/[a-f0-9-]+\/[a-f0-9]{64}\.png$/,
			),
			Buffer.from(referenceImage.data, 'base64'),
		)
		const request = JSON.stringify(provider.requests[1])
		expect(request).toContain('attachmentIndex')
		expect(request).toContain('/home/namzu/workspace/.namzu/references/')
		const { id: _recordedId, ...unchangedInput } = message
		expect(unchangedInput).toEqual(original)
		const recorded = (await records(f)).find(
			(record) =>
				record.type === 'message' && record.content.role === 'user' && !record.content.source,
		)
		expect(recorded).toMatchObject({ content: { attachments: [referenceImage] } })
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it.each(['prompt', 'strict', 'plan'] as const)(
	'does not silently write references in %s mode',
	async (mode) => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'import_reference_images', args: {} }] },
				{ text: 'The image is visible but has not been copied into my computer.' },
			],
		})
		const f = await fixture(provider)
		const onPermission = vi.fn(async () => ({
			kind: 'reject' as const,
			feedback: 'Keep it model-only.',
		}))
		try {
			for await (const _event of f.agent.send(
				[createUserMessage('Study this image.', [referenceImage])],
				{
					permissionMode: mode,
					onPermission,
				},
			)) {
			}
			expect(f.original.sandbox.exec).not.toHaveBeenCalled()
			expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
			expect(onPermission).toHaveBeenCalledTimes(mode === 'prompt' ? 1 : 0)
			expect(JSON.stringify(provider.requests)).not.toContain('/.namzu/references/')
		} finally {
			await f.agent.close()
			await f.runtime.close()
			closeSessions(f.state)
		}
	},
)

it('does not copy an attached reference just because ordinary chat has an online computer', async () => {
	const f = await fixture(new MockLLMProvider({ responseText: 'I can discuss that image.' }))
	try {
		for await (const _event of f.agent.send([
			createUserMessage('What do you see?', [referenceImage]),
		])) {
		}
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('does not give a new turn automatic access to historical attached reference bytes', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ text: 'I can see that image.' },
			{ toolCalls: [{ name: 'import_reference_images', args: {} }] },
			{ text: 'This new input does not include a reference to import.' },
		],
	})
	const f = await fixture(provider)
	let history: readonly Message[] = []
	try {
		for await (const _event of f.agent.send(
			[createUserMessage('Discuss this image.', [referenceImage])],
			{
				onConversationMessages: (messages) => {
					history = messages
				},
			},
		)) {
		}
		for await (const _event of f.agent.send([
			...history,
			createUserMessage('Now keep chatting.'),
		])) {
		}
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests[2])).toContain('no inline reference images')
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('rebuilds exact current reference bytes for a durable approved import on the next guest generation', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'reference-import-review', name: 'import_reference_images', args: {} }] },
			{ text: 'The approved reference import completed.' },
		],
	})
	const f = await fixture(provider)
	let resumed = f.agent
	try {
		for await (const _event of f.agent.send(
			[createUserMessage('Use this exact reference.', [referenceImage])],
			{
				permissionMode: 'prompt',
				reviewHold: { reason: 'Wait for the operator.' },
			},
		)) {
		}
		const pending = await findPendingCheckpoint(
			DiskSessionLog.at(f.state.paths, { sessionId: f.id }),
		)
		if (!pending) throw new Error('Reference import did not park a durable review.')
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		await f.agent.close()
		await f.runtime.stopComputer(f.pal.id)
		await f.runtime.startComputer(f.pal.id)
		installReferenceGuest(f.replacement)
		resumed = await f.reopen()
		for await (const _event of resumed.resumePaused({
			turnId: pending.turnId,
			checkpointId: pending.checkpointId,
			pendingDecision: { action: 'approve_tools' },
			permissionMode: 'prompt',
		})) {
		}
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(f.replacement.sandbox.writeFile).toHaveBeenCalledWith(
			expect.any(String),
			Buffer.from(referenceImage.data, 'base64'),
		)
		const expected = preparePalReferenceImages([referenceImage])[0]
		expect(JSON.stringify(provider.requests[1])).toContain(expected?.sha256)
		expect(JSON.stringify(provider.requests[1])).toContain(
			'/home/namzu/workspace/.namzu/references/',
		)
		expect((await records(f)).filter((record) => record.type === 'turn_started')).toHaveLength(1)
	} finally {
		await resumed.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('keeps current plan mode stricter than an approved durable reference import', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'reference-plan-review', name: 'import_reference_images', args: {} }] },
			{ text: 'The reference remains visible to me without guest writes.' },
		],
	})
	const f = await fixture(provider)
	try {
		for await (const _event of f.agent.send(
			[createUserMessage('Use this image.', [referenceImage])],
			{
				permissionMode: 'prompt',
				reviewHold: { reason: 'Wait for approval.' },
			},
		)) {
		}
		const pending = await findPendingCheckpoint(
			DiskSessionLog.at(f.state.paths, { sessionId: f.id }),
		)
		if (!pending) throw new Error('Reference import did not park a durable review.')
		for await (const _event of f.agent.resumePaused({
			turnId: pending.turnId,
			checkpointId: pending.checkpointId,
			pendingDecision: { action: 'approve_tools' },
			currentPermissionMode: () => 'plan',
		})) {
		}
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests[1])).toContain(PLAN_MODE_REFUSAL)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
async function park(f: Awaited<ReturnType<typeof fixture>>) {
	// These paths are new guest files; an existing unread file must correctly refuse overwrite.
	for (const computer of [f.original, f.replacement])
		vi.mocked(computer.sandbox.readFile).mockRejectedValue(
			Object.assign(new Error('absent'), { code: 'ENOENT' }),
		)
	const permission = vi.fn(async () => ({ kind: 'approve' as const }))
	for await (const _event of f.agent.send([createUserMessage('Write the guest notes')], {
		permissionMode: 'prompt',
		reviewHold: { reason: 'Await the operator.' },
		onPermission: permission,
		limits: { tokenBudget: 1300, maxIterations: 8, timeoutMs: 0 },
	})) {
	}
	expect(permission).not.toHaveBeenCalled()
	const pending = await findPendingCheckpoint(DiskSessionLog.at(f.state.paths, { sessionId: f.id }))
	expect(pending).not.toBeNull()
	if (!pending) throw new Error('The actual query did not record its review park.')
	return pending
}

it('records a real tool review and resumes its exact batch after reopening on a new guest generation', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'reviewed_write',
						name: 'write',
						args: { path: 'notes.txt', content: 'approved' },
					},
				],
			},
			{ text: 'The approved write is complete.' },
		],
	})
	const f = await fixture(provider)
	let resumed = f.agent
	try {
		const pending = await park(f)
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(f.runtime.busy(f.pal.id)).toBe(false)
		await f.agent.close()
		await f.runtime.stopComputer(f.pal.id)
		await f.runtime.startComputer(f.pal.id)
		updatePal(f.pal.id, 1, {
			purpose: 'Changed profile purpose',
			model: { provider: 'openai', model: 'changed' },
		})
		resumed = await f.reopen()
		for await (const _event of resumed.resumePaused({
			turnId: pending.turnId,
			checkpointId: pending.checkpointId,
			pendingDecision: { action: 'approve_tools' },
			permissionMode: 'prompt',
			reviewHold: { reason: 'Later reviews still require their own answer.' },
		})) {
		}
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(f.replacement.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(f.runtime.busy(f.pal.id)).toBe(false)
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[1])).toContain('Separate AI news by model')
		expect(JSON.stringify(provider.requests[1])).not.toContain('Changed profile purpose')
		const journal = await records(f)
		expect(journal.filter((r) => r.type === 'turn_started')).toHaveLength(1)
		expect(journal.filter((r) => r.type === 'decision_resolved')).toEqual([
			expect.objectContaining({
				turnId: pending.turnId,
				decisionId: pending.decisionId,
				decision: { action: 'approve_tools' },
			}),
		])
		const completed = journal.find((r) => r.type === 'turn_completed')
		expect(completed).toEqual(expect.objectContaining({ turnId: pending.turnId }))
		await expect(
			(async () => {
				for await (const _event of resumed.resumePaused({
					turnId: pending.turnId,
					checkpointId: pending.checkpointId,
					pendingDecision: { action: 'approve_tools' },
				})) {
				}
			})(),
		).rejects.toThrow('no longer waiting')
		expect(provider.requests).toHaveLength(2)
		expect(f.replacement.sandbox.writeFile).toHaveBeenCalledTimes(1)
	} finally {
		await resumed.close()
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('approves one recorded batch and parks the next batch with a distinct checkpoint and no remembered grant', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'first_write',
						name: 'write',
						args: { path: 'one.txt', content: 'one' },
					},
				],
			},
			{
				toolCalls: [
					{
						id: 'next_write',
						name: 'write',
						args: { path: 'two.txt', content: 'two' },
					},
				],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const first = await park(f)
		for await (const _event of f.agent.resumePaused({
			turnId: first.turnId,
			checkpointId: first.checkpointId,
			pendingDecision: { action: 'approve_tools' },
			permissionMode: 'prompt',
			reviewHold: { reason: 'A different batch requires its own approval.' },
		})) {
		}
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		const second = await findPendingCheckpoint(
			DiskSessionLog.at(f.state.paths, { sessionId: f.id }),
		)
		expect(second?.turnId).toBe(first.turnId)
		expect(second?.checkpointId).not.toBe(first.checkpointId)
		expect(second?.pending.request).toEqual(
			expect.objectContaining({
				toolCalls: [expect.objectContaining({ id: 'next_write' })],
			}),
		)
		expect(f.agent.approvalLatched()).toBe(false)
		await expect(
			(async () => {
				for await (const _event of f.agent.resumePaused({
					turnId: first.turnId,
					checkpointId: first.checkpointId,
					pendingDecision: { action: 'approve_tools' },
				})) {
				}
			})(),
		).rejects.toThrow('newer review')
		expect(provider.requests).toHaveLength(2)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('refuses mismatched decisions, foreign journals, repinned models and revoked execution before guest admission', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'write', args: { path: 'notes.txt', content: 'pending' } }],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const pending = await park(f)
		const admit = vi.spyOn(f.runtime, 'admit')
		const invoke = async (extra: Parameters<typeof f.agent.resumePaused>[0]) => {
			for await (const _event of f.agent.resumePaused(extra)) {
			}
		}
		await expect(
			invoke({
				turnId: pending.turnId,
				pendingDecision: { action: 'continue' },
			}),
		).rejects.toThrow('does not apply')
		await expect(
			invoke({
				turnId: generateTurnId(),
				pendingDecision: { action: 'approve_tools' },
			}),
		).rejects.toThrow('no longer')
		await expect(
			invoke({
				turnId: pending.turnId,
				pendingDecision: { action: 'approve_tools' },
				model: { provider: 'openai', model: 'other' },
			}),
		).rejects.toThrow('pinned model')
		await expect(
			invoke({
				turnId: pending.turnId,
				pendingDecision: { action: 'approve_tools' },
				assertExecutionAllowed: () => {
					throw new Error('Actor permission revoked.')
				},
			}),
		).rejects.toThrow('revoked')
		await expect(
			f.agent.resumeDurable({
				entry: { ...f.scope, turnId: pending.turnId },
				sessionLog: new DiskSessionLog({
					sessionId: f.id,
					file: join(root, 'foreign.jsonl'),
					sessionDir: join(root, 'foreign'),
				}),
			}),
		).rejects.toThrow('own original')
		expect(admit).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		// Durable read uses the genuine journal and returns the actual waiting state, without inference.
		const waiting = await f.agent.resumeDurable({
			entry: { ...f.scope, turnId: pending.turnId },
			sessionLog: DiskSessionLog.at(f.state.paths, { sessionId: f.id }),
		})
		expect(waiting).toEqual(
			expect.objectContaining({
				resumed: false,
				reason: 'awaiting-decision',
				pending: expect.objectContaining({ request: pending.pending.request }),
			}),
		)
		expect(provider.requests).toHaveLength(1)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('runs owned guest commands without asking when only a reviewer callback is supplied', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'bash', args: { command: 'pwd' } }] },
			{ text: 'Guest command completed.' },
		],
	})
	const f = await fixture(provider)
	const onPermission = vi.fn(async () => ({ kind: 'reject' as const }))
	try {
		for await (const _event of f.agent.send([createUserMessage('Inspect your computer.')], {
			onPermission,
		})) {
		}
		expect(f.original.sandbox.exec).toHaveBeenCalledTimes(1)
		expect(onPermission).not.toHaveBeenCalled()
		expect(
			await findPendingCheckpoint(DiskSessionLog.at(f.state.paths, { sessionId: f.id })),
		).toBeNull()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('retains an explicit durable review hold even when no permission mode is supplied', async () => {
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'write', args: { path: 'waiting.txt', content: 'waiting' } }] }],
	})
	const f = await fixture(provider)
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		for await (const _event of f.agent.send([createUserMessage('Prepare this reviewed write.')], {
			reviewHold: { reason: 'The operator requested review.' },
			onPermission,
		})) {
		}
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(onPermission).not.toHaveBeenCalled()
		expect(
			await findPendingCheckpoint(DiskSessionLog.at(f.state.paths, { sessionId: f.id })),
		).not.toBeNull()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('does not turn automatic guest approval into a host escape or an override of deny rules', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'bash', args: { command: 'pwd', dangerously_disable_sandbox: true } }],
			},
			{ toolCalls: [{ name: 'write', args: { path: 'denied.txt', content: 'denied' } }] },
			{ text: 'These operations are unavailable.' },
		],
	})
	const f = await fixture(provider)
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	let restricted: Awaited<ReturnType<typeof f.reopen>> | undefined
	try {
		await f.agent.close()
		restricted = await f.reopen(undefined, [{ type: 'deny_by_name', toolNames: ['write'] }])
		for await (const _event of restricted.send(
			[createUserMessage('Try the requested operations.')],
			{
				onPermission,
			},
		)) {
		}
		expect(f.original.sandbox.exec).not.toHaveBeenCalled()
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(onPermission).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(3)
		expect((await records(f)).filter((record) => record.type === 'tool_completed')).toEqual([
			expect.objectContaining({ isError: true }),
			expect.objectContaining({ isError: true }),
		])
	} finally {
		await restricted?.close()
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('retains ordinary live permission prompting when reviewHold is absent', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'write', args: { path: 'notes.txt', content: 'live' } }],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	const onPermission = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		vi.mocked(f.original.sandbox.readFile).mockRejectedValue(
			Object.assign(new Error('absent'), { code: 'ENOENT' }),
		)
		for await (const _event of f.agent.send([createUserMessage('Write live notes')], {
			permissionMode: 'prompt',
			onPermission,
		})) {
		}
		expect(onPermission).toHaveBeenCalledTimes(1)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(
			await findPendingCheckpoint(DiskSessionLog.at(f.state.paths, { sessionId: f.id })),
		).toBeNull()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

async function actionFixture(f: Awaited<ReturnType<typeof fixture>>) {
	const pending = await park(f)
	const log = DiskSessionLog.at(f.state.paths, { sessionId: f.id })
	const waiting = await readPalWaitingReview(log, pending.turnId, pending.checkpointId)
	if (!waiting) throw new Error('Missing real parked review.')
	const action: PalReviewAction = {
		actor: {
			tenantId: f.scope.tenantId,
			actorId: 'authenticated-operator',
			connectionId: 'verified-channel',
		},
		operationId: 'native-callback-1',
		waiting: {
			sessionId: f.id,
			turnId: pending.turnId,
			checkpointId: pending.checkpointId,
			decisionId: pending.decisionId,
			requestKind: 'tool_review',
			requestRecord: waiting.requestRecord,
			checkpointDocSha256: waiting.checkpointDocSha256,
		},
		answer: { action: 'approve_once' },
	}
	const create = (authorize = async () => {}) =>
		createCliPalReviewActions({
			profile: f.pal,
			scope: f.scope,
			paths: f.state.paths,
			session: f.agent,
			authorize,
			currentPermissionMode: () => 'prompt',
		})
	return { action, create, log }
}

it('authenticates a durable exact review action and returns the actual resolution receipt across gate restart', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'write', args: { path: 'approved.txt', content: 'once' } }],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const a = await actionFixture(f)
		const authorize = vi.fn(async () => {})
		const receipt = await a.create(authorize).execute(a.action)
		expect(receipt).toEqual(
			expect.objectContaining({
				status: 'resolved',
				decisionId: a.action.waiting.decisionId,
			}),
		)
		expect(receipt.resolutionRecord.seq).toBeGreaterThan(receipt.requestRecord.seq)
		expect(authorize).toHaveBeenCalledWith(
			a.action.actor,
			a.action.waiting,
			expect.any(AbortSignal),
		)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(2)
		// Fresh host gate, no transient in-memory acknowledgement or preappended decision.
		expect(await a.create(authorize).execute(structuredClone(a.action))).toEqual(receipt)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(2)
		await expect(
			a.create().execute({
				...a.action,
				answer: { action: 'reject', feedback: 'changed' },
			}),
		).rejects.toThrow('Conflicting retry')
		await expect(
			a.create().execute({
				...a.action,
				actor: { ...a.action.actor, actorId: 'changed-authenticated-actor' },
			}),
		).rejects.toThrow('Conflicting retry')
		expect((await records(f)).filter((r) => r.type === 'decision_resolved')).toHaveLength(1)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('refuses forged review references and revoked authenticated actions without acquiring the guest or reserving permission', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'write', args: { path: 'pending.txt', content: 'hold' } }],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const a = await actionFixture(f)
		const admit = vi.spyOn(f.runtime, 'admit')
		await expect(
			a.create().execute({
				...a.action,
				waiting: {
					...a.action.waiting,
					requestRecord: {
						...a.action.waiting.requestRecord,
						sha256: 'a'.repeat(64),
					},
				},
			}),
		).rejects.toThrow('actual waiting')
		await expect(
			a
				.create(async () => {
					throw new Error('Current actor authority revoked.')
				})
				.execute(a.action),
		).rejects.toThrow('revoked')
		await expect(
			a.create().execute({
				...a.action,
				waiting: { ...a.action.waiting, sessionId: generateSessionId() },
			}),
		).rejects.toThrow('Foreign')
		await expect(
			a.create().execute({
				...a.action,
				answer: { action: 'approve_once', remember: ['write'] },
			} as unknown as PalReviewAction),
		).rejects.toThrow('Unexpected')
		expect(admit).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		// Invalid/denied ingress did not consume this real operation identity.
		await a.create().execute(a.action)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('captures authenticated policy and the native resume port before an awaited action can mutate factory options', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'captured.txt', content: 'once' } }] },
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	let enter!: () => void
	let release!: () => void
	const entered = new Promise<void>((resolve) => {
		enter = resolve
	})
	const released = new Promise<void>((resolve) => {
		release = resolve
	})
	try {
		const a = await actionFixture(f)
		let first = true
		const authorize = vi.fn(async () => {
			if (first) {
				first = false
				enter()
				await released
			}
		})
		const session = { resumePaused: f.agent.resumePaused.bind(f.agent) }
		const options = {
			profile: f.pal,
			scope: f.scope,
			paths: f.state.paths,
			session,
			authorize,
			currentPermissionMode: () => 'prompt' as const,
		}
		const gate = createCliPalReviewActions(options)
		const attempt = gate.execute(a.action)
		await entered
		const replacedPolicy = vi.fn(async () => {
			throw new Error('An unrelated host policy was substituted.')
		})
		const replacedSession = vi.fn(f.agent.resumePaused.bind(f.agent))
		options.authorize = replacedPolicy
		session.resumePaused = replacedSession
		release()
		expect(await attempt).toEqual(expect.objectContaining({ status: 'resolved' }))
		expect(authorize.mock.calls.length).toBeGreaterThan(3)
		expect(replacedPolicy).not.toHaveBeenCalled()
		expect(replacedSession).not.toHaveBeenCalled()
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(2)
	} finally {
		release()
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('reserves one action across concurrent gate instances and never guesses an unknown attempt was safe to replay', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'write', args: { path: 'pending.txt', content: 'once' } }],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	let enter!: () => void
	let release!: () => void
	const entered = new Promise<void>((resolve) => {
		enter = resolve
	})
	const released = new Promise<void>((resolve) => {
		release = resolve
	})
	try {
		const a = await actionFixture(f)
		let checks = 0
		const first = a
			.create(async () => {
				if (++checks === 3) {
					enter()
					await released
				}
			})
			.execute(a.action)
		await entered // This boundary is after both permanent reservations, before guest work.
		await expect(a.create().execute(structuredClone(a.action))).rejects.toThrow(
			'unconfirmed outcome',
		)
		await expect(
			a.create().execute({ ...a.action, operationId: 'other-native-callback' }),
		).rejects.toThrow('reserved action')
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		release()
		const receipt = await first
		expect(await a.create().execute(a.action)).toEqual(receipt)
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		// The losing operation cannot adopt the winning actor's resolution on retry.
		await expect(
			a.create().execute({ ...a.action, operationId: 'other-native-callback' }),
		).rejects.toThrow('another reserved action')
	} finally {
		release()
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('rechecks action authority between guest operations and never reexecutes a resolved approval', async () => {
	let revoke = false
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ name: 'write', args: { path: 'pending.txt', content: 'blocked' } }],
			},
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const a = await actionFixture(f)
		vi.mocked(f.original.sandbox.readFile).mockImplementation(async () => {
			revoke = true
			throw Object.assign(new Error('absent'), { code: 'ENOENT' })
		})
		const gate = a.create(async () => {
			if (revoke) throw new Error('Action authority revoked.')
		})
		await expect(gate.execute(a.action)).rejects.toThrow()
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		revoke = false
		expect((await records(f)).some((record) => record.type === 'decision_resolved')).toBe(true)
		expect(await a.create().execute(a.action)).toEqual(
			expect.objectContaining({ status: 'resolved' }),
		)
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('keeps a durable reservation with no resolution when consent disappears after reservation and before native admission', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'pending.txt', content: 'blocked' } }] },
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const a = await actionFixture(f)
		let checks = 0
		await expect(
			a
				.create(async () => {
					if (++checks === 3) throw new Error('Consent revoked after reservation.')
				})
				.execute(a.action),
		).rejects.toThrow('revoked')
		expect((await records(f)).filter((record) => record.type === 'decision_resolved')).toEqual([])
		await expect(a.create().execute(a.action)).rejects.toThrow('unconfirmed outcome')
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('keeps the trusted host current plan mode stricter than a one-batch authenticated approval', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'plan.txt', content: 'blocked' } }] },
			{ text: 'The current plan mode refused the change.' },
		],
	})
	const f = await fixture(provider)
	try {
		const a = await actionFixture(f)
		const options = {
			profile: f.pal,
			scope: f.scope,
			paths: f.state.paths,
			session: f.agent,
			authorize: async () => {},
			currentPermissionMode: () => 'plan' as const,
		}
		expect(await createCliPalReviewActions(options).execute(a.action)).toEqual(
			expect.objectContaining({ status: 'resolved' }),
		)
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[1])).toContain(PLAN_MODE_REFUSAL)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it.each(['auto', 'accept-edits'] as const)(
	'holds a later reviewed batch after approve_once when the current host mode is %s',
	async (mode) => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'write', args: { path: 'first.txt', content: 'once' } }] },
				{ toolCalls: [{ name: 'write', args: { path: 'later.txt', content: 'must wait' } }] },
			],
		})
		const f = await fixture(provider)
		try {
			const a = await actionFixture(f)
			await createCliPalReviewActions({
				profile: f.pal,
				scope: f.scope,
				paths: f.state.paths,
				session: f.agent,
				authorize: async () => {},
				currentPermissionMode: () => mode,
			}).execute(a.action)
			expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
			expect(f.original.sandbox.writeFile).toHaveBeenCalledWith('first.txt', 'once')
			expect(provider.requests).toHaveLength(2)
			const later = await findPendingCheckpoint(a.log)
			expect(later?.turnId).toBe(a.action.waiting.turnId)
			expect(later?.checkpointId).not.toBe(a.action.waiting.checkpointId)
			expect(later?.pending.request).toEqual(
				expect.objectContaining({
					type: 'tool_review',
					toolCalls: [
						expect.objectContaining({ input: { path: 'later.txt', content: 'must wait' } }),
					],
				}),
			)
		} finally {
			await f.agent.close()
			await f.runtime.close()
			closeSessions(f.state)
		}
	},
)

it.each(['auto', 'accept-edits'] as const)(
	'keeps the one-batch ceiling when the live host switches from prompt to %s during the approved guest write',
	async (nextMode) => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'write', args: { path: 'first.txt', content: 'once' } }] },
				{ toolCalls: [{ name: 'write', args: { path: 'later.txt', content: 'must wait' } }] },
			],
		})
		const f = await fixture(provider)
		try {
			const a = await actionFixture(f)
			let mode: PermissionMode = 'prompt'
			vi.mocked(f.original.sandbox.writeFile).mockImplementation(async () => {
				mode = nextMode
			})
			await createCliPalReviewActions({
				profile: f.pal,
				scope: f.scope,
				paths: f.state.paths,
				session: f.agent,
				authorize: async () => {},
				currentPermissionMode: () => mode,
			}).execute(a.action)
			expect(mode).toBe(nextMode)
			expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
			expect(provider.requests).toHaveLength(2)
			const later = await findPendingCheckpoint(a.log)
			expect(later?.turnId).toBe(a.action.waiting.turnId)
			expect(later?.checkpointId).not.toBe(a.action.waiting.checkpointId)
			expect(
				(await records(f)).filter((record) => record.type === 'decision_resolved'),
			).toHaveLength(1)
		} finally {
			await f.agent.close()
			await f.runtime.close()
			closeSessions(f.state)
		}
	},
)

it('refuses an action host missing its current mode port instead of overriding an actually reopened plan session', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'plan.txt', content: 'blocked' } }] },
			{ text: 'Must not request inference.' },
		],
	})
	const f = await fixture(provider)
	let planned: Awaited<ReturnType<typeof f.reopen>> | undefined
	try {
		await actionFixture(f)
		await f.agent.close()
		planned = await f.reopen('plan')
		const admit = vi.spyOn(f.runtime, 'admit')
		expect(() =>
			createCliPalReviewActions({
				profile: f.pal,
				scope: f.scope,
				paths: f.state.paths,
				session: planned,
				authorize: async () => {},
			} as unknown as CliPalReviewActionsOptions),
		).toThrow('trusted host current permission mode')
		expect(admit).not.toHaveBeenCalled()
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect((await records(f)).filter((record) => record.type === 'decision_resolved')).toEqual([])
	} finally {
		await planned?.close()
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('applies current plan review controls to a later rule-allowed batch after native checkpoint replay', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'first.txt', content: 'blocked' } }] },
			{
				toolCalls: [
					{
						id: 'later-plan-review',
						name: 'write',
						args: { path: 'later.txt', content: 'blocked too' },
					},
				],
			},
			{ text: 'Both changes remain blocked by the current plan mode.' },
		],
	})
	const f = await fixture(provider)
	try {
		const pending = await park(f)
		for await (const _event of f.agent.resumePaused({
			turnId: pending.turnId,
			checkpointId: pending.checkpointId,
			pendingDecision: { action: 'approve_tools' },
			permissionMode: 'auto',
			currentPermissionMode: () => 'plan',
			rules: [{ type: 'allow_by_name', toolNames: ['write'] }],
		})) {
		}
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(3)
		expect(JSON.stringify(provider.requests[2])).toContain(PLAN_MODE_REFUSAL)
		const recorded = await records(f)
		expect(recorded.filter((record) => record.type === 'decision_resolved')).toEqual([
			expect.objectContaining({ decision: { action: 'approve_tools' } }),
		])
		expect(
			recorded.find(
				(record) => record.type === 'tool_completed' && record.toolUseId === 'later-plan-review',
			),
		).toEqual(
			expect.objectContaining({
				isError: true,
				result: `Error: Tool "write" was not executed. ${PLAN_MODE_REFUSAL}`,
			}),
		)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('refuses an actually expired journal decision before acquiring the guest even with an explicit checkpoint', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'pending.txt', content: 'blocked' } }] },
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const pending = await park(f)
		const log = DiskSessionLog.at(f.state.paths, { sessionId: f.id })
		const held = await log.claim({
			holder: 'expiry-fixture-writer',
			ttlMs: 90_000,
			repairTornTail: false,
		})
		if (!held) throw new Error('The actual parked fixture has another writer.')
		try {
			await log.append(held, {
				type: 'decision_requested',
				turnId: pending.turnId,
				decisionId: pending.decisionId,
				checkpointId: pending.checkpointId,
				request: pending.pending.request,
				deadlineAt: new Date(1).toISOString(),
			})
		} finally {
			await log.release(held)
		}
		const admit = vi.spyOn(f.runtime, 'admit')
		await expect(
			(async () => {
				for await (const _event of f.agent.resumePaused({
					turnId: pending.turnId,
					checkpointId: pending.checkpointId,
					pendingDecision: { action: 'approve_tools' },
				})) {
				}
			})(),
		).rejects.toThrow('expired')
		expect(admit).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(1)
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('retains a failed native resume writer release for confirmed close retry without reopening paid work', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'notes.txt', content: 'one' } }] },
			{ text: 'Done' },
		],
	})
	const f = await fixture(provider)
	try {
		const pending = await park(f)
		const release = DiskSessionLog.prototype.release
		vi.spyOn(DiskSessionLog.prototype, 'release')
			.mockRejectedValueOnce(new Error('Writer release unconfirmed.'))
			.mockImplementation(release)
		await expect(
			(async () => {
				for await (const _event of f.agent.resumePaused({
					turnId: pending.turnId,
					checkpointId: pending.checkpointId,
					pendingDecision: { action: 'approve_tools' },
				})) {
				}
			})(),
		).rejects.toThrow('unconfirmed')
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		await expect(
			f.agent
				.send([createUserMessage('Overlap')])
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toThrow('cleanup')
		await expect(f.agent.close()).resolves.toBeUndefined()
		expect(await DiskSessionLog.at(f.state.paths, { sessionId: f.id }).lease()).toEqual(
			expect.objectContaining({ holder: '' }),
		)
		expect(provider.requests).toHaveLength(2)
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('uses the original recorded iteration limit rather than the reopened session defaults', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'bounded.txt', content: 'one' } }] },
			{ text: 'Must not request another paid iteration' },
		],
	})
	const f = await fixture(provider)
	try {
		vi.mocked(f.original.sandbox.readFile).mockRejectedValue(
			Object.assign(new Error('absent'), { code: 'ENOENT' }),
		)
		for await (const _event of f.agent.send([createUserMessage('One iteration only')], {
			permissionMode: 'prompt',
			reviewHold: { reason: 'Wait for approval.' },
			limits: { tokenBudget: 0, maxIterations: 1, timeoutMs: 0 },
		})) {
		}
		const pending = await findPendingCheckpoint(
			DiskSessionLog.at(f.state.paths, { sessionId: f.id }),
		)
		if (!pending) throw new Error('The actual query did not park.')
		for await (const _event of f.agent.resumePaused({
			turnId: pending.turnId,
			checkpointId: pending.checkpointId,
			pendingDecision: { action: 'approve_tools' },
		})) {
		}
		expect(f.original.sandbox.writeFile).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(1)
		expect((await records(f)).filter((record) => record.type === 'turn_started')).toEqual([
			expect.objectContaining({ config: expect.objectContaining({ maxIterations: 1 }) }),
		])
		expect(await DiskSessionLog.at(f.state.paths, { sessionId: f.id }).activeTurn()).toBeNull()
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})

it('records an authenticated rejection without executing the reviewed guest change and forwards its exact feedback', async () => {
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'write', args: { path: 'rejected.txt', content: 'blocked' } }] },
			{ text: 'I will respect that decision.' },
		],
	})
	const f = await fixture(provider)
	try {
		const a = await actionFixture(f)
		const receipt = await a.create().execute({
			...a.action,
			answer: { action: 'reject', feedback: 'Do not write this reviewed file.' },
		})
		expect(receipt.status).toBe('resolved')
		expect(f.original.sandbox.writeFile).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[1])).toContain('Do not write this reviewed file.')
		expect((await records(f)).filter((record) => record.type === 'decision_resolved')).toEqual([
			expect.objectContaining({
				decision: { action: 'reject_tools', feedback: 'Do not write this reviewed file.' },
			}),
		])
	} finally {
		await f.agent.close()
		await f.runtime.close()
		closeSessions(f.state)
	}
})
