import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { safeTestReason } from '../mcp.js'

const initialCwd = process.cwd()
const origins: Server[] = []
let root: string
let home: string
let project: string
let stdout: string
let stderr: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-mcp-test-'))
	home = join(root, 'home')
	project = join(root, 'project')
	mkdirSync(home)
	mkdirSync(project)
	process.chdir(project)
	vi.stubEnv('NAMZU_HOME', home)
	stdout = ''
	stderr = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderr += String(chunk)
		return true
	})
})

afterEach(async () => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	await Promise.all(
		origins.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections()
					server.close(() => resolve())
				}),
		),
	)
	removeTempDir(root)
})

async function testServer(
	name: string,
	profile?: string,
	trust = true,
): Promise<{
	readonly code: number
	readonly output: Record<string, unknown>
	readonly stderr: string
}> {
	stdout = ''
	stderr = ''
	const code = await runCli({
		argv: [
			'node',
			'namzu',
			'--format',
			'json',
			...(profile ? ['--profile', profile] : []),
			'mcp',
			'test',
			name,
			...(trust ? ['--trust'] : []),
		],
	})
	return { code, output: JSON.parse(stdout) as Record<string, unknown>, stderr }
}

it('refuses an untrusted project before starting its configured command', async () => {
	const marker = join(root, 'server-started')
	const executable = join(root, 'executable.cjs')
	writeFileSync(
		executable,
		`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
	)
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [executable] } } }),
	)

	const result = await testServer('local', undefined, false)
	expect(result.code).toBe(77)
	expect(result.output).toMatchObject({
		name: 'local',
		status: 'unavailable',
		transport: 'invalid',
		toolCount: 0,
		reason: 'project is not trusted; open namzu here or pass --trust for this test',
	})
	expect(existsSync(marker)).toBe(false)
})

const WORKING_SERVER = `
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params.protocolVersion,
        serverInfo: { name: 'fixture', version: '1' },
        capabilities: { tools: {} },
      }})
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'first', inputSchema: { type: 'object', properties: {} } },
        { name: 'second', inputSchema: { type: 'object', properties: {} } },
      ]}})
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }
`

it('probes only the selected effective profile server and reports its usable tools', async () => {
	const serverPath = join(root, 'working-server.cjs')
	const siblingPath = join(root, 'sibling.cjs')
	const siblingMarker = join(root, 'sibling-started')
	writeFileSync(serverPath, WORKING_SERVER)
	writeFileSync(
		siblingPath,
		`require('node:fs').writeFileSync(${JSON.stringify(siblingMarker)}, 'started')`,
	)
	writeFileSync(
		join(home, 'config.yaml'),
		'mcpServers:\n  tickets:\n    command: missing-user-command\n',
	)
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({
			mcpServers: { tickets: { command: 'missing-project-command' } },
			profiles: {
				probe: {
					mcpServers: {
						tickets: { command: process.execPath, args: [serverPath] },
						sibling: { command: process.execPath, args: [siblingPath] },
					},
				},
			},
		}),
	)

	const result = await testServer('tickets', 'probe')
	expect(result.code).toBe(0)
	expect(result.output).toMatchObject({
		name: 'tickets',
		status: 'connected',
		transport: 'stdio',
		toolCount: 2,
	})
	expect(result.output).not.toHaveProperty('reason')
	expect(existsSync(siblingMarker)).toBe(false)
})

it('returns a safe, named reason when a local command cannot start', async () => {
	const secret = 'private-command-argument-949'
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({ mcpServers: { broken: { command: join(root, secret) } } }),
	)

	const result = await testServer('broken')
	expect(result.code).not.toBe(0)
	expect(result.output).toMatchObject({
		name: 'broken',
		status: 'unavailable',
		transport: 'stdio',
		toolCount: 0,
		reason:
			'stdio server did not start or closed before the handshake; check command, cwd and server logs',
	})
	expect(`${stdout}${stderr}`).not.toContain(secret)
})

it('reports HTTP 401 without exposing the endpoint query or server body', async () => {
	const secret = 'private-endpoint-token-618'
	const origin = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Consume the request before responding, as a real MCP origin does.
		}
		response.writeHead(401, { 'content-type': 'text/plain' }).end(`unauthorized ${secret}`)
	})
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
	origins.push(origin)
	const endpoint = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/mcp?token=${secret}`
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({ mcpServers: { private: { url: endpoint } } }),
	)

	const result = await testServer('private')
	expect(result.code).not.toBe(0)
	expect(result.output).toMatchObject({
		name: 'private',
		status: 'unavailable',
		transport: 'http',
		toolCount: 0,
		reason: 'HTTP 401: sign in with namzu mcp login private',
	})
	expect(`${stdout}${stderr}`).not.toContain(secret)
})

