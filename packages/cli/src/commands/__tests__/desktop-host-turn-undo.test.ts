import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, generateSessionId, generateTurnId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { FileCheckpointStore } from '../../checkpoints/store.js'
import {
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

// Real filesystem and real stores. Nothing here waits on a timer: a held
// prompt is a promise the test resolves itself, and a hang is Vitest's own
// per-test timeout.
let root: string
let cwd: string
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-turn-undo-')))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function fakeSession(extra: Record<string, unknown> = {}) {
	return {
		hasProvider: true,
		errorHint: null,
		mcpFailed: [],
		close: async () => {},
		reasoningEffortLevels: ['low'],
		reasoningEffortDefault: 'low',
		presenter: {
			presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
			presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
		},
		...extra,
	}
}

function runtime(createSession = vi.fn(async () => fakeSession())) {
	const owner = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({
				preferences: {
					version: 3,
					providers: [{ id: 'zen', model: 'm' }],
					subagents: { active: [] },
				},
				detected: [{ entry: { id: 'zen', label: 'Zen', defaultModel: 'm' }, apiKey: 'synthetic' }],
				needsRepickReason: null,
			}),
			createSession,
			decideTrust: decideHeadlessTrust,
			resolveProjectContext: (ctx: unknown) => ctx,
			resolveSession: async (sessionId: string) => ({ sessionId: asSessionId(sessionId) }),
			openSessions: (dir: string) => openSessions(dir),
		} as unknown as AcpRuntimeDependencies,
	)
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	return { owner, host, createSession }
}

/** One edit as the tool wrapper makes it: snapshot, change, settle. */
async function edit(store: FileCheckpointStore, turnId: string, path: string, content: string) {
	await store.snapshot(path, { turnId, tool: 'edit', toolUseId: `call-${turnId}` })
	writeFileSync(path, content)
	await store.settle(path, { ok: true, first: true, turnId })
}

/** A conversation whose reply edited a.txt from v0 to v1, left on disk by a process that is gone. */
async function editedConversation() {
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	const file = join(cwd, 'a.txt')
	writeFileSync(file, 'v0')
	const turnId = generateTurnId()
	const store = new FileCheckpointStore(state.paths.fileHistory({ sessionId }), cwd)
	store.beginTurn('change a', turnId)
	await edit(store, turnId, file, 'v1')
	await store.release()
	return { state, sessionId, file, turnId }
}

