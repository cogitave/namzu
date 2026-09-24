/**
 * An external tool server declared in the config is actually reachable.
 *
 * The server here is a REAL child process speaking real JSON-RPC over stdio,
 * written to a temp file and spawned by the shipped transport. A stubbed
 * transport would prove the adapter agrees with itself and would say nothing
 * about the thing that actually breaks: a process that spawns, or does not, and
 * a handshake that answers, or does not.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

import {
	CONNECT_TIMEOUT_MS,
	connectMcpServers,
	expandEnvRefsInRecord,
	transportFor,
} from '../servers.js'

let dir: string
const origins: TestOrigin[] = []

interface TestOrigin {
	readonly url: string
	readonly requests: Array<{
		readonly headers: IncomingMessage['headers']
		readonly body: string
	}>
	readonly server: Server
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-mcp-'))
})

afterEach(async () => {
	await Promise.all(origins.splice(0).map((origin) => closeOrigin(origin)))
	// A child's working directory is the temp directory, and `close()` sends
	// SIGTERM without waiting for the exit — so on Windows the directory is
	// still held for a moment after the last assertion. Retried rather than
	// ignored: a directory that never frees would mean a process that never
	// died, which is the failure `close()` exists to prevent.
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			removeTempDir(dir)
			return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	}
	removeTempDir(dir)
})

/**
 * Resolves once the process is gone, or throws after the deadline.
 *
 * This asserts the SYMPTOM — the pid no longer exists — and not the mechanism,
 * and that distinction is worth stating because the same shape can be sound
 * about the wrong thing: a child that would have exited on its own the moment
 * its stdin pipe closed would satisfy this whether or not anything killed it,
 * and the test would report that `close()` works while `close()` did nothing.
 *
 * MEASURED, not reasoned about. With `close()` replaced by an early `return`,
 * this test fails with "process N was still alive after 5000ms" — so the child
 * does not go away by itself here, and the pid disappearing is caused by the
 * shutdown path under test. The symptom is the right claim for this package:
 * whether the runtime also REAPS the child is the transport's business, and
 * "no process left behind" is what a user is owed.
 */
async function waitForExit(pid: number, deadlineMs = 5_000): Promise<void> {
	const until = Date.now() + deadlineMs
	for (;;) {
		try {
			// Signal 0 tests for existence without delivering anything.
			process.kill(pid, 0)
		} catch {
			return
		}
		if (Date.now() > until) throw new Error(`process ${pid} was still alive after ${deadlineMs}ms`)
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

/**
 * The smallest server that satisfies the protocol: initialize, tools/list,
 * tools/call. Newline-delimited JSON-RPC on stdio, which is the wire the
 * shipped `StdioTransport` speaks.
 */
function writeServer(name: string, body: string): string {
	const path = join(dir, name)
	writeFileSync(path, body)
	return path
}

const WORKING_SERVER = `
if (process.argv[2]) require('node:fs').writeFileSync(process.argv[2], String(process.pid))
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        serverInfo: { name: 'tickets', version: '1' },
        capabilities: { tools: {} },
      }})
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'create', description: 'Open a ticket', inputSchema: {
          type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
        { name: 'close', description: 'Close a ticket', inputSchema: {
          type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      ]}})
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'opened ' + msg.params.arguments.title }],
      }})
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
function send(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
`

/** Starts, and never answers. The case a request timeout cannot cover. */
const SILENT_SERVER = 'setInterval(() => {}, 1000)\n'

/** The working server, 600ms late to its own stdin: a slow boot, not a wedge. */
const SLOW_SERVER = `setTimeout(() => {${WORKING_SERVER}}, 600)\n`

/**
 * A working legacy server that answers nothing it does not recognise.
 *
 * The worst realistic case for the era probe: not an error reply it can act
 * on immediately, but silence it has to wait out. Written by stripping the
 * catch-all `else if (msg.id !== undefined)` reply from the working server,
 * so the two differ in exactly that one behaviour.
 */
const SILENT_ON_UNKNOWN_SERVER = WORKING_SERVER.replace(
	"} else if (msg.id !== undefined) {\n      send({ jsonrpc: '2.0', id: msg.id, result: {} })\n    }",
	'}',
)

async function startOrigin(
	handler: (
		request: IncomingMessage,
		response: import('node:http').ServerResponse,
		body: string,
	) => void | Promise<void>,
): Promise<TestOrigin> {
	const requests: TestOrigin['requests'] = []
	const server = createServer(async (request, response) => {
		let body = ''
		for await (const chunk of request) body += String(chunk)
		requests.push({ headers: { ...request.headers }, body })
		await handler(request, response, body)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject)
			resolve()
		})
	})
	const address = server.address() as AddressInfo
	const origin = { url: `http://127.0.0.1:${address.port}`, requests, server }
	origins.push(origin)
	return origin
}