it('does not suggest OAuth login for an HTTP endpoint that the login command refuses', () => {
	expect(
		safeTestReason(
			'HTTP 401: authentication required',
			{ url: 'http://remote.example/mcp' },
			'remote',
		),
	).toBe('HTTP 401: OAuth sign-in requires HTTPS or a loopback endpoint')
	expect(
		safeTestReason(
			'HTTP 401: authentication required',
			{ url: 'https://remote.example/mcp' },
			'remote',
		),
	).toBe('HTTP 401: sign in with namzu mcp login remote')
})

it('accepts a connected server with no exposed tools and marks that limit', async () => {
	const origin = createServer(async (request, response) => {
		let body = ''
		for await (const chunk of request) body += String(chunk)
		const message = JSON.parse(body) as { id: number; method: string }
		const result =
			message.method === 'server/discover'
				? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
				: { tools: [] }
		response
			.writeHead(200, { 'content-type': 'application/json' })
			.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
	})
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
	origins.push(origin)
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({
			mcpServers: {
				empty: { url: `http://127.0.0.1:${(origin.address() as AddressInfo).port}/mcp` },
			},
		}),
	)

	const result = await testServer('empty')
	expect(result.code).toBe(0)
	expect(result.output).toMatchObject({
		name: 'empty',
		status: 'connected',
		transport: 'http',
		toolCount: 0,
		warning: 'No server tools or prompts were exposed.',
	})
})

it('does not count deferred resource helpers as published server tools', async () => {
	const origin = createServer(async (request, response) => {
		let body = ''
		for await (const chunk of request) body += String(chunk)
		const message = JSON.parse(body) as { id: number; method: string }
		const result =
			message.method === 'server/discover'
				? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } }
				: message.method === 'resources/list'
					? { resources: [] }
					: { tools: [] }
		response
			.writeHead(200, { 'content-type': 'application/json' })
			.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
	})
	await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
	origins.push(origin)
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({
			mcpServers: {
				empty: { url: `http://127.0.0.1:${(origin.address() as AddressInfo).port}/mcp` },
			},
		}),
	)

	const result = await testServer('empty')
	expect(result.code).toBe(0)
	expect(result.output).toMatchObject({
		name: 'empty',
		status: 'connected',
		toolCount: 0,
		resourceHelperCount: 2,
		warning: 'No server tools or prompts were exposed.',
	})
	expect(result.output.text).toContain('0 server tools or prompts')
})

it('reports a malformed effective entry instead of dereferencing it', async () => {
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({ mcpServers: { broken: null } }),
	)
	const result = await testServer('broken')
	expect(result.code).not.toBe(0)
	expect(result.output).toMatchObject({
		name: 'broken',
		status: 'unavailable',
		transport: 'invalid',
		toolCount: 0,
		reason: 'server specification must be a mapping',
	})
})

it('names an invalid nested server setting in the test report', async () => {
	writeFileSync(
		join(project, 'namzu.config.json'),
		JSON.stringify({ mcpServers: { broken: { command: process.execPath, args: { bad: true } } } }),
	)
	const result = await testServer('broken')
	expect(result.code).not.toBe(0)
	expect(result.output).toMatchObject({
		name: 'broken',
		status: 'unavailable',
		transport: 'stdio',
		toolCount: 0,
		reason: 'invalid args setting',
	})
})