describe('namzu/turns/undo-*', () => {
	it('reads status of a reopened conversation without building a runtime session', async () => {
		const { owner, host, createSession } = runtime()
		const f = await editedConversation()
		try {
			const other = generateTurnId()
			expect(
				await host['namzu/turns/undo-status']!({
					sessionId: f.sessionId,
					turnIds: [f.turnId, other],
				}),
			).toEqual({
				turns: [
					{
						turnId: f.turnId,
						status: 'applied',
						files: 1,
						added: 0,
						removed: 0,
						uncoveredShell: false,
						skipped: [],
					},
					{
						turnId: other,
						status: 'none',
						files: 0,
						added: 0,
						removed: 0,
						uncoveredShell: false,
						skipped: [],
					},
				],
			})
			const all = await host['namzu/turns/undo-status']!({ sessionId: f.sessionId })
			expect(all.turns.map((t: { turnId: string }) => t.turnId)).toEqual([f.turnId])
			expect(createSession).not.toHaveBeenCalled()
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('previews from the disk without writing anything', async () => {
		const { owner, host, createSession } = runtime()
		const f = await editedConversation()
		try {
			const preview = await host['namzu/turns/undo-preview']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
			})
			expect(preview).toMatchObject({
				turnId: f.turnId,
				planToken: expect.any(String),
				files: [{ path: f.file, rel: 'a.txt', action: 'restore' }],
				uncoveredShell: false,
				laterTurnsOnSameFiles: [],
			})
			expect(readFileSync(f.file, 'utf8')).toBe('v1')
			expect(createSession).not.toHaveBeenCalled()
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('undoes a reopened conversation cold, and status then reads undone', async () => {
		const { owner, host, createSession } = runtime()
		const f = await editedConversation()
		try {
			const { planToken } = await host['namzu/turns/undo-preview']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
			})
			const result = await host['namzu/turns/undo']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
				planToken,
			})
			expect(result).toMatchObject({
				turnId: f.turnId,
				status: 'undone',
				files: { [f.file]: 'restored' },
				copies: [],
			})
			expect(readFileSync(f.file, 'utf8')).toBe('v0')
			const status = await host['namzu/turns/undo-status']!({
				sessionId: f.sessionId,
				turnIds: [f.turnId],
			})
			expect(status.turns[0]).toMatchObject({ status: 'undone', files: 1 })
			expect(createSession).not.toHaveBeenCalled()
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('returns plan-changed with the new preview when the disk moved after the preview', async () => {
		const { owner, host } = runtime()
		const f = await editedConversation()
		try {
			const { planToken } = await host['namzu/turns/undo-preview']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
			})
			writeFileSync(f.file, 'the operator was here')
			const result = await host['namzu/turns/undo']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
				planToken,
			})
			expect(result.status).toBe('plan-changed')
			expect(result.replan?.planToken).not.toBe(planToken)
			expect(result.replan?.files).toMatchObject([{ action: 'conflict', reason: 'drifted' }])
			expect(readFileSync(f.file, 'utf8')).toBe('the operator was here')
			// The new token, with the explicit copy choice, is what applies.
			const applied = await host['namzu/turns/undo']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
				planToken: result.replan?.planToken,
				resolutions: { [f.file]: 'keep_copy' },
			})
			expect(applied.files[f.file]).toBe('restored')
			expect(applied.copies).toHaveLength(1)
			expect(readFileSync(f.file, 'utf8')).toBe('v0')
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('skips a conflict by default and keeps the operator file', async () => {
		const { owner, host } = runtime()
		const f = await editedConversation()
		try {
			writeFileSync(f.file, 'mine')
			const preview = await host['namzu/turns/undo-preview']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
			})
			const result = await host['namzu/turns/undo']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
				planToken: preview.planToken,
			})
			expect(result.files[f.file]).toBe('skipped')
			// Nothing went back, so the reply still reads as applied.
			expect(result.status).toBe('applied')
			expect(readFileSync(f.file, 'utf8')).toBe('mine')
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('refuses a conversation this project does not own', async () => {
		const { owner, host } = runtime()
		const f = await editedConversation()
		try {
			const stranger = generateSessionId()
			for (const method of ['undo-status', 'undo-preview', 'undo'] as const)
				await expect(
					host[`namzu/turns/${method}`]!({
						sessionId: stranger,
						turnId: f.turnId,
						planToken: 'x',
					} as never),
				).rejects.toThrow()
			expect(readFileSync(f.file, 'utf8')).toBe('v1')
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('rejects unknown params, a bad turn id and malformed choices before touching anything', async () => {
		const { owner, host } = runtime()
		const f = await editedConversation()
		const base = { sessionId: f.sessionId, turnId: f.turnId, planToken: 'x' }
		try {
			await expect(host['namzu/turns/undo']!({ ...base, force: true } as never)).rejects.toThrow(
				'accepts only',
			)
			await expect(host['namzu/turns/undo-preview']!({ ...base } as never)).rejects.toThrow(
				'accepts only',
			)
			await expect(
				host['namzu/turns/undo-status']!({ sessionId: f.sessionId, extra: 1 } as never),
			).rejects.toThrow('accepts only')
			await expect(host['namzu/turns/undo']!({ ...base, turnId: 'not-a-turn' })).rejects.toThrow(
				'Invalid turn',
			)
			await expect(
				host['namzu/turns/undo-status']!({ sessionId: f.sessionId, turnIds: ['nope'] }),
			).rejects.toThrow('Invalid turnIds')
			await expect(
				host['namzu/turns/undo']!({ ...base, resolutions: { [f.file]: 'overwrite' } }),
			).rejects.toThrow('Invalid resolutions')
			await expect(host['namzu/turns/undo']!({ ...base, resolutions: [] })).rejects.toThrow(
				'Invalid resolutions',
			)
			await expect(host['namzu/turns/undo']!({ ...base, alsoUndoLater: 'yes' })).rejects.toThrow(
				'Invalid alsoUndoLater',
			)
			expect(readFileSync(f.file, 'utf8')).toBe('v1')
		} finally {
			closeSessions(f.state)
			await owner.close()
		}
	})

	it('refuses an untrusted folder', async () => {
		const owner = createCliAcpRuntime(
			{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
			{
				decideTrust: decideHeadlessTrust,
				resolveSession: async (sessionId: string) => ({ sessionId: asSessionId(sessionId) }),
			} as unknown as AcpRuntimeDependencies,
		)
		const host = createDesktopHostExtensions(owner, cwd)
		await expect(
			host['namzu/turns/undo-status']!({ sessionId: generateSessionId() }),
		).rejects.toThrow('Trust this folder')
		await owner.close()
	})
})

describe('FileCheckpointStore.undoStatus', () => {
	it('counts created and deleted files and reads an aged-out reply as expired', async () => {
		const history = join(root, 'history')
		const made = join(cwd, 'made.txt')
		const gone = join(cwd, 'gone.txt')
		writeFileSync(gone, 'bye')
		let clock = 1_000
		const store = new FileCheckpointStore(history, cwd, { now: () => clock, maxAgeMs: 10_000 })
		const turnId = generateTurnId()
		store.beginTurn('make and remove', turnId)
		await store.snapshot(made, { turnId, tool: 'write', toolUseId: 'w' })
		writeFileSync(made, 'new')
		await store.settle(made, { ok: true, first: true, turnId })
		await store.snapshot(gone, { turnId, tool: 'bash', toolUseId: 'r' })
		rmSync(gone)
		await store.settle(gone, { ok: true, first: true, turnId })
		expect(await store.undoStatus([turnId])).toMatchObject([
			{ turnId, status: 'applied', files: 2, added: 1, removed: 1 },
		])
		await store.release()

		clock += 20_000
		const later = new FileCheckpointStore(history, cwd, { now: () => clock, maxAgeMs: 10_000 })
		expect(await later.undoStatus([turnId])).toMatchObject([{ turnId, status: 'expired' }])
		await later.release()
	})
})

describe('undo beside a live conversation', () => {
	/** A conversation with a live runtime record whose store is the one that holds the edit. */
	async function live(jobs: () => { id: string; status: string }[] = () => []) {
		const state = await openSessions(cwd)
		const sessionId = await startConversation(state)
		const file = join(cwd, 'a.txt')
		writeFileSync(file, 'v0')
		const store = new FileCheckpointStore(state.paths.fileHistory({ sessionId }), cwd)
		const turnId = generateTurnId()
		store.beginTurn('change a', turnId)
		await edit(store, turnId, file, 'v1')
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let held = true
		let started!: () => void
		const sent = new Promise<void>((resolve) => {
			started = resolve
		})
		const sends: Array<{ systemNote?: string }> = []
		const markFilesChanged = vi.fn(async () => {})
		const createSession = vi.fn(async () =>
			fakeSession({
				checkpoints: store,
				markFilesChanged,
				jobs,
				send: (_messages: unknown, options: { systemNote?: string }) =>
					(async function* () {
						sends.push({ systemNote: options.systemNote })
						started()
						if (held) await gate
						yield { kind: 'done', stopReason: 'end_turn' } as const
					})(),
			}),
		)
		const { owner, host } = runtime(createSession)
		const prompt = () =>
			owner.gateway.prompt({
				sessionId,
				cwd,
				prompt: 'go',
				signal: new AbortController().signal,
				onEvent: () => {},
				ask: async () => ({ kind: 'reject' as const }),
				history: [],
				filesystem: undefined,
			} as never)
		return {
			state,
			sessionId,
			file,
			turnId,
			owner,
			host,
			prompt,
			sends,
			sent,
			markFilesChanged,
			finish: () => {
				held = false
				release()
			},
			store,
		}
	}

	it('refuses while a reply is running, then undoes it once it settles', async () => {
		const f = await live()
		try {
			const running = f.prompt()
			// The turn announces itself; nothing waits on the clock.
			await f.sent
			const { planToken } = await f.host['namzu/turns/undo-preview']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
			})
			await expect(
				f.host['namzu/turns/undo']!({ sessionId: f.sessionId, turnId: f.turnId, planToken }),
			).rejects.toThrow('Wait for the current reply')
			expect(readFileSync(f.file, 'utf8')).toBe('v1')
			f.finish()
			await running

			const result = await f.host['namzu/turns/undo']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
				planToken,
			})
			expect(result.status).toBe('undone')
			expect(readFileSync(f.file, 'utf8')).toBe('v0')
			// The model's ledger is told, and its next turn is told in words.
			expect(f.markFilesChanged).toHaveBeenCalledWith([f.file])
			await f.prompt()
			expect(f.sends[1]?.systemNote).toContain('a.txt')
			expect(f.sends[1]?.systemNote).toContain('Read a file again')
			// Said once.
			await f.prompt()
			expect(f.sends[2]?.systemNote).toBeUndefined()
		} finally {
			f.finish()
			closeSessions(f.state)
			await f.owner.close()
		}
	})

	it('tells the model about every undo made before its next turn', async () => {
		const f = await live()
		try {
			f.finish()
			await f.prompt()
			const second = join(cwd, 'b.txt')
			writeFileSync(second, 'w0')
			const turn2 = generateTurnId()
			f.store.beginTurn('change b', turn2)
			await edit(f.store, turn2, second, 'w1')
			for (const turnId of [f.turnId, turn2]) {
				const { planToken } = await f.host['namzu/turns/undo-preview']!({
					sessionId: f.sessionId,
					turnId,
				})
				await f.host['namzu/turns/undo']!({ sessionId: f.sessionId, turnId, planToken })
			}
			await f.prompt()
			const note = f.sends.at(-1)?.systemNote ?? ''
			expect(note).toContain('a.txt')
			expect(note).toContain('b.txt')
		} finally {
			f.finish()
			closeSessions(f.state)
			await f.owner.close()
		}
	})

	it('refuses while a background command is running', async () => {
		const f = await live(() => [{ id: 'job', status: 'running' }])
		try {
			f.finish()
			await f.prompt()
			const { planToken } = await f.host['namzu/turns/undo-preview']!({
				sessionId: f.sessionId,
				turnId: f.turnId,
			})
			await expect(
				f.host['namzu/turns/undo']!({ sessionId: f.sessionId, turnId: f.turnId, planToken }),
			).rejects.toThrow('background command')
			expect(readFileSync(f.file, 'utf8')).toBe('v1')
			expect(f.markFilesChanged).not.toHaveBeenCalled()
		} finally {
			closeSessions(f.state)
			await f.owner.close()
		}
	})
})