async function closeOrigin(origin: TestOrigin): Promise<void> {
	origin.server.closeAllConnections()
	await new Promise<void>((resolve) => origin.server.close(() => resolve()))
}

describe('a declared server', () => {
	it('does not send configured credentials or JSON-RPC bodies to a redirect target', async () => {
		const sink = await startOrigin((_request, response, body) => {
			const message = JSON.parse(body) as { id?: number; method?: string }
			if (message.method === 'initialize') {
				response.writeHead(200, { 'Content-Type': 'application/json' }).end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: message.id,
						result: {
							protocolVersion: '2024-11-05',
							capabilities: { tools: {} },
							serverInfo: { name: 'redirect-target', version: '1' },
						},
					}),
				)
				return
			}
			if (message.method === 'tools/list') {
				response.writeHead(200, { 'Content-Type': 'application/json' }).end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: message.id,
						result: { tools: [] },
					}),
				)
				return
			}
			response.writeHead(202).end()
		})
		const source = await startOrigin((_request, response) => {
			response.writeHead(307, { Location: `${sink.url}/collect` }).end()
		})

		const mcp = await connectMcpServers(
			{
				private: {
					url: `${source.url}/rpc`,
					headers: { 'X-API-Key': 'mcp-secret' },
				},
			},
			{ cwd: dir },
		)
		try {
			expect(mcp.connected).toEqual([])
			expect(mcp.failed).toHaveLength(1)
			expect(mcp.failed[0]?.name).toBe('private')
			expect(mcp.failed[0]?.reason).toMatch(/configure the final MCP endpoint directly/i)
			// Two requests reach the source now — the era probe and then the
			// handshake it falls back to — and the claim is about all of them:
			// every one carries the credential to the configured endpoint, and
			// NONE of them reaches the redirect target.
			expect(source.requests.length).toBeGreaterThanOrEqual(1)
			expect(source.requests.every((r) => r.headers['x-api-key'] === 'mcp-secret')).toBe(true)
			expect(source.requests.some((r) => r.body.includes('initialize'))).toBe(true)
			expect(sink.requests).toEqual([])
		} finally {
			await mcp.close()
		}
	})

	it('brings its tools, named after it', async () => {
		const server = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)
		try {
			expect(mcp.failed).toEqual([])
			// The names travel with the server, not only the count. `/mcp` lists
			// them, and recovering them later by splitting the `mcp_<server>_`
			// prefix back apart would turn an encoding this module owns into a
			// format two places have to agree about.
			expect(mcp.connected).toEqual([
				{
					name: 'tickets',
					toolCount: 2,
					tools: ['mcp__tickets__create', 'mcp__tickets__close'],
					drift: { added: [], removed: [], changed: [] },
					refused: [],
				},
			])
			// Prefixed with the server name so two servers offering `create` do
			// not collide and the transcript says where a call went.
			expect(mcp.tools.map((t) => t.name)).toEqual(['mcp__tickets__create', 'mcp__tickets__close'])
		} finally {
			await mcp.close()
		}
	})

	it('produces tools that actually call the server', async () => {
		// The tool objects existing is not the feature. Registering something the
		// model can see and cannot successfully invoke is worse than having
		// nothing, because the failure arrives mid-task.
		const server = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)
		try {
			const create = mcp.tools.find((t) => t.name === 'mcp__tickets__create')
			const result = await create?.execute({ title: 'the build is red' }, {} as never)
			expect(result?.success).toBe(true)
			expect(JSON.stringify(result?.output)).toContain('opened the build is red')
		} finally {
			await mcp.close()
		}
	})

	it('applies server policy, retry budget and approval to the live toolsets', async () => {
		const server = writeServer('tickets.js', WORKING_SERVER)
		const mcp = await connectMcpServers(
			{
				tickets: {
					command: process.execPath,
					args: [server],
					allow: ['create'],
					deny: ['close'],
					maxRetries: 2,
					requireApproval: true,
					readOnlyHintTrusted: true,
				},
			},
			{ cwd: dir },
		)
		try {
			expect(mcp.failed).toEqual([])
			expect(mcp.connected[0]?.tools).toEqual(['mcp__tickets__create'])
			expect(mcp.current().connected[0]?.refused).toEqual([
				{ kind: 'tools', name: 'close', reason: 'denied' },
			])
			expect(mcp.toolsets).toHaveLength(2)
			expect(mcp.toolsets[1]?.availability).toBe('deferred')
			expect(mcp.toolsets[0]?.source.mcpServer?.readOnlyHintTrusted).toBe(true)
			const create = mcp.tools.find((tool) => tool.name === 'mcp__tickets__create')
			expect(create?.maxRetries).toBe(2)
			expect(create?.requiresApproval?.({ title: 'work' })).toBe(true)
			expect(mcp.toolsets[0]?.tools()[0]).toBe(mcp.toolsets[0]?.tools()[0])
		} finally {
			await mcp.close()
		}
	})

	it('surfaces server instructions without changing their content', async () => {
		const server = writeServer(
			'instructed.js',
			WORKING_SERVER.replace(
				'capabilities: { tools: {} },',
				"capabilities: { tools: {} }, instructions: 'Use create sparingly.',",
			),
		)
		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)
		try {
			expect(mcp.connected[0]?.instructions).toBe('Use create sparingly.')
			expect(mcp.toolsets[0]?.source.description).toBe('Use create sparingly.')
		} finally {
			await mcp.close()
		}
	})

	it.each([
		[{ allow: [''] }, /allow must be a list/],
		[{ deny: 'close' }, /deny must be a list/],
		[{ maxRetries: -1 }, /maxRetries must be a nonnegative integer/],
		[{ requireApproval: 'yes' }, /requireApproval must be true or false/],
		[{ readOnlyHintTrusted: 'yes' }, /readOnlyHintTrusted must be true or false/],
	] as const)(
		'names an invalid server tool policy instead of silently skipping it',
		async (policy, reason) => {
			const mcp = await connectMcpServers(
				{ tickets: { command: process.execPath, ...policy } as never },
				{ cwd: dir },
			)
			expect(mcp.connected).toEqual([])
			expect(mcp.failed[0]?.reason).toMatch(reason)
		},
	)

	it('leaves no child process behind when the session closes', async () => {
		// The reason `close()` exists. A stdio server is a child process and
		// nothing else in this package owns one, so before this there was no
		// shutdown path at all: every TUI session and every one-shot left its
		// servers running.
		const server = writeServer('tickets.js', WORKING_SERVER)
		const pidFile = join(dir, 'server.pid')

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server, pidFile] } },
			{ cwd: dir },
		)
		const pid = Number(readFileSync(pidFile, 'utf8'))
		expect(Number.isInteger(pid), 'the server must have actually started').toBe(true)
		expect(() => process.kill(pid, 0), 'and must be alive before the close').not.toThrow()

		await mcp.close()

		await waitForExit(pid)
	}, 20_000)

	it('is absent from the roster when nothing is configured', async () => {
		const mcp = await connectMcpServers(undefined, { cwd: dir })

		expect(mcp.tools).toEqual([])
		expect(mcp.connected).toEqual([])
		expect(mcp.failed).toEqual([])
		await mcp.close()
	})
})

