import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	type PalEnvironmentLease,
	PalOperatorMessageBroker,
	PalRuntime,
	ProviderRegistry,
	type Sandbox,
	type SandboxId,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CommandContext } from '../commands/types.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/index.js'
import { closeSessions, openSessions } from '../integrations/sessions/store.js'
import { createFormatter } from '../output/index.js'
import {
	cliPalCommunicationStore,
	createCliOperatorIngressAuthorization,
	createCliPalIngressAuthorization,
	createCliPalIngressHost,
} from './communication.js'
import { createPalInboxStarter } from './inbox-start.js'
import { createPal, getCliPalStore, updatePal } from './store.js'

const controls = vi.hoisted(() => ({ probe: vi.fn(), runtime: vi.fn(), close: vi.fn() }))
vi.mock('../tui/agent.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../tui/agent.js')>()),
	probeAgentSession: controls.probe,
}))
vi.mock('./environment.js', async () => ({
	getCliPalRuntime: controls.runtime,
	closeCliPalRuntime: controls.close,
	existingCliPalRuntime: async () => null,
	cliPalComputerStatus: async () => ({ status: 'stopped' }),
}))

let root: string
const runtimes: PalRuntime[] = []
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-pal-inbox-start-')))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	controls.runtime.mockReset()
	controls.close.mockReset().mockResolvedValue(undefined)
	controls.probe.mockReset().mockResolvedValue({
		preferences: null,
		detected: [
			{
				entry: PROVIDER_REGISTRY['openai'],
				apiKey: 'fixture-private-provider-key',
				source: { kind: 'env', envName: 'OPENAI_API_KEY' },
				alternatives: [],
			},
		],
		credentialGap: null,
		needsRepickReason: null,
	})
})
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function lease(palId: string): PalEnvironmentLease {
	const sandbox: Sandbox = {
		id: generateSessionId() as unknown as SandboxId,
		status: 'ready',
		rootDir: '/home/namzu/workspace',
		environment: 'linux-namespace',
		readFile: vi.fn(async () => Buffer.from('')),
		writeFile: vi.fn(async () => {}),
		listFiles: vi.fn(async () => []),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
			timedOut: false,
			durationMs: 0,
		})),
		destroy: vi.fn(async () => {}),
	}
	return {
		palId,
		environmentId: 'fixture-isolated-guest',
		generation: 1,
		sandbox,
		computerUseHost: {
			id: 'fixture-guest-display',
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
				throw new Error('Unused guest display operation')
			}),
		},
		release: vi.fn(async () => {}),
	}
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const ctx: CommandContext = {
	config: { limits: { tokenBudget: 0, timeoutMs: 0, maxIterations: 5 } },
	formatter: createFormatter('text', { quiet: true }),
}

/** A Pal with one message from the owner's conversation waiting in its inbox. */
async function waitingPal(provider = new MockLLMProvider({ responseText: 'I read the note.' })) {
	const pal = createPal({
		name: 'Kiro',
		purpose: 'Reads notes.',
		model: { provider: 'openai', model: 'pinned-model' },
	})
	const operatorWorkspace = join(root, 'operator')
	mkdirSync(operatorWorkspace)
	const catalogue = await openSessions(operatorWorkspace)
	const tenantId = catalogue.tenantId
	closeSessions(catalogue)
	const broker = new PalOperatorMessageBroker({
		store: cliPalCommunicationStore(),
		pals: getCliPalStore(),
		host: createCliPalIngressHost(),
		authorize: createCliOperatorIngressAuthorization(),
	})
	const sessionId = generateSessionId()
	await broker.send(
		{ tenantId, sessionId },
		{ operationId: 'send-1', recipient: { tenantId, palId: pal.id }, body: 'Read the note.' },
	)
	const guest = lease(pal.id)
	const runtime = new PalRuntime({
		store: getCliPalStore(),
		environments: { acquire: vi.fn(async () => guest) },
	})
	runtimes.push(runtime)
	controls.runtime.mockResolvedValue(runtime)
	controls.close.mockImplementation(() => runtime.close())
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	return { pal, tenantId, sessionId, provider, guest }
}

const messages = async (palId: string, tenantId: string) =>
	(await cliPalCommunicationStore().readIngress({ tenantId: tenantId as never, palId }))
		?.messages ?? []

