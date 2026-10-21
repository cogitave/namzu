import { describe, expect, it } from 'vitest'

import type { Sandbox, SandboxEnvironment } from '../../../types/sandbox/index.js'
import {
	WebSocketRefusedError,
	hostMatchesPolicy,
	pinnedLookup,
	vetWebSocketTarget,
	webSocketClosedNotice,
	webSocketProtocolsProblem,
	webSocketSandboxRefusal,
	webSocketUrlProblem,
} from '../websocket-source.js'

/**
 * Where a model-chosen WebSocket may connect from, checked before anything is
 * sent: the address, the pinning that keeps the checked address the one used,
 * and the sandbox's own network rule.
 */

/** A resolver that answers from a table and fails on any name it was not given. */
function resolver(table: Record<string, readonly string[] | Error>) {
	return async (hostname: string): Promise<readonly string[]> => {
		const answer = table[hostname]
		if (answer === undefined) throw new Error(`ENOTFOUND ${hostname}`)
		if (answer instanceof Error) throw answer
		return answer
	}
}

describe('a WebSocket URL a model chose is refused unless it is a plain public address', () => {
	for (const [name, url] of [
		['loopback', 'ws://127.0.0.1:8080/feed'],
		['IPv6 loopback', 'ws://[::1]/feed'],
		['link-local', 'ws://169.254.1.1/'],
		['the cloud metadata address', 'wss://169.254.169.254/latest/meta-data'],
		['a private range', 'ws://10.0.0.5/'],
		['shared address space (CGNAT)', 'ws://100.100.100.200/'],
		['the benchmarking range', 'ws://198.18.0.1/'],
		['NAT64 to loopback', 'ws://[64:ff9b::7f00:1]/'],
		['6to4 of the metadata address', 'ws://[2002:a9fe:a9fe::]/'],
		['IPv4-compatible loopback', 'ws://[::7f00:1]/'],
		['a mapped IPv4 loopback', 'ws://[::ffff:127.0.0.1]/'],
		// The URL parser turns these into 127.0.0.1, which is why they are refused.
		['loopback written as one integer', 'ws://2130706433/'],
		['loopback written in hex', 'ws://0x7f.0.0.1/'],
	] as const) {
		it(`refuses ${name}`, async () => {
			await expect(vetWebSocketTarget(url, { resolve: resolver({}) })).rejects.toThrow(
				WebSocketRefusedError,
			)
		})
	}

	it('refuses a name that resolves to a private address, and says which', async () => {
		await expect(
			vetWebSocketTarget('wss://internal.example/stream', {
				resolve: resolver({ 'internal.example': ['10.1.2.3'] }),
			}),
		).rejects.toThrow(/resolves to 10\.1\.2\.3, inside this host's own network/)
	})

	it('refuses a name with ANY private address among its answers', async () => {
		await expect(
			vetWebSocketTarget('wss://mixed.example/stream', {
				resolve: resolver({ 'mixed.example': ['93.184.216.34', '127.0.0.1'] }),
			}),
		).rejects.toThrow(WebSocketRefusedError)
	})

	it('refuses a name that cannot be resolved, rather than passing it on to be resolved again', async () => {
		await expect(
			vetWebSocketTarget('wss://nowhere.example/stream', { resolve: resolver({}) }),
		).rejects.toThrow(/could not be resolved/)
	})

	it('refuses a name that resolves to nothing', async () => {
		await expect(
			vetWebSocketTarget('wss://empty.example/stream', {
				resolve: resolver({ 'empty.example': [] }),
			}),
		).rejects.toThrow(/resolves to no addresses/)
	})

	it('accepts a public name and returns exactly the addresses it checked', async () => {
		const vetted = await vetWebSocketTarget('wss://events.example/stream', {
			resolve: resolver({ 'events.example': ['93.184.216.34', '2606:2800:220:1::1'] }),
		})
		expect(vetted).toEqual([
			{ address: '93.184.216.34', family: 4 },
			{ address: '2606:2800:220:1::1', family: 6 },
		])
	})

	it('lets a test reach this machine only when the code that built the tool says so', async () => {
		const vetted = await vetWebSocketTarget('ws://127.0.0.1:9/feed', {
			allowPrivateAddresses: true,
		})
		expect(vetted).toEqual([{ address: '127.0.0.1', family: 4 }])
	})
})

describe('the connection uses the addresses that were checked and asks nobody else', () => {
	const vetted = [
		{ address: '93.184.216.34', family: 4 as const },
		{ address: '2606:2800:220:1::1', family: 6 as const },
	]
	type Answer = string | { address: string; family: number }[]
	const ask = (options: { all?: boolean; family?: number } | undefined) =>
		new Promise<{ error: Error | null; address: Answer; family?: number }>((resolve) =>
			pinnedLookup(vetted)('events.example', options, (error, address, family) =>
				resolve({ error, address, ...(family !== undefined ? { family } : {}) }),
			),
		)

	it('answers a lookup for the name with the vetted address, whatever DNS would say', async () => {
		expect(await ask(undefined)).toEqual({ error: null, address: '93.184.216.34', family: 4 })
	})

	it('answers an all-addresses lookup with all of them and no more', async () => {
		expect(await ask({ all: true })).toEqual({
			error: null,
			address: [
				{ address: '93.184.216.34', family: 4 },
				{ address: '2606:2800:220:1::1', family: 6 },
			],
		})
	})

	it('honours a requested family, and refuses one it holds nothing for instead of falling back to DNS', async () => {
		expect(await ask({ family: 6 })).toEqual({
			error: null,
			address: '2606:2800:220:1::1',
			family: 6,
		})
		const only4 = await new Promise<Error | null>((resolve) =>
			pinnedLookup([{ address: '93.184.216.34', family: 4 }])('x', { family: 6 }, (error) =>
				resolve(error),
			),
		)
		expect(only4).toMatchObject({ code: 'ENOTFOUND' })
	})
})

describe('the input a WebSocket source accepts', () => {
	it('accepts ws and wss URLs and keeps the query string', () => {
		expect(webSocketUrlProblem('ws://example.com/a')).toBeUndefined()
		expect(webSocketUrlProblem('wss://example.com:8443/a?room=1&x=2')).toBeUndefined()
	})

	for (const [name, url] of [
		['another scheme', 'https://example.com/a'],
		['a user name and password', 'wss://user:pass@example.com/a'],
		['a user name alone', 'wss://user@example.com/a'],
		['a space', 'wss://example.com/a b'],
		['a newline', 'wss://example.com/a\nb'],
		['a control character', 'wss://example.com/a\u0007'],
		['a non-ASCII character', 'wss://exämple.com/a'],
		['a fragment', 'wss://example.com/a#top'],
		['no URL at all', 'not a url'],
		['more than 2048 characters', `wss://example.com/${'a'.repeat(2048)}`],
	] as const) {
		it(`refuses ${name}`, () => {
			expect(webSocketUrlProblem(url)).toEqual(expect.any(String))
		})
	}

	it('accepts subprotocol tokens and refuses anything else', () => {
		expect(webSocketProtocolsProblem(['graphql-ws', 'v1.json'])).toBeUndefined()
		expect(webSocketProtocolsProblem([''])).toEqual(expect.any(String))
		expect(webSocketProtocolsProblem(['a b'])).toEqual(expect.any(String))
		expect(webSocketProtocolsProblem(['a,b'])).toEqual(expect.any(String))
		expect(webSocketProtocolsProblem(['a\r\nb'])).toEqual(expect.any(String))
		expect(webSocketProtocolsProblem(['same', 'same'])).toBe('Subprotocol names must be unique.')
		expect(webSocketProtocolsProblem(Array.from({ length: 17 }, (_, i) => `p${i}`))).toBe(
			'At most 16 subprotocols.',
		)
	})
})

function sandbox(
	environment: SandboxEnvironment,
	networkPolicy?: { allowedHosts: string[] },
): Sandbox {
	return { environment, ...(networkPolicy ? { networkPolicy } : {}) } as unknown as Sandbox
}

describe('a sandbox that blocks the network does not let the host connect for it', () => {
	it('allows a turn with no sandbox', () => {
		expect(webSocketSandboxRefusal(undefined, 'events.example')).toBeUndefined()
	})

	it('allows a sandbox that does not isolate the network, leaving the address check and review', () => {
		expect(webSocketSandboxRefusal(sandbox('basic'), 'events.example')).toBeUndefined()
	})

	it('refuses a sandbox that isolates the network, in plain words, when the host is not allowed', () => {
		const refusal = webSocketSandboxRefusal(sandbox('linux-bwrap'), 'events.example')
		expect(refusal).toMatch(/connects from the host, outside this turn's sandbox/)
		expect(refusal).toContain('"events.example"')
		expect(
			webSocketSandboxRefusal(sandbox('linux-bwrap', { allowedHosts: [] }), 'events.example'),
		).toBe(refusal)
	})

	it('allows the host the live policy names, exactly or by domain, and no other', () => {
		const live = sandbox('linux-bwrap', { allowedHosts: ['events.example', '.corp.test'] })
		expect(webSocketSandboxRefusal(live, 'events.example')).toBeUndefined()
		expect(webSocketSandboxRefusal(live, 'a.b.corp.test')).toBeUndefined()
		expect(webSocketSandboxRefusal(live, 'corp.test')).toBeUndefined()
		expect(webSocketSandboxRefusal(live, 'other.example')).toEqual(expect.any(String))
		expect(webSocketSandboxRefusal(live, 'events.example.attacker.net')).toEqual(expect.any(String))
	})

	it('matches names the way the policy defines them: no substrings', () => {
		expect(hostMatchesPolicy('example.com.attacker.net', ['example.com'])).toBe(false)
		expect(hostMatchesPolicy('notexample.com', ['.example.com'])).toBe(false)
		expect(hostMatchesPolicy('Example.COM.', ['example.com'])).toBe(true)
	})
})

describe('the notices the connection sends', () => {
	it('puts a server-written reason on one short line', () => {
		expect(webSocketClosedNotice(1001, 'going\naway\r\n[forged]')).toBe(
			'[WebSocket closed: 1001 going away [forged]]',
		)
		expect(webSocketClosedNotice(1006, '')).toBe('[WebSocket closed: 1006]')
		expect(webSocketClosedNotice(4000, 'x'.repeat(500)).length).toBeLessThan(160)
	})
})