describe('a server that does not work is named, never merely absent', () => {
	it('reports a command that cannot be spawned', async () => {
		const mcp = await connectMcpServers(
			{ tickets: { command: join(dir, 'no-such-executable') } },
			{ cwd: dir },
		)

		expect(mcp.connected).toEqual([])
		expect(mcp.failed).toHaveLength(1)
		expect(mcp.failed[0]?.name).toBe('tickets')
		expect(mcp.failed[0]?.reason.length).toBeGreaterThan(0)
		await mcp.close()
	})

	it('reports a server that starts and never answers, rather than hanging', async () => {
		// The client's per-request timeout cannot cover this: the process is up,
		// the pipe is open, and nothing is coming. Without the connect deadline a
		// single wedged server holds the whole session open before the first turn
		// — no error, no failure, just a namzu that does not start.
		const server = writeServer('silent.js', SILENT_SERVER)

		const started = Date.now()
		const mcp = await connectMcpServers(
			{ quiet: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)

		expect(mcp.failed[0]?.name).toBe('quiet')
		expect(mcp.failed[0]?.reason).toContain('did not answer')
		expect(Date.now() - started, 'the deadline has to actually bound it').toBeLessThan(30_000)
		await mcp.close()
	}, 40_000)

	it('gives a slow server the connect deadline its spec asks for', async () => {
		// The default deadline is for a wedged server; a Python SDK server that
		// cold-boots in 15-20s is a working server it refuses. Proven both ways
		// with one server: too short a deadline names its own value in the
		// failure, a longer one connects and brings the tools.
		const server = writeServer('slow.js', SLOW_SERVER)

		const short = await connectMcpServers(
			{
				slow: {
					command: process.execPath,
					args: [server],
					connectTimeoutMs: 150,
				},
			},
			{ cwd: dir },
		)
		expect(short.connected).toEqual([])
		expect(short.failed[0]?.reason).toContain('did not answer within 150ms')
		await short.close()

		const patient = await connectMcpServers(
			{
				slow: {
					command: process.execPath,
					args: [server],
					connectTimeoutMs: 8_000,
				},
			},
			{ cwd: dir },
		)
		expect(patient.failed).toEqual([])
		expect(patient.connected[0]?.toolCount).toBe(2)
		await patient.close()
	}, 20_000)

	it('fits the era probe inside the default connect deadline, even against a server that ignores it', async () => {
		// The hazard this workstream introduces: `connect()` now probes for a
		// modern server before it offers the legacy handshake, so a legacy
		// server that simply does not answer an unknown method costs a probe
		// timeout on top of everything else. Measured here at the CLI layer,
		// against a REAL child process, because the number that matters is
		// the operator-facing `connectTimeoutMs` default — not the SDK's own.
		const server = writeServer('mute-probe.js', SILENT_ON_UNKNOWN_SERVER)
		const started = Date.now()

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)
		const elapsed = Date.now() - started

		try {
			expect(mcp.failed).toEqual([])
			expect(mcp.connected[0]?.toolCount).toBe(2)
			// The probe really did have to time out — otherwise this test would
			// pass against a server that answered instantly and would say
			// nothing about the budget.
			expect(elapsed, 'the probe timeout is what this measures').toBeGreaterThanOrEqual(1_000)
			expect(elapsed, 'and it has to fit inside the default').toBeLessThan(CONNECT_TIMEOUT_MS)
		} finally {
			await mcp.close()
		}
	}, 20_000)

	it('overrides the era probe timeout so a known-old server gives up on it sooner', async () => {
		// The previous test measures the SDK's own default probe timeout
		// (>= 1s) against a server that stays silent on `server/discover`.
		// This one proves a spec can shorten that wait for a server known to
		// be that old, without touching `connectTimeoutMs` at all.
		const server = writeServer('mute-probe-short.js', SILENT_ON_UNKNOWN_SERVER)
		const started = Date.now()

		const mcp = await connectMcpServers(
			{
				tickets: {
					command: process.execPath,
					args: [server],
					eraProbeTimeoutMs: 100,
				},
			},
			{ cwd: dir },
		)
		const elapsed = Date.now() - started

		try {
			expect(mcp.failed).toEqual([])
			expect(mcp.connected[0]?.toolCount).toBe(2)
			// Well under the SDK's ~2s default: the override is what shortened
			// this, not the connect deadline (still the 10s default here).
			expect(elapsed, 'the shorter probe timeout is what this measures').toBeLessThan(1_000)
		} finally {
			await mcp.close()
		}
	}, 20_000)

	it('leaves the era probe at the SDK default when the spec names none', async () => {
		// The passthrough is conditional (`eraProbeTimeoutMs` is only added to
		// the `MCPClient` config when the spec sets one) precisely so an
		// unconfigured server keeps behaving exactly as it did before this
		// field existed — proven here against a normal, responsive server
		// rather than by re-measuring the silent-probe timing above.
		const server = writeServer('tickets-default-probe.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, args: [server] } },
			{ cwd: dir },
		)

		try {
			expect(mcp.failed).toEqual([])
			expect(mcp.connected[0]?.toolCount).toBe(2)
		} finally {
			await mcp.close()
		}
	})

	it('refuses an era probe timeout that is not a positive number of milliseconds', async () => {
		// Not defaulted: silently running with the SDK's default would produce
		// the very wait the operator was configuring away, and blame the
		// server for it.
		const server = writeServer('tickets.js', WORKING_SERVER)
		const mcp = await connectMcpServers(
			{
				tickets: {
					command: process.execPath,
					args: [server],
					eraProbeTimeoutMs: 0,
				},
			},
			{ cwd: dir },
		)

		expect(mcp.connected).toEqual([])
		expect(mcp.failed[0]?.name).toBe('tickets')
		expect(mcp.failed[0]?.reason).toContain('eraProbeTimeoutMs')
		await mcp.close()
	})

	it('refuses a connect deadline that is not a positive number of milliseconds', async () => {
		// Not defaulted: silently running with 10s would produce the failure the
		// operator was configuring away, and blame the server for it.
		const server = writeServer('tickets.js', WORKING_SERVER)
		const mcp = await connectMcpServers(
			{
				tickets: {
					command: process.execPath,
					args: [server],
					connectTimeoutMs: -1,
				},
			},
			{ cwd: dir },
		)

		expect(mcp.connected).toEqual([])
		expect(mcp.failed[0]?.name).toBe('tickets')
		expect(mcp.failed[0]?.reason).toContain('connectTimeoutMs')
		await mcp.close()
	})

	it('does not let one broken server take the working ones with it', async () => {
		const good = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{
				broken: { command: join(dir, 'no-such-executable') },
				tickets: { command: process.execPath, args: [good] },
			},
			{ cwd: dir },
		)
		try {
			expect(mcp.failed.map((f) => f.name)).toEqual(['broken'])
			expect(mcp.connected.map((c) => c.name)).toEqual(['tickets'])
		} finally {
			await mcp.close()
		}
	})
})

