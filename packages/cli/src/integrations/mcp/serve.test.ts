import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { getBuiltinTools } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { compilePermissionLayers } from '../../permissions/rules.js'
import { toolFlagLayers } from '../../permissions/tool-flags.js'
import { NamzuToolProvider, serveMcpTools } from './serve.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

interface Client {
	request(method: string, params?: unknown): Promise<Record<string, any>>
	finish(): Promise<void>
}

/** A client on in-memory pipes: one request out, its answer back, in order. */
function connect(provider: NamzuToolProvider): Client {
	const toServer = new PassThrough()
	const fromServer = new PassThrough()
	const served = serveMcpTools(provider, { input: toServer, output: fromServer }, 'test')
	const waiting = new Map<number, (message: Record<string, any>) => void>()
	let buffer = ''
	fromServer.setEncoding('utf8')
	fromServer.on('data', (chunk: string) => {
		buffer += chunk
		for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
			const message = JSON.parse(buffer.slice(0, at)) as Record<string, any>
			buffer = buffer.slice(at + 1)
			waiting.get(message.id)?.(message)
		}
	})
	let next = 0
	return {
		request: (method, params) =>
			new Promise((resolve) => {
				const id = ++next
				waiting.set(id, resolve)
				toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
			}),
		finish: async () => {
			toServer.end()
			await served
		},
	}
}

function provider(
	cwd: string,
	flags: { allowed?: string[]; denied?: string[]; mode?: 'accept-edits' | 'bypass' | 'plan' } = {},
): NamzuToolProvider {
	const layers = toolFlagLayers({
		allowedTools: flags.allowed ?? [],
		disallowedTools: flags.denied ?? [],
	}).layers
	return new NamzuToolProvider({
		cwd,
		rules: compilePermissionLayers(layers).rules,
		...(flags.mode ? { mode: flags.mode } : {}),
		tools: getBuiltinTools(),
	})
}

function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-mcp-serve-'))
	roots.push(dir)
	writeFileSync(join(dir, 'note.txt'), 'hello from the folder\n')
	return dir
}

it('initializes, lists the built-in tools and reads a file in the working directory', async () => {
	const dir = folder()
	const client = connect(provider(dir))
	const init = await client.request('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'test', version: '1' },
	})
	expect(init.result.serverInfo.name).toBe('namzu')
	expect(init.result.capabilities.tools).toBeDefined()
	const listed = await client.request('tools/list')
	const names = listed.result.tools.map((tool: { name: string }) => tool.name)
	expect(names).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'glob', 'grep']))
	expect(names).not.toContain('job')
	const read = await client.request('tools/call', {
		name: 'read',
		arguments: { path: join(dir, 'note.txt') },
	})
	expect(read.result.isError).toBeUndefined()
	expect(read.result.content[0].text).toContain('hello from the folder')
	await client.finish()
})

it('refuses a call that needs a person and names the rule to add', async () => {
	const dir = folder()
	const client = connect(provider(dir))
	const refused = await client.request('tools/call', {
		name: 'write',
		arguments: { path: join(dir, 'new.txt'), content: 'x' },
	})
	expect(refused.result.isError).toBe(true)
	expect(refused.result.content[0].text).toContain('no person on this channel')
	expect(refused.result.content[0].text).toContain('--allowed-tools "write"')
	const bash = await client.request('tools/call', {
		name: 'bash',
		arguments: { command: 'touch marker.txt' },
	})
	expect(bash.result.isError).toBe(true)
	expect(bash.result.content[0].text).toContain('--allowed-tools "bash(touch marker.txt *)"')
	await client.finish()
})

it('runs a call an allow rule covers, and a deny rule always wins', async () => {
	const dir = folder()
	const client = connect(provider(dir, { allowed: ['write', 'read'], denied: ['read'] }))
	const wrote = await client.request('tools/call', {
		name: 'write',
		arguments: { path: join(dir, 'new.txt'), content: 'written' },
	})
	expect(wrote.result.isError).toBeUndefined()
	expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('written')
	const denied = await client.request('tools/call', {
		name: 'read',
		arguments: { path: join(dir, 'note.txt') },
	})
	expect(denied.result.isError).toBe(true)
	expect(denied.result.content[0].text).toContain('denied')
	await client.finish()
})

it('lets a launch mode widen only what no rule asked about, and never past a deny', async () => {
	const dir = folder()
	const edits = connect(provider(dir, { mode: 'accept-edits' }))
	const wrote = await edits.request('tools/call', {
		name: 'write',
		arguments: { path: join(dir, 'a.txt'), content: 'a' },
	})
	expect(wrote.result.isError).toBeUndefined()
	const shell = await edits.request('tools/call', {
		name: 'bash',
		arguments: { command: 'touch marker.txt' },
	})
	expect(shell.result.isError).toBe(true)
	await edits.finish()

	const bypass = connect(provider(dir, { mode: 'bypass', denied: ['write'] }))
	const blocked = await bypass.request('tools/call', {
		name: 'write',
		arguments: { path: join(dir, 'b.txt'), content: 'b' },
	})
	expect(blocked.result.isError).toBe(true)
	await bypass.finish()

	const plan = connect(provider(dir, { mode: 'plan', allowed: ['write'] }))
	const planned = await plan.request('tools/call', {
		name: 'write',
		arguments: { path: join(dir, 'c.txt'), content: 'c' },
	})
	expect(planned.result.isError).toBe(true)
	await plan.finish()
})

it('answers an unknown method with the protocol error and rejects bad arguments', async () => {
	const dir = folder()
	const client = connect(provider(dir))
	expect((await client.request('resources/list')).error.code).toBe(-32601)
	const bad = await client.request('tools/call', { name: 'read', arguments: { path: 5 } })
	expect(bad.result.isError).toBe(true)
	await client.finish()
})

it('answers a call that is still running when the client closes its end', async () => {
	const dir = folder()
	const toServer = new PassThrough()
	const fromServer = new PassThrough()
	fromServer.setEncoding('utf8')
	let text = ''
	fromServer.on('data', (chunk: string) => {
		text += chunk
	})
	const served = serveMcpTools(provider(dir), { input: toServer, output: fromServer }, 'test')
	toServer.write(
		`${JSON.stringify({
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'read', arguments: { path: join(dir, 'note.txt') } },
		})}\n`,
	)
	toServer.end()
	await served
	expect(JSON.parse(text.trim()).result.content[0].text).toContain('hello from the folder')
})
