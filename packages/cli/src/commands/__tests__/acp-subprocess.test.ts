import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The real binary, over a real pipe.
 *
 * This test exists because of `MCPServer`: a complete protocol server that
 * this SDK exports and that nothing in the tree ever constructed. Shipping
 * a wire surface with no driver reads as a supported feature and is not
 * one, so the driver is asserted the only way that cannot be faked — by
 * spawning it.
 *
 * Removing `acpCommand` from `cli.ts`'s registration fails this.
 */

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'bin.js')

interface Frame {
	id?: number
	method?: string
	result?: unknown
	error?: { code: number; message: string }
	params?: unknown
}

/**
 * Drive the child through a scripted exchange and return everything it
 * wrote, split into what parsed as protocol and what did not.
 */
async function converse(
	frames: readonly Record<string, unknown>[],
	options: { readonly env?: Record<string, string>; readonly closeStdin?: boolean } = {},
): Promise<{ protocol: Frame[]; garbage: string[]; stderr: string }> {
	const child = spawn(process.execPath, [CLI_BIN, 'acp'], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...options.env },
	})

	let out = ''
	let err = ''
	child.stdout.setEncoding('utf8')
	child.stderr.setEncoding('utf8')
	child.stdout.on('data', (c: string) => {
		out += c
	})
	child.stderr.on('data', (c: string) => {
		err += c
	})

	for (const frame of frames) {
		child.stdin.write(`${JSON.stringify(frame)}\n`)
		// One frame at a time, so a response that depends on the previous call
		// (a session id) has arrived before the next is sent.
		await new Promise((resolve) => setTimeout(resolve, 120))
	}

	child.stdin.end()
	await new Promise<void>((resolve) => {
		child.on('exit', () => resolve())
		setTimeout(() => {
			child.kill()
			resolve()
		}, 8_000)
	})

	const protocol: Frame[] = []
	const garbage: string[] = []
	for (const line of out.split('\n')) {
		if (line.trim() === '') continue
		try {
			protocol.push(JSON.parse(line) as Frame)
		} catch {
			garbage.push(line)
		}
	}
	return { protocol, garbage, stderr: err }
}

const built = existsSync(CLI_BIN)

describe.skipIf(!built)('namzu acp, as a client actually spawns it', () => {
	it('completes initialize → session/new → session/prompt over stdio', async () => {
		const { protocol, stderr } = await converse([
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: 1, capabilities: ['permission'] },
			},
			{ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
		])

		const init = protocol.find((f) => f.id === 1)
		expect(init, `no initialize response; stderr was:\n${stderr}`).toBeDefined()
		expect((init?.result as { protocolVersion: number }).protocolVersion).toBe(1)

		const created = protocol.find((f) => f.id === 2)
		expect(created?.result).toBeDefined()
		expect(typeof (created?.result as { sessionId: string }).sessionId).toBe('string')
	}, 30_000)

	it('answers an unknown method with -32601 and keeps serving', async () => {
		const { protocol } = await converse([
			{ jsonrpc: '2.0', id: 1, method: 'session/teleport' },
			{ jsonrpc: '2.0', id: 2, method: 'initialize', params: { capabilities: ['permission'] } },
		])

		expect(protocol.find((f) => f.id === 1)?.error?.code).toBe(-32601)
		// Still serving. A bridge that closed on an unrecognised method would
		// make a client's feature probe fatal.
		expect(protocol.find((f) => f.id === 2)?.result).toBeDefined()
	}, 30_000)

	it('survives a malformed frame and answers the next real one', async () => {
		const child = spawn(process.execPath, [CLI_BIN, 'acp'], { stdio: ['pipe', 'pipe', 'pipe'] })
		let out = ''
		child.stdout.setEncoding('utf8')
		child.stdout.on('data', (c: string) => {
			out += c
		})

		child.stdin.write('{ this is not json\n')
		await new Promise((resolve) => setTimeout(resolve, 120))
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { capabilities: ['permission'] } })}\n`,
		)
		await new Promise((resolve) => setTimeout(resolve, 400))
		child.stdin.end()
		await new Promise<void>((resolve) => {
			child.on('exit', () => resolve())
			setTimeout(() => {
				child.kill()
				resolve()
			}, 8_000)
		})

		const frames = out
			.split('\n')
			.filter((l) => l.trim() !== '')
			.map((l) => JSON.parse(l) as Frame)
		expect(frames.find((f) => f.id === 5)?.result).toBeDefined()
	}, 30_000)

	it('REFUSES session/new from a client that declared no permission capability', async () => {
		const { protocol } = await converse([
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: [] } },
			{ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
		])

		const refusal = protocol.find((f) => f.id === 2)
		// Not a session that auto-approves everything. That is not a degraded
		// version of asking a human — it is the opposite of it.
		expect(refusal?.result).toBeUndefined()
		expect(refusal?.error?.message).toContain('permission')
	}, 30_000)

	it('writes nothing but protocol to stdout, even at info level', async () => {
		const { protocol, garbage, stderr } = await converse(
			[
				{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: ['permission'] } },
				{ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} },
			],
			{ env: { NAMZU_LOG_LEVEL: 'info' } },
		)

		// The failure `server-stdio.ts`'s own header warns about: one stray
		// `console.log` anywhere in the process corrupts the stream, and the
		// symptom at the far end is "malformed JSON" with nothing naming the
		// culprit.
		expect(garbage).toEqual([])
		expect(protocol.length).toBeGreaterThan(0)
		// And the logging really did happen — otherwise this test would pass
		// against a process that simply printed nothing anywhere.
		expect(stderr.length).toBeGreaterThan(0)
	}, 30_000)
})
