import { type Message, asSessionId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import type { PluginInventoryView } from '../../integrations/plugins/inventory.js'
import type { CliPluginInfo } from '../../integrations/plugins/runtime.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture() {
	const sessionId = asSessionId(fixtureUuid('desktop-settings-owner'))
	const preferences: Preferences = {
		version: 3,
		providers: [
			{ id: 'zen', model: 'selected' },
			{ id: 'openai', model: 'fallback' },
		],
		allowCapabilityMismatch: true,
		subagents: { active: ['worker'] },
	}
	let jobs: { status: string }[] = []
	let beforeDone: ((options: SendOptions) => Promise<void>) | undefined
	const sessions: { setEnabled: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
	const send = vi.fn((messages: readonly Message[], options: SendOptions) =>
		(async function* () {
			await beforeDone?.(options)
			options.onConversationMessages?.(messages)
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})(),
	)
	const createSession = vi.fn(async () => {
		let status = 'enabled'
		const plugin: CliPluginInfo = {
			name: 'ledger',
			version: '1.0.0',
			description: 'Plugin fixture',
			scope: 'project',
			rootDir: '/project/.namzu/plugins/ledger',
			get status() {
				return status
			},
			startupEnabled: true,
			tools: [],
			skills: [],
			hookModules: [],
			mcpServers: [],
		}
		const setEnabled = vi.fn(async (_name: string, enabled: boolean) => {
			status = enabled ? 'enabled' : 'disabled'
		})
		const close = vi.fn(async () => {})
		sessions.push({ setEnabled, close })
		return {
			hasProvider: true,
			errorHint: null,
			mcpFailed: [],
			close,
			reasoningEffortLevels: ['low', 'high'] as const,
			reasoningEffortDefault: 'low' as const,
			jobs: () => jobs,
			plugins: { list: () => [plugin], setEnabled, rememberState: vi.fn(async () => {}) },
			send,
		}
	})
	const describeReasoning = vi.fn(async (_preferences: Preferences) => ({
		effortLevels: ['medium', 'ultra'] as const,
		effortDefault: 'medium' as const,
	}))
	const readPlugins = vi.fn(
		async ({
			runtime,
			canChange,
		}: Parameters<
			NonNullable<AcpRuntimeDependencies['readPlugins']>
		>[0]): Promise<PluginInventoryView> => ({
			plugins:
				runtime?.list().map(({ name, version, description, scope, status, startupEnabled }) => ({
					name,
					version,
					description,
					scope,
					status,
					startupEnabled,
				})) ?? [],
			live: Boolean(runtime),
			canChange: canChange ?? false,
		}),
	)
	const decideTrust = vi.fn(({ cwd }: { cwd: string }) => ({ allowed: true, cwd }))
	const resolveProjectContext = vi.fn((ctx: unknown) => ctx)
	const runtime = createCliAcpRuntime(
		{
			config: { plugins: { enabled: true } },
			formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
		},
		{
			probe: async () => ({
				preferences,
				detected: [{ entry: { id: 'zen', label: 'Zen', defaultModel: 'selected' } }],
				needsRepickReason: null,
			}),
			createSession,
			describeReasoning,
			readPlugins,
			decideTrust,
			resolveProjectContext,
			resolveSession: async (wire: string) => ({ sessionId: asSessionId(wire) }),
		} as unknown as AcpRuntimeDependencies,
	)
	const prompt = (
		options?: Pick<SendOptions, 'effort' | 'permissionMode'>,
		ask?: Parameters<typeof runtime.gateway.prompt>[0]['ask'],
	) =>
		runtime.gateway.prompt({
			sessionId,
			prompt: 'Test the composer',
			cwd: '/project',
			history: [],
			filesystem: undefined,
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: ask ?? (async () => ({ kind: 'reject' })),
			...(options ? { options } : {}),
		})
	return {
		runtime,
		sessionId,
		preferences,
		createSession,
		describeReasoning,
		readPlugins,
		decideTrust,
		resolveProjectContext,
		send,
		sessions,
		prompt,
		setJobs: (value: { status: string }[]) => {
			jobs = value
		},
		holdSend: (callback: typeof beforeDone) => {
			beforeDone = callback
		},
	}
}

describe('ACP composer settings use the exact owned session', () => {
	it('reads a model menu without creating a session and preserves the selected fallback chain', async () => {
		const f = fixture()
		try {
			expect(await f.runtime.modelSettings('zen', 'unseen', f.sessionId)).toEqual({
				effortLevels: ['medium', 'ultra'],
				effortDefault: 'medium',
			})
			expect(f.createSession).not.toHaveBeenCalled()
			expect(f.describeReasoning.mock.calls[0]?.[0]).toEqual({
				...f.preferences,
				providers: [
					{ id: 'zen', model: 'unseen' },
					{ id: 'openai', model: 'fallback' },
				],
			})
			await f.prompt()
			expect(await f.runtime.modelSettings('zen', 'selected', f.sessionId)).toEqual({
				effortLevels: ['low', 'high'],
				effortDefault: 'low',
			})
			expect(f.describeReasoning).toHaveBeenCalledOnce()
		} finally {
			await f.runtime.close()
		}
	})

	it('passes the exact chosen effort and permission mode into send and defaults to asking', async () => {
		const f = fixture()
		try {
			await f.prompt({ effort: 'high', permissionMode: 'plan' })
			expect(f.send.mock.calls[0]?.[1]).toMatchObject({ effort: 'high', permissionMode: 'plan' })
			expect(f.send.mock.calls[0]?.[0].at(-1)).toMatchObject({
				role: 'user',
				content: 'Test the composer',
			})
			await f.prompt()
			expect(f.send.mock.calls[1]?.[1]).toMatchObject({ permissionMode: 'prompt' })
			expect(f.send.mock.calls[1]?.[1]).not.toHaveProperty('effort')
		} finally {
			await f.runtime.close()
		}
	})

	it('refuses effort unavailable to the executing model before any model send', async () => {
		const f = fixture()
		try {
			await expect(f.prompt({ effort: 'ultra', permissionMode: 'auto' })).rejects.toThrow(
				'not available',
			)
			expect(f.send).not.toHaveBeenCalled()
			await f.prompt({ effort: 'low', permissionMode: 'strict' })
			expect(f.send).toHaveBeenCalledOnce()
		} finally {
			await f.runtime.close()
		}
	})
})

describe('ACP plugin controls do not start executable sessions from a menu', () => {
	it('reads the trusted project inventory before any turn and refuses unloaded mutations', async () => {
		const f = fixture()
		try {
			expect(await f.runtime.plugins('/project', f.sessionId)).toMatchObject({
				live: false,
				canChange: false,
			})
			expect(f.readPlugins.mock.calls[0]?.[0]).toMatchObject({
				cwd: '/project',
				config: { enabled: true },
				canChange: false,
			})
			expect(f.createSession).not.toHaveBeenCalled()
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project'),
			).rejects.toThrow('Start this conversation')
			expect(f.createSession).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
	})

	it('does not read plugin metadata or mutate an existing session after project trust is denied', async () => {
		const f = fixture()
		try {
			await f.prompt()
			f.decideTrust.mockImplementation(({ cwd }) => ({ allowed: false, cwd }))
			await expect(f.runtime.plugins('/project', f.sessionId)).rejects.toThrow('Trust')
			expect(f.readPlugins).not.toHaveBeenCalled()
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project'),
			).rejects.toThrow()
			expect(f.sessions[0]?.setEnabled).not.toHaveBeenCalled()
		} finally {
			await f.runtime.close()
		}
	})

	it('changes only a loaded idle plugin and refuses running jobs or another project', async () => {
		const f = fixture()
		try {
			await f.prompt()
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'missing', false, '/project'),
			).rejects.toThrow('not loaded')
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/another-project'),
			).rejects.toThrow('another project')
			f.setJobs([{ status: 'running' }])
			expect(await f.runtime.plugins('/project', f.sessionId)).toMatchObject({
				live: true,
				canChange: false,
			})
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project'),
			).rejects.toThrow('active work')
			expect(f.sessions[0]?.setEnabled).not.toHaveBeenCalled()
			f.setJobs([{ status: 'completed' }])
			expect(
				await f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project'),
			).toMatchObject({
				live: true,
				canChange: true,
				plugins: [{ name: 'ledger', status: 'disabled' }],
			})
			expect(f.sessions[0]?.setEnabled).toHaveBeenCalledExactlyOnceWith('ledger', false)
		} finally {
			await f.runtime.close()
		}
	})

	it('refuses plugin changes while the prompt is waiting for an actual permission answer', async () => {
		const f = fixture()
		const asked = deferred<void>()
		const answer = deferred<{ kind: 'reject' }>()
		f.holdSend(async (options) => {
			await options.onPermission?.({
				toolCalls: [
					{ id: 'call', name: 'bash', input: { command: 'npm run dev' }, isDestructive: false },
				],
			})
		})
		const turn = f.prompt(undefined, async () => {
			asked.resolve()
			return answer.promise
		})
		try {
			await asked.promise
			expect(await f.runtime.plugins('/project', f.sessionId)).toMatchObject({
				live: true,
				canChange: false,
			})
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project'),
			).rejects.toThrow('active work')
			expect(f.sessions[0]?.setEnabled).not.toHaveBeenCalled()
			answer.resolve({ kind: 'reject' })
			await turn
			expect(await f.runtime.plugins('/project', f.sessionId)).toMatchObject({ canChange: true })
		} finally {
			answer.resolve({ kind: 'reject' })
			await turn
			await f.runtime.close()
		}
	})

	it('reapplies a successful conversation-only plugin choice after model replacement', async () => {
		const f = fixture()
		try {
			await f.prompt()
			await f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project')
			await f.runtime.selectProvider(f.sessionId, 'zen', 'replacement')
			await f.prompt()
			expect(f.sessions[0]?.close).toHaveBeenCalledOnce()
			expect(f.sessions[1]?.setEnabled).toHaveBeenCalledExactlyOnceWith('ledger', false)
			expect(await f.runtime.plugins('/project', f.sessionId)).toMatchObject({
				plugins: [{ status: 'disabled', startupEnabled: true }],
			})
		} finally {
			await f.runtime.close()
		}
	})

	it('does not replay an unsuccessful plugin choice into a replacement model session', async () => {
		const f = fixture()
		try {
			await f.prompt()
			f.sessions[0]?.setEnabled.mockRejectedValueOnce(new Error('Could not change this plugin.'))
			await expect(
				f.runtime.setPluginEnabled(f.sessionId, 'ledger', false, '/project'),
			).rejects.toThrow('Could not change')
			await f.runtime.selectProvider(f.sessionId, 'zen', 'replacement')
			await f.prompt()
			expect(f.sessions[1]?.setEnabled).not.toHaveBeenCalled()
			expect(await f.runtime.plugins('/project', f.sessionId)).toMatchObject({
				plugins: [{ status: 'enabled' }],
			})
		} finally {
			await f.runtime.close()
		}
	})
})
