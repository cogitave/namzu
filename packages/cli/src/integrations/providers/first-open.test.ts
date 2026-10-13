import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	automaticChoice,
	describeAutomaticChoice,
	discoverProviders,
	findDetected,
} from './discover.js'
import { claudeCredentialsPath } from './harness-credentials.js'

// A fresh temp home on every call: nothing here reads or writes the real one.
const home = () => mkdtempSync(join(tmpdir(), 'namzu-first-open-'))
const HERMETIC = { skipKeychain: true, env: {} as NodeJS.ProcessEnv } as const

/** Answers only the URLs in `up`, like a computer running those local servers. */
function serversUp(...up: string[]) {
	return vi.fn<typeof fetch>(async (input) => {
		const url = String(input)
		if (up.some((prefix) => url.startsWith(prefix))) return new Response('{}', { status: 200 })
		throw new Error('ECONNREFUSED')
	})
}

function writeClaudeSignIn(root: string) {
	const path = claudeCredentialsPath(root)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(
		path,
		JSON.stringify({
			claudeAiOauth: {
				accessToken: 'sk-ant-oat01-synthetic',
				refreshToken: 'synthetic-refresh',
				expiresAt: Date.now() + 3_600_000,
			},
		}),
	)
}

afterEach(() => {
	vi.useRealTimers()
})

describe('what a first open starts with when nothing is saved', () => {
	it('is the free Zen models when nothing else is on the computer', async () => {
		const list = await discoverProviders({ ...HERMETIC, home: home(), fetch: serversUp() })
		const choice = automaticChoice(list)
		expect(choice?.provider.entry.id).toBe('zen')
		expect(choice?.kind).toBe('free')
		expect(list[0]?.entry.id).toBe('zen')
	})

	it('prefers a local server to the free models', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			home: home(),
			fetch: serversUp('http://localhost:11434'),
		})
		expect(list.map((item) => item.entry.id).slice(0, 2)).toEqual(['ollama', 'zen'])
		expect(automaticChoice(list)).toMatchObject({ kind: 'local' })
		expect(automaticChoice(list)?.provider.entry.id).toBe('ollama')
	})

	it('finds LM Studio too', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			home: home(),
			fetch: serversUp('http://localhost:1234'),
		})
		expect(automaticChoice(list)?.provider.entry.id).toBe('lmstudio')
	})

	it('prefers an API key in the environment to a local server', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			env: { OPENAI_API_KEY: 'sk-synthetic' },
			home: home(),
			fetch: serversUp('http://localhost:11434'),
		})
		expect(automaticChoice(list)).toMatchObject({ kind: 'key' })
		expect(automaticChoice(list)?.provider.entry.id).toBe('openai')
		expect(list.map((item) => item.entry.id)).toEqual(['openai', 'ollama', 'zen'])
	})

	it('prefers a sign-in already on the computer to a key and a local server', async () => {
		const root = home()
		writeClaudeSignIn(root)
		const list = await discoverProviders({
			...HERMETIC,
			env: { OPENAI_API_KEY: 'sk-synthetic' },
			home: root,
			fetch: serversUp('http://localhost:11434'),
		})
		expect(automaticChoice(list)).toMatchObject({ kind: 'sign-in' })
		expect(automaticChoice(list)?.provider.entry.id).toBe('anthropic')
		expect(list[0]?.entry.id).toBe('anthropic')
		expect(list.at(-1)?.entry.id).toBe('zen')
	})

	it('is nothing only when nothing at all is available', () => {
		expect(automaticChoice([])).toBeNull()
	})
})

describe('local server probes stay quick', () => {
	it('asks every server at once with a deadline of 300 ms or less', async () => {
		vi.useFakeTimers()
		const signals: AbortSignal[] = []
		const fetchMock = vi.fn<typeof fetch>((_input, init) => {
			const signal = init?.signal as AbortSignal
			signals.push(signal)
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')))
			})
		})
		const pending = discoverProviders({ ...HERMETIC, home: home(), fetch: fetchMock })
		// Both servers were asked before any deadline passed.
		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(299)
		expect(signals.some((signal) => signal.aborted)).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(signals.every((signal) => signal.aborted)).toBe(true)
		const list = await pending
		expect(findDetected(list, 'ollama')).toBeNull()
		expect(findDetected(list, 'lmstudio')).toBeNull()
		expect(list[0]?.entry.id).toBe('zen')
	})

	it('asks only the two local server addresses, whatever else was found', async () => {
		const fetchMock = serversUp()
		await discoverProviders({
			...HERMETIC,
			env: { OPENAI_API_KEY: 'sk-synthetic' },
			home: home(),
			fetch: fetchMock,
		})
		expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
			'http://localhost:11434/api/tags',
			'http://localhost:1234/v1/models',
		])
	})
})

describe('the sentence that says what was picked', () => {
	it('uses plain words, never an id or a variable name', async () => {
		const root = home()
		writeClaudeSignIn(root)
		const sign = automaticChoice(
			await discoverProviders({ ...HERMETIC, home: root, fetch: serversUp() }),
		)
		const key = automaticChoice(
			await discoverProviders({
				...HERMETIC,
				env: { OPENAI_API_KEY: 'sk-synthetic' },
				home: home(),
				fetch: serversUp(),
			}),
		)
		const local = automaticChoice(
			await discoverProviders({
				...HERMETIC,
				home: home(),
				fetch: serversUp('http://localhost:11434'),
			}),
		)
		const free = automaticChoice(
			await discoverProviders({ ...HERMETIC, home: home(), fetch: serversUp() }),
		)
		const words = [sign, key, local, free].map((choice) =>
			describeAutomaticChoice(choice as NonNullable<typeof choice>),
		)
		expect(words).toEqual([
			'Using your Claude sign-in, found on this computer.',
			'Using your OpenAI key, found on this computer.',
			'Using Ollama running on this computer.',
			"Using Zen's free models (experimental).",
		])
		for (const sentence of words) {
			expect(sentence).not.toMatch(/OPENAI_API_KEY|space-bunny|11434|localhost|sk-/)
		}
	})
})