describe('a spec that is not a server', () => {
	it('reports an invalid instructions opt-in by server name', async () => {
		const mcp = await connectMcpServers(
			{ tickets: { command: process.execPath, instructions: 'yes' as never } },
			{ cwd: dir },
		)
		expect(mcp.connected).toEqual([])
		expect(mcp.failed).toEqual([{ name: 'tickets', reason: 'instructions must be true or false' }])
		await mcp.close()
	})

	it('refuses one that names neither a command nor a url', () => {
		expect(transportFor({}, dir)).toContain('neither a command nor a url')
	})

	it('refuses one that names both, rather than picking', () => {
		// An operator who edited a url into an entry that already had a command
		// meant one of them. Choosing for them runs something they did not ask
		// to run.
		expect(transportFor({ command: 'x', url: 'https://y' }, dir)).toContain('both')
	})

	it('reports a bad spec by name, alongside the servers that worked', async () => {
		const good = writeServer('tickets.js', WORKING_SERVER)

		const mcp = await connectMcpServers(
			{ nonsense: {}, tickets: { command: process.execPath, args: [good] } },
			{ cwd: dir },
		)
		try {
			expect(mcp.failed[0]?.name).toBe('nonsense')
			expect(mcp.connected.map((c) => c.name)).toEqual(['tickets'])
		} finally {
			await mcp.close()
		}
	})

	it('defaults a stdio server to the agent working directory', () => {
		const transport = transportFor({ command: 'node' }, dir)

		expect(typeof transport).not.toBe('string')
		expect((transport as { cwd?: string }).cwd).toBe(dir)
	})
})

