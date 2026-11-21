import { mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	ControlError,
	type ControlServer,
	PERSON_ONLY_OPS,
	callControl,
	controlDispatch,
	createControlClient,
	newControlToken,
	readControlInfo,
	removeControlInfo,
	startControlServer,
	writeControlInfo,
} from './control.js'
import type { NetworkControl } from './types.js'

const roots: string[] = []
const servers: ControlServer[] = []
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function fakeControl(calls: unknown[][] = []): NetworkControl {
	const record =
		(name: string) =>
		async (...args: unknown[]) => {
			calls.push([name, ...args])
			return undefined as never
		}
	return {
		summary: async () => ({
			state: 'ready',
			members: 2,
			nearbyNetworks: 0,
			nearby: [],
			joinRequests: [],
			held: [],
			outcomes: [],
		}),
		roster: async () => ({ machines: [] }),
		allow: async (q) => {
			calls.push(['allow', q])
			return {
				requestId: 'r',
				name: 'desk-mini',
				code: '482 913',
				sourceAddr: '10.0.0.4',
				expiresAt: 1,
			}
		},
		deny: record('deny'),
		remove: record('remove'),
		rename: record('rename'),
		setRole: async (target, role) => {
			calls.push(['setRole', target, role])
			if (target === 'nobody')
				throw Object.assign(new Error('No session called "nobody".'), { code: 'unknown_target' })
			return { status: 'applied' }
		},
		send: record('send'),
		add: record('add'),
		join: record('join'),
		cancelJoin: record('cancelJoin'),
		allowHeld: record('allowHeld'),
		denyHeld: record('denyHeld'),
		reportDelivered: record('reportDelivered'),
	}
}

async function serve(
	control: NetworkControl,
	guard?: Parameters<typeof startControlServer>[0]['guard'],
) {
	const root = mkdtempSync(join(tmpdir(), 'nc-'))
	roots.push(root)
	const dir = join(root, 'network')
	mkdirSync(dir)
	const path = join(root, 'c.sock')
	const token = newControlToken()
	const server = await startControlServer({
		path,
		token,
		dispatch: controlDispatch(control),
		...(guard ? { guard } : {}),
	})
	servers.push(server)
	const info = { address: path, token, pid: process.pid }
	writeControlInfo(dir, info)
	return { dir, path, token, info }
}

it('answers the people it is told about, with the words of what happened', async () => {
	const calls: unknown[][] = []
	const { info } = await serve(fakeControl(calls))
	const client = createControlClient(() => info)
	expect((await client.summary()).members).toBe(2)
	expect(await client.allow('482913')).toMatchObject({ name: 'desk-mini' })
	expect(await client.setRole('calm-heron', 'orchestrator')).toEqual({ status: 'applied' })
	expect(calls).toEqual([
		['allow', '482913'],
		['setRole', 'calm-heron', 'orchestrator'],
	])
})

it('refuses the decisions that belong to the person from a caller that runs under a session', async () => {
	const calls: unknown[][] = []
	const { info } = await serve(fakeControl(calls), (op, caller) =>
		PERSON_ONLY_OPS.includes(op) && caller.pid === process.pid ? 'for the person' : undefined,
	)
	const client = createControlClient(() => info)
	await expect(client.allow('482913')).rejects.toMatchObject({
		message: 'for the person',
		code: 'person-only',
	})
	expect(await client.setRole('calm-heron', 'x')).toEqual({ status: 'applied' })
	expect(calls).toEqual([['setRole', 'calm-heron', 'x']])
})

it('carries a failure with its message and its code', async () => {
	const { info } = await serve(fakeControl())
	const client = createControlClient(() => info)
	await expect(client.setRole('nobody', 'x')).rejects.toMatchObject({
		message: 'No session called "nobody".',
		code: 'unknown_target',
	})
})

it('refuses a request without the token, and an operation that is not one of its own', async () => {
	const { info } = await serve(fakeControl())
	await expect(callControl({ ...info, token: 'wrong' }, 'summary', [])).rejects.toBeInstanceOf(
		ControlError,
	)
	await expect(callControl(info, 'constructor', [])).rejects.toMatchObject({
		message: 'Unknown request.',
	})
	await expect(callControl(info, 'dispose', [])).rejects.toMatchObject({
		message: 'Unknown request.',
	})
})

it('drops a request that is too large to be one', async () => {
	const { path } = await serve(fakeControl())
	const reply = await new Promise<string>((resolve) => {
		const socket = connect(path)
		let received = ''
		socket.on('data', (chunk) => {
			received += chunk.toString()
		})
		socket.on('close', () => resolve(received))
		socket.on('error', () => {})
		socket.on('connect', () => socket.write('x'.repeat(70 * 1024)))
	})
	expect(reply).toBe('')
})

it('says there is no terminal when nobody leads, and when the leader is gone', async () => {
	await expect(createControlClient(() => undefined).summary()).rejects.toMatchObject({
		code: 'no-leader',
	})
	const { info, dir } = await serve(fakeControl())
	await servers.pop()?.close()
	await expect(createControlClient(() => info).summary()).rejects.toMatchObject({
		code: 'unreachable',
	})
	removeControlInfo(dir, process.pid)
	expect(readControlInfo(dir)).toBeUndefined()
})

it('keeps the token in a file only its owner can read, and removes only its own', async () => {
	const { dir, info } = await serve(fakeControl())
	expect(statSync(join(dir, 'control.json')).mode & 0o077).toBe(0)
	expect(readControlInfo(dir)).toEqual(info)
	removeControlInfo(dir, process.pid + 1)
	expect(readControlInfo(dir)).toEqual(info)
	expect(statSync(info.address).mode & 0o077).toBe(0)
})
