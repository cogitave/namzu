/**
 * A permission mode chosen while a turn runs reaches that turn at once.
 *
 * The mode used to travel only with a message, so a conversation started in Ask first and
 * switched to Full access went on asking for the rest of its turn. These pin the host half:
 * the running turn reads the new mode at its next decision, the change is recorded, and a mode
 * the settings close is refused in words instead of being shown as taken. The send is held
 * open by a promise the test settles, never by a clock.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, asSessionId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { PermissionSettings } from '../../permissions/settings.js'
import type { SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, type CliAcpRuntime, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(permissionSettings?: PermissionSettings) {
	const sessionId = asSessionId(fixtureUuid('live-mode-owner'))
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'zen', model: 'selected' }],
		allowCapabilityMismatch: true,
		subagents: { active: [] },
	}
	const started = deferred()
	const release = deferred()
	/** The mode the running turn would decide its next call under, read when the test asks. */
	let reading: (() => string) | undefined
	let hold = false
	const recorded = vi.fn(async (_mode: string) => {})
	const send = vi.fn((messages: readonly Message[], options: SendOptions) =>
		(async function* () {
			reading = options.currentPermissionMode
			if (hold) {
				started.resolve()
				await release.promise
			}
			options.onConversationMessages?.(messages)
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})(),
	)
	const createSession = vi.fn(async () => ({
		hasProvider: true,
		errorHint: null,
		mcpFailed: [],
		close: vi.fn(async () => {}),
		reasoningEffortLevels: ['low'] as const,
		reasoningEffortDefault: 'low' as const,
		jobs: () => [],
		send,
		setPermissionMode: recorded,
	}))
	const runtime = createCliAcpRuntime(
		{
			config: permissionSettings ? { permissionSettings } : {},
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			probe: async () => ({
				preferences,
				detected: [
					{ entry: { id: 'zen', label: 'Zen', defaultModel: 'selected' }, apiKey: 'synthetic' },
				],
				needsRepickReason: null,
			}),
			createSession,
			describeReasoning: async () => ({ effortLevels: ['low'] as const, effortDefault: 'low' }),
			readPlugins: async () => ({ plugins: [], live: false, canChange: false }),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async (wire: string) => ({ sessionId: asSessionId(wire) }),
		} as unknown as AcpRuntimeDependencies,
	)
	const prompt = (permissionMode: SendOptions['permissionMode']) =>
		runtime.gateway.prompt({
			sessionId,
			prompt: 'Run the checks',
			cwd: '/project',
			history: [],
			filesystem: undefined,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'reject' }),
			options: { permissionMode },
		})
	return {
		runtime,
		sessionId,
		prompt,
		recorded,
		send,
		started,
		release,
		holdNextSend: () => {
			hold = true
		},
		modeNow: () => reading?.(),
	}
}

describe('a mode chosen while a turn runs', () => {
	it('is the mode the running turn decides its next call under, and is recorded', async () => {
		const f = fixture({ allowBypassMode: true })
		try {
			f.holdNextSend()
			const turn = f.prompt('prompt')
			await f.started.promise
			expect(f.modeNow()).toBe('prompt')

			const answer = await f.runtime.setPermissionMode?.(f.sessionId, 'bypass')

			expect(answer).toEqual({ mode: 'bypass', applied: 'now' })
			expect(f.modeNow(), 'the turn already running reads the new mode').toBe('bypass')
			expect(f.recorded).toHaveBeenCalledExactlyOnceWith('bypass')
			f.release.resolve()
			await turn
		} finally {
			await f.runtime.close()
		}
	})

	it('can go back to asking, and the turn follows each change in order', async () => {
		const f = fixture({ allowBypassMode: true })
		try {
			f.holdNextSend()
			const turn = f.prompt('bypass')
			await f.started.promise
			await f.runtime.setPermissionMode?.(f.sessionId, 'prompt')
			expect(f.modeNow()).toBe('prompt')
			await f.runtime.setPermissionMode?.(f.sessionId, 'plan')
			expect(f.modeNow()).toBe('plan')
			f.release.resolve()
			await turn
		} finally {
			await f.runtime.close()
		}
	})

	it('is refused in words when the settings close the mode, and the turn keeps asking', async () => {
		const f = fixture({ autoMode: { model: 'cheap' } })
		try {
			f.holdNextSend()
			const turn = f.prompt('prompt')
			await f.started.promise

			await expect(f.runtime.setPermissionMode?.(f.sessionId, 'bypass')).rejects.toThrow(
				'Allow bypass permissions mode',
			)

			expect(f.modeNow()).toBe('prompt')
			expect(f.recorded).not.toHaveBeenCalled()
			f.release.resolve()
			await turn
		} finally {
			await f.runtime.close()
		}
	})

	it('only checks the mode when no turn is running: the next message carries it', async () => {
		const f = fixture({ allowBypassMode: true })
		try {
			await f.prompt('prompt')
			expect(await f.runtime.setPermissionMode?.(f.sessionId, 'bypass')).toEqual({
				mode: 'bypass',
				applied: 'next-message',
			})
			expect(f.recorded).not.toHaveBeenCalled()
			await f.prompt('bypass')
			expect(f.send.mock.calls[1]?.[1]).toMatchObject({ permissionMode: 'bypass' })
		} finally {
			await f.runtime.close()
		}
	})

	it('does not leak into the next turn: it starts from what its own message says', async () => {
		const f = fixture({ allowBypassMode: true })
		try {
			f.holdNextSend()
			const first = f.prompt('prompt')
			await f.started.promise
			await f.runtime.setPermissionMode?.(f.sessionId, 'bypass')
			f.release.resolve()
			await first
			await f.prompt('prompt')
			expect(f.modeNow()).toBe('prompt')
		} finally {
			await f.runtime.close()
		}
	})
})

describe('the desktop method', () => {
	let folder = ''
	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), 'namzu-live-mode-host-'))
	})
	afterEach(() => removeTempDir(folder))
	const hostOf = (runtime: Partial<CliAcpRuntime>) =>
		createDesktopHostExtensions(runtime as CliAcpRuntime, folder)

	it('is offered only by an engine that can change a running turn', () => {
		expect(Object.keys(hostOf({ setPermissionMode: async () => undefined as never }))).toContain(
			'namzu/session/set-permission-mode',
		)
		expect(Object.keys(hostOf({}))).not.toContain('namzu/session/set-permission-mode')
	})

	it('refuses a loose request or a mode it does not know, before touching a conversation', async () => {
		const setPermissionMode = vi.fn()
		const host = hostOf({ setPermissionMode })
		const method = host['namzu/session/set-permission-mode'] as (
			params: Record<string, unknown>,
		) => Promise<unknown>
		await expect(method({ sessionId: 's', mode: 'bypass', extra: 1 })).rejects.toThrow(
			'accepts only sessionId and mode',
		)
		await expect(method({ sessionId: 's', mode: 'anything' })).rejects.toThrow(
			'Invalid permission mode.',
		)
		expect(setPermissionMode).not.toHaveBeenCalled()
	})
})
