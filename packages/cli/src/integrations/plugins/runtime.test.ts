import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	SESSION_END_HOOK_TIMEOUT_MS,
	createCliPluginRuntime,
	hookTimeoutLine,
	sessionEndHookBudgetMs,
} from './runtime.js'

const discovery = vi.hoisted(() => ({
	options: undefined as unknown,
	calls: 0,
}))

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		discoverAllPluginDirs: vi.fn(async (_cwd, options) => {
			discovery.calls++
			discovery.options = options
			return { project: [], user: [] }
		}),
	}
})

beforeEach(() => {
	discovery.calls = 0
	discovery.options = undefined
})

describe('CLI plugin discovery authority', () => {
	it('passes the exact admitted scopes and discovery switch to the SDK scanner', async () => {
		const runtime = await createCliPluginRuntime(
			{ enabled: true, autoDiscovery: false, allowedScopes: ['user'] },
			'/trusted/project',
		)

		expect(discovery.calls).toBe(1)
		expect(discovery.options).toEqual(
			expect.objectContaining({
				enabled: true,
				autoDiscovery: false,
				allowedScopes: ['user'],
			}),
		)
		await runtime?.close()
	})
})

describe('the session_end deadline', () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('is five seconds', () => {
		expect(SESSION_END_HOOK_TIMEOUT_MS).toBe(5000)
	})

	it('says which hook ran out of time in one plain line', () => {
		expect(hookTimeoutLine({ event: 'session_end', hook: 'sleep 60', timeoutMs: 5000 })).toBe(
			'The session_end hook `sleep 60` did not finish within 5 seconds and was ended.',
		)
	})

	async function close(entry: { timeoutMs?: number }, deadlineMs: number): Promise<string[]> {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const written: string[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk))
			return true
		})
		const runtime = await createCliPluginRuntime(undefined, process.cwd(), {
			session_end: [{ command: 'sleep 60', ...entry }],
		})
		if (!runtime) throw new Error('no runtime')
		const pending = runtime.manager.executeHooks('session_end', {
			sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
			endReason: 'exit',
		})
		await vi.advanceTimersByTimeAsync(1)
		// To the deadline the entry should have been armed with and no further:
		// the hook ends there, or `pending` never settles and the test's own
		// timeout reports the hang.
		await vi.advanceTimersByTimeAsync(deadlineMs)
		await pending
		await runtime.close()
		return written
	}

	it('ends a hook with no timeoutMs at five seconds and says so', async () => {
		expect(await close({}, SESSION_END_HOOK_TIMEOUT_MS)).toEqual([
			'The session_end hook `sleep 60` did not finish within 5 seconds and was ended.\n',
		])
	})

	it('arms an entry with its own timeoutMs as written', async () => {
		expect(await close({ timeoutMs: 20000 }, 20000)).toEqual([
			'The session_end hook `sleep 60` did not finish within 20 seconds and was ended.\n',
		])
	})
})

describe('the session_end budget a host waits for', () => {
	it('is zero with no session_end hook', () => {
		expect(sessionEndHookBudgetMs(undefined)).toBe(0)
		expect(sessionEndHookBudgetMs({ turn_end: [{ command: 'true' }] })).toBe(0)
	})

	it('is five seconds for an entry that names no timeoutMs', () => {
		expect(sessionEndHookBudgetMs({ session_end: [{ command: 'true' }] })).toBe(5000)
	})

	it('is the largest entry, capped at ten minutes, and skips an async one', () => {
		expect(
			sessionEndHookBudgetMs({
				session_end: [
					{ command: 'a', timeoutMs: 20000 },
					{ command: 'b' },
					{ command: 'c', timeoutMs: 9_000_000 },
					{ command: 'd', timeoutMs: 40000, async: true },
				],
			}),
		).toBe(600000)
		expect(
			sessionEndHookBudgetMs({
				session_end: [{ command: 'd', timeoutMs: 40000, async: true }, { command: 'a' }],
			}),
		).toBe(5000)
	})

	it('is on the runtime a session closes through', async () => {
		const runtime = await createCliPluginRuntime(undefined, process.cwd(), {
			session_end: [{ command: 'true', timeoutMs: 20000 }],
		})
		expect(runtime?.sessionEndBudgetMs).toBe(20000)
		await runtime?.close()
	})
})