describe('${VAR} expansion in env and headers values', () => {
	it('expands a bare ${VAR} reference against the given environment', () => {
		const result = expandEnvRefsInRecord({ TOKEN: '${API_TOKEN}' }, { API_TOKEN: 'secret-1' })
		expect(result).toEqual({ TOKEN: 'secret-1' })
	})

	it('expands a reference embedded inside a larger string', () => {
		const result = expandEnvRefsInRecord(
			{ Authorization: 'Bearer ${API_TOKEN}' },
			{ API_TOKEN: 'secret-1' },
		)
		expect(result).toEqual({ Authorization: 'Bearer secret-1' })
	})

	it('leaves a value with no ${VAR} reference untouched', () => {
		const result = expandEnvRefsInRecord({ NAME: 'literal' }, {})
		expect(result).toEqual({ NAME: 'literal' })
	})

	it('refuses a reference to a variable that is not set, naming it', () => {
		const result = expandEnvRefsInRecord({ TOKEN: '${MISSING_TOKEN}' }, {})
		expect(typeof result).toBe('string')
		expect(result).toContain('MISSING_TOKEN')
		expect(result).toContain('not set')
	})

	it('does not support a ${VAR:-default} fallback — the whole value is treated as the variable name search', () => {
		// No `:-default` syntax at all: a colon inside the braces is just not a
		// valid identifier character, so this is read as an unset reference
		// rather than one that falls back to a default.
		const result = expandEnvRefsInRecord({ TOKEN: '${MISSING:-fallback}' }, { MISSING: 'x' })
		expect(result).toEqual({ TOKEN: '${MISSING:-fallback}' })
	})

	it('transportFor expands env values for a stdio server', () => {
		const transport = transportFor({ command: 'node', env: { TOKEN: '${API_TOKEN}' } }, dir, {
			API_TOKEN: 'secret-1',
		} as NodeJS.ProcessEnv)
		expect(typeof transport).not.toBe('string')
		expect((transport as { env?: Record<string, string> }).env).toEqual({ TOKEN: 'secret-1' })
	})

	it('transportFor expands header values for an http server', () => {
		const transport = transportFor(
			{ url: 'https://example.invalid/mcp', headers: { 'X-Token': '${API_TOKEN}' } },
			dir,
			{ API_TOKEN: 'secret-1' } as NodeJS.ProcessEnv,
		)
		expect(typeof transport).not.toBe('string')
		expect((transport as { headers?: Record<string, string> }).headers).toEqual({
			'X-Token': 'secret-1',
		})
	})

	it('transportFor refuses a stdio server whose env references an unset variable', () => {
		const transport = transportFor(
			{ command: 'node', env: { TOKEN: '${MISSING_TOKEN}' } },
			dir,
			{} as NodeJS.ProcessEnv,
		)
		expect(typeof transport).toBe('string')
		expect(transport).toContain('MISSING_TOKEN')
	})

	it('command, args, url and cwd are passed through literally, never expanded', () => {
		const transport = transportFor({ command: '${NOT_EXPANDED}', args: ['${ALSO_NOT}'] }, dir, {
			NOT_EXPANDED: 'x',
			ALSO_NOT: 'y',
		} as NodeJS.ProcessEnv)
		expect(typeof transport).not.toBe('string')
		expect((transport as { command?: string }).command).toBe('${NOT_EXPANDED}')
		expect((transport as { args?: string[] }).args).toEqual(['${ALSO_NOT}'])
	})

	it('connectMcpServers fails the whole server, by name, when a header references an unset variable', async () => {
		const mcp = await connectMcpServers(
			{
				secure: {
					url: 'https://example.invalid/mcp',
					headers: { Authorization: 'Bearer ${MISSING_MCP_TOKEN_TEST_ONLY_XYZ}' },
				},
			},
			{ cwd: dir },
		)
		try {
			expect(mcp.connected).toEqual([])
			expect(mcp.failed).toHaveLength(1)
			expect(mcp.failed[0]?.name).toBe('secure')
			expect(mcp.failed[0]?.reason).toContain('MISSING_MCP_TOKEN_TEST_ONLY_XYZ')
		} finally {
			await mcp.close()
		}
	})
})
