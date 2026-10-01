import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	BackgroundJobRegistry,
	type ComputerUseHost,
	MockLLMProvider,
	type PalEnvironmentLease,
	PalRuntime,
	ProviderRegistry,
	type Sandbox,
	type SandboxId,
	type SessionEvent,
	createUserMessage,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { PROVIDER_REGISTRY, type Preferences } from '../integrations/providers/index.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createAgentSession } from '../tui/agent.js'
import { claimPalConversation } from './conversations.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

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
			getDisplayGeometry: async () => ({ width: 1280, height: 800, scaleFactor: 1 }),
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
async function fixture(provider: MockLLMProvider, onSessionEvent?: (event: SessionEvent) => void) {
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
	const runtime = new PalRuntime({ store: getCliPalStore(), environments: { acquire } })
	await runtime.startComputer(pal.id)
	const construct = vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const scope = {
		sessionId: id,
		projectId: state.projectId,
		topicId: state.topicId,
		tenantId: state.tenantId,
	}
	const agent = await createAgentSession(
		{ version: 3, providers: [{ id: 'openai', model: 'pinned-model' }] } as Preferences,
		[
			{
				entry: PROVIDER_REGISTRY['openai'],
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
			permissionMode: 'auto',
			palEnvironment: {
				definition: pal,
				lease: original,
				admit: (signal) =>
					runtime.admit({ palId: pal.id, revision: 1, conversationId: id, signal }),
			},
		},
	)
	return { pal, id, state, agent, runtime, original, replacement, construct, scope }
}
it('puts the pinned model and purpose into the actual provider request and keeps host policy out', async () => {
	const provider = new MockLLMProvider({ responseText: 'Ready' })
	const f = await fixture(provider)
	writeFileSync(join(f.pal.workspace, 'AGENTS.md'), 'HOST_ONLY_POLICY')
	updatePal(f.pal.id, 1, {
		purpose: 'New purpose',
		model: { provider: 'openai', model: 'changed-model' },
	})
	try {
		for await (const _event of f.agent.send([createUserMessage('Start research')])) {
		}
		expect(f.construct).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'pinned-model', apiKey: 'host-provider-secret' }),
		)
		expect(provider.requests).toHaveLength(1)
		const request = provider.requests[0]
		expect(request?.model).toBe('pinned-model')
		expect(JSON.stringify(request)).toContain('Separate AI news by model.')
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
	const provider = new MockLLMProvider({ responseText: 'Must not run after revocation' })
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