describe('starting a Pal from the person’s click', () => {
	it('shows waiting messages and starts nothing until the click', async () => {
		const f = await waitingPal()
		const starter = createPalInboxStarter(ctx)
		expect(await starter.status(f.pal.id)).toMatchObject({ state: 'waiting', waiting: 1 })
		expect(f.provider.requests).toEqual([])
		expect((await messages(f.pal.id, f.tenantId))[0]?.phase).toBe('pending')
		await starter.close()
	})

	it('wakes the Pal on the click: its own run reads the message and the inbox drains', async () => {
		const f = await waitingPal()
		const starter = createPalInboxStarter(ctx)
		const started = await starter.start(f.pal.id, 'click-0001')
		expect(started.state).toBe('reading')
		await starter.idle()
		expect(f.provider.requests).toHaveLength(1)
		expect((await messages(f.pal.id, f.tenantId))[0]?.phase).toBe('recorded')
		// The message was read by a run in the Pal's own conversation, as untrusted context.
		const route = (
			await cliPalCommunicationStore().readIngress({
				tenantId: f.tenantId as never,
				palId: f.pal.id,
			})
		)?.routes[0]
		const state = await openSessions(f.pal.workspace)
		try {
			const log = DiskSessionLog.at(state.paths, { sessionId: route?.sessionId as never })
			const records = (await log.readAll()).entries.map((entry) => JSON.stringify(entry.record))
			expect(records.join('\n')).toContain('Read the note.')
		} finally {
			closeSessions(state)
		}
		expect(await starter.status(f.pal.id)).toMatchObject({ state: 'empty', waiting: 0 })
		await starter.close()
	})

	it('records the click as the wake evidence and not the send approval', async () => {
		const authorize = createCliPalIngressAuthorization({
			operatorWake: { evidence: 'desktop-click:abc12345' },
		})
		const request = {
			phase: 'wake',
			kind: 'operator',
			source: { kind: 'operator-conversation' },
			recipient: {},
			routeKey: {},
			body: 'x',
			replyTo: null,
		} as never
		expect(await authorize(request)).toEqual({
			allow: true,
			grant: { id: 'owner-wake-click', revision: 'desktop-click:abc12345' },
		})
		const forged = createCliPalIngressAuthorization({ operatorWake: { evidence: 'has spaces' } })
		expect(await forged(request)).toMatchObject({ allow: false })
		const none = createCliPalIngressAuthorization()
		expect(await none(request)).toMatchObject({ allow: false })
	})

	it('refuses a start without a click id, and a paused or unknown Pal', async () => {
		const f = await waitingPal()
		const starter = createPalInboxStarter(ctx)
		await expect(starter.start(f.pal.id, '')).rejects.toThrow('own click')
		await expect(starter.start('no-such-pal', 'click-0001')).rejects.toThrow('Invalid Pal id')
		updatePal(f.pal.id, f.pal.revision, { paused: true })
		await expect(starter.start(f.pal.id, 'click-0001')).rejects.toThrow('paused')
		expect(f.provider.requests).toEqual([])
		expect((await messages(f.pal.id, f.tenantId))[0]?.phase).toBe('pending')
		await starter.close()
	})

	it('starts once for repeated clicks', async () => {
		const f = await waitingPal()
		const release = deferred()
		const dispatch = vi.fn(async () => {
			await release.promise
			return { status: 'idle', reason: 'empty' } as const
		})
		const starter = createPalInboxStarter(ctx, { dispatch })
		const [a, b] = await Promise.all([
			starter.start(f.pal.id, 'click-0001'),
			starter.start(f.pal.id, 'click-0002'),
		])
		const c = await starter.start(f.pal.id, 'click-0003')
		expect([a.state, b.state, c.state]).toEqual(['reading', 'reading', 'reading'])
		expect(dispatch).toHaveBeenCalledTimes(1)
		release.resolve()
		await starter.idle()
		await starter.close()
	})

	it('says plainly that the computer is missing and does not start', async () => {
		const f = await waitingPal()
		const dispatch = vi.fn()
		const starter = createPalInboxStarter(ctx, {
			dispatch,
			computer: async () => ({ status: 'unavailable', notice: 'docker: command not found' }),
		})
		const view = await starter.start(f.pal.id, 'click-0001')
		expect(view.state).toBe('failed')
		expect(view.message).toBe(
			'Kiro’s computer is not available on this machine yet. Install and start Docker or Podman, then start Kiro again.',
		)
		expect(view.message).not.toContain('command not found')
		expect(dispatch).not.toHaveBeenCalled()
		await starter.close()
	})

	it('reports a failed run in plain words and lets Retry start again', async () => {
		const f = await waitingPal()
		const release = deferred()
		const dispatch = vi
			.fn()
			.mockRejectedValueOnce(new Error('ECONNRESET at socket.js:12'))
			.mockImplementationOnce(async () => {
				await release.promise
				return { status: 'idle', reason: 'empty' }
			})
		const starter = createPalInboxStarter(ctx, { dispatch })
		await starter.start(f.pal.id, 'click-0001')
		await starter.idle()
		const failed = await starter.status(f.pal.id)
		expect(failed).toMatchObject({
			state: 'failed',
			message: 'Kiro could not be started. Try again in a moment.',
		})
		expect(failed.message).not.toContain('ECONNRESET')
		const retried = await starter.start(f.pal.id, 'click-0002')
		expect(retried.state).toBe('reading')
		release.resolve()
		await starter.idle()
		expect(dispatch).toHaveBeenCalledTimes(2)
		await starter.close()
	})

	it('starts nothing when the Pal is already running a conversation', async () => {
		const f = await waitingPal()
		const dispatch = vi.fn()
		const starter = createPalInboxStarter(ctx, { dispatch, busy: async () => true })
		expect((await starter.start(f.pal.id, 'click-0001')).state).toBe('reading')
		expect(dispatch).not.toHaveBeenCalled()
		await starter.close()
	})
})
