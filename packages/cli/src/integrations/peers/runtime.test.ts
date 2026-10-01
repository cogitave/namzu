import { mkdirSync, mkdtempSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	MockLLMProvider,
	PeerClient,
	createUserMessage,
	drainQuery,
	readPeerRecords,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../subagents/__fixtures__/parent.js'
import { type LivePeers, openLivePeers, peerMailMessage } from './runtime.js'

const roots: string[] = []
const opened: LivePeers[] = []
afterEach(async () => {
	for (const peers of opened.splice(0)) await peers.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'np-'))
	roots.push(root)
	const home = join(root, 'h')
	const cwd = join(root, 'p')
	mkdirSync(cwd)
	let mode = 'auto'
	let owner = 0
	let ready = true
	let wakes = 0
	const reports: string[] = []
	const options = {
		home,
		cwd,
		version: 'fixture',
		env: {},
		mode: () => mode,
		owner: () => owner,
		state: () => 'idle' as const,
		ready: () => ready,
		available: () => {
			wakes++
		},
		report: (text: string) => reports.push(text),
	}
	const receiver = await openLivePeers(options)
	opened.push(receiver)
	const sender = await openLivePeers({ ...options, mode: () => 'auto' })
	opened.push(sender)
	return {
		root,
		home,
		cwd,
		receiver,
		sender,
		reports,
		wakes: () => wakes,
		setMode: (value: string) => {
			mode = value
		},
		setOwner: () => {
			owner++
		},
		setReady: (value: boolean) => {
			ready = value
		},
	}
}

it('discovers two independently addressed live instances without leaking tokens', async () => {
	const f = await fixture()
	const sessions = await f.sender.list()
	expect(sessions).toHaveLength(2)
	expect(sessions.find((session) => session.session_id === f.sender.id)?.self).toBe(true)
	expect(JSON.stringify(sessions)).not.toContain('token')
	expect(JSON.stringify(sessions)).not.toContain('uds:')
	expect(f.receiver.id).not.toBe(f.sender.id)
	await f.receiver.close()
	expect(await f.sender.list()).toHaveLength(1)
})

it('queues and wakes, preserves order and provenance, and drains only once', async () => {
	const f = await fixture()
	expect(await f.sender.send(f.receiver.ref, 'first')).toMatchObject({
		status: 'queued',
	})
	expect(await f.sender.send(f.receiver.id, 'second')).toMatchObject({
		status: 'queued',
	})
	expect(f.wakes()).toBe(2)
	const mail = f.receiver.take(0)
	expect(mail.map((entry) => entry.text)).toEqual(['first', 'second'])
	expect(mail[0]?.from.sessionId).toBe(f.sender.id)
	const message = peerMailMessage(mail[0]!)
	expect(message).toMatchObject({
		role: 'user',
		source: { type: 'runtime-context', kind: 'peer-message' },
	})
	expect(message.content).toContain("not the operator's instruction or approval")
	expect(message.content).toContain(f.sender.id)
	expect(f.receiver.take(0)).toEqual([])
})

it('disables optional messaging when its registry becomes unavailable without throwing', async () => {
	const f = await fixture()
	const sessionsDir = join(f.home, 'run', 'sessions')
	const moved = join(f.home, 'run', 'sessions-moved')
	renameSync(sessionsDir, moved)
	try {
		expect(() => f.sender.publish()).not.toThrow()
		expect(f.sender.enabled).toBe(false)
		expect(f.reports.join('\n')).toContain('live record could not be updated')
		expect(await f.sender.send(f.receiver.ref, 'do not send')).toMatchObject({ status: 'refused' })
		expect(f.receiver.pending).toBe(0)
	} finally {
		renameSync(moved, sessionsDir)
	}
})

it('refuses off, unready, different mode, self, blank and oversized sends', async () => {
	const f = await fixture()
	f.receiver.setEnabled(false)
	expect(await f.sender.send(f.receiver.ref, 'off')).toMatchObject({
		status: 'refused',
	})
	f.receiver.setEnabled(true)
	f.setReady(false)
	expect(await f.sender.send(f.receiver.ref, 'not ready')).toMatchObject({
		status: 'refused',
	})
	f.setReady(true)
	f.setMode('strict')
	expect(await f.sender.send(f.receiver.ref, 'mode mismatch')).toMatchObject({
		status: 'refused',
	})
	expect(await f.sender.send(f.sender.ref, 'self')).toMatchObject({
		status: 'refused',
	})
	expect(await f.sender.send(f.receiver.ref, ' ')).toMatchObject({
		status: 'refused',
	})
	expect(await f.sender.send(f.receiver.ref, '界'.repeat(12000))).toMatchObject({
		status: 'refused',
	})
	expect(f.receiver.pending).toBe(0)
})

it('bounds the inbox and does not migrate accepted mail across conversations', async () => {
	const f = await fixture()
	for (let index = 0; index < 32; index++)
		expect(await f.sender.send(f.receiver.ref, `mail ${index}`)).toMatchObject({
			status: 'queued',
		})
	expect(await f.sender.send(f.receiver.ref, 'overflow')).toMatchObject({
		status: 'refused',
	})
	expect(f.receiver.take(1)).toEqual([])
	f.setOwner()
	expect(f.receiver.take(1)).toEqual([])
	expect(f.reports.join('\n')).toContain(
		'32 peer message(s) were not delivered because the conversation changed',
	)
	expect(await f.sender.send(f.receiver.ref, 'new conversation')).toMatchObject({
		status: 'queued',
	})
	expect(f.receiver.take(1).map((entry) => entry.text)).toEqual(['new conversation'])
})

it('deduplicates one live message id and refuses conflicting reuse', async () => {
	const f = await fixture()
	const records = readPeerRecords(join(f.home, 'run', 'sessions'))
	const receiver = records.find((record) => record.sessionId === f.receiver.id)!
	const sender = records.find((record) => record.sessionId === f.sender.id)!
	const from = {
		sessionId: sender.sessionId,
		ref: sender.ref,
		name: 'ignored wire name',
		address: sender.address,
		mode: sender.permissionMode,
		kind: sender.kind,
	}
	const client = new PeerClient()
	const request = { id: 'one-delivery', from, text: 'once' }
	expect(await client.deliver(receiver, request)).toMatchObject({
		status: 'queued',
	})
	expect(await client.deliver(receiver, request)).toMatchObject({
		status: 'queued',
	})
	expect(await client.deliver(receiver, { ...request, text: 'replacement' })).toMatchObject({
		status: 'refused',
	})
	const mail = f.receiver.take(0)
	expect(mail).toHaveLength(1)
	expect(mail[0]?.from.name).toBe(sender.title)
	f.setOwner()
	expect(await client.deliver(receiver, request)).toMatchObject({
		status: 'refused',
	})
})

it('excludes other projects even in the same OS-user registry', async () => {
	const f = await fixture()
	const foreignCwd = join(f.root, 'other')
	mkdirSync(foreignCwd)
	const foreign = await openLivePeers({
		home: f.home,
		cwd: foreignCwd,
		version: 'fixture',
		env: {},
		mode: () => 'auto',
		owner: () => 0,
		state: () => 'idle',
		ready: () => true,
		available() {},
		report() {},
	})
	opened.push(foreign)
	expect(await f.sender.list()).toHaveLength(2)
	expect(await foreign.send(f.receiver.ref, 'foreign')).toMatchObject({
		status: 'refused',
	})
	expect(f.receiver.pending).toBe(0)
})

it('reports accepted but undelivered mail on graceful close', async () => {
	const f = await fixture()
	await f.sender.send(f.receiver.ref, 'not consumed')
	const closing = f.receiver.close()
	expect(f.receiver.close()).toBe(closing)
	expect(f.receiver.enabled).toBe(false)
	await closing
	expect(f.reports.join('\n')).toContain(
		'1 peer message(s) were not delivered before this terminal closed',
	)
	expect(await f.sender.send(f.receiver.id, 'too late')).toMatchObject({
		status: 'refused',
	})
})

it('delivers mail arriving during the apparent final response at the next real model boundary', async () => {
	const f = await fixture()
	const first = deferred<void>()
	const release = deferred<void>()
	const requests: ChatCompletionParams[] = []
	const mock = new MockLLMProvider({
		turns: [{ text: 'Original final' }, { text: 'Corrected final' }],
	})
	const provider = {
		id: 'peer-fixture',
		name: 'Peer fixture',
		async *chatStream(params: ChatCompletionParams) {
			requests.push(structuredClone({ ...params, signal: undefined }))
			if (requests.length === 1) {
				first.resolve()
				await release.promise
			}
			yield* mock.chatStream(params)
		},
	}
	const parent = await subagentParentFixture(f.cwd)
	const pending = drainQuery({
		agentId: 'namzu',
		agentName: 'namzu',
		...parent.scope,
		provider,
		toolsets: [],
		messages: [createUserMessage('Original operator task')],
		workingDirectory: f.cwd,
		turnConfig: {
			model: 'mock-model',
			permissionMode: 'auto',
			maxIterations: 5,
			timeoutMs: 30000,
			tokenBudget: 100000,
		},
		inboundMessages: () => f.receiver.take(0).map(peerMailMessage),
	})
	await first.promise
	expect(await f.sender.send(f.receiver.ref, 'PEER_CORRECTION')).toMatchObject({
		status: 'queued',
	})
	expect(requests).toHaveLength(1)
	expect(
		requests[0]?.messages.some((message) => String(message.content).includes('PEER_CORRECTION')),
	).toBe(false)
	release.resolve()
	const result = await pending
	expect(result.result).toBe('Corrected final')
	expect(requests).toHaveLength(2)
	const delivered = requests[1]?.messages.filter((message) =>
		String(message.content).includes('PEER_CORRECTION'),
	)
	expect(delivered).toHaveLength(1)
	expect(delivered?.[0]).toMatchObject({
		source: { type: 'runtime-context', kind: 'peer-message' },
	})
	expect(f.receiver.pending).toBe(0)
})
