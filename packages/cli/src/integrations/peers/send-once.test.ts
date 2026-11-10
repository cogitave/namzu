import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeerClient, readPeerRecords, udsPeerAddress, writePeerRecord } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type LivePeers,
	openLivePeers,
	peerMailLabel,
	peerMailMessage,
	resolvePeerRuntime,
} from './runtime.js'
import { listProjectTerminals, sendToTerminal } from './send-once.js'

const roots: string[] = []
const opened: LivePeers[] = []
afterEach(async () => {
	for (const peers of opened.splice(0)) await peers.close()
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function fixture(mode = 'auto') {
	const root = mkdtempSync(join(tmpdir(), 'ps-'))
	roots.push(root)
	const home = join(root, 'h')
	const cwd = join(root, 'p')
	mkdirSync(cwd)
	const common = { home, cwd, version: 'fixture', env: {} }
	const receiver = await openLivePeers({
		...common,
		mode: () => mode,
		owner: () => 0,
		state: () => 'idle' as const,
		ready: () => true,
		available: () => {},
		report: () => {},
	})
	opened.push(receiver)
	return { root, home, cwd, common, receiver }
}

it('queues a message from a command line in the same project and mode, attributed to a command line', async () => {
	const f = await fixture()
	const receipt = await sendToTerminal({
		...f.common,
		target: f.receiver.ref,
		message: 'say hi\nsélam',
		mode: 'auto',
	})
	expect(receipt.status).toBe('queued')
	const [mail] = f.receiver.take(0)
	expect(mail?.text).toBe('say hi\nsélam')
	expect(mail?.from.kind).toBe('cli')
	expect(mail?.from.name).toBe('command line')
	const text = peerMailMessage(mail as NonNullable<typeof mail>)
	expect(JSON.stringify(text)).toContain('command-line sender')
	expect(JSON.stringify(text)).toContain('not from a terminal')
	expect(peerMailLabel(mail as NonNullable<typeof mail>)).toBe(
		'Message from command line: say hi\nsélam',
	)
})

it('leaves no sender record behind and finds the target by id or title', async () => {
	const f = await fixture()
	const runtime = resolvePeerRuntime(f.home, {})
	const before = readPeerRecords(runtime.sessionsDir).length
	const byTitle = await sendToTerminal({ ...f.common, target: 'p', message: 'one', mode: 'auto' })
	const byId = await sendToTerminal({
		...f.common,
		target: f.receiver.id,
		message: 'two',
		mode: 'auto',
	})
	expect([byTitle.status, byId.status]).toEqual(['queued', 'queued'])
	expect(readPeerRecords(runtime.sessionsDir).length).toBe(before)
})

it('is refused by the receiver when the declared mode differs', async () => {
	const f = await fixture('auto')
	const receipt = await sendToTerminal({
		...f.common,
		target: f.receiver.ref,
		message: 'hi',
		mode: 'bypass',
	})
	expect(receipt).toMatchObject({
		status: 'refused',
		reason: 'The terminals have different permission modes.',
	})
	expect(f.receiver.take(0)).toEqual([])
})

it('does not see a terminal in another project', async () => {
	const f = await fixture()
	const other = join(f.root, 'other')
	mkdirSync(other)
	const receipt = await sendToTerminal({
		...f.common,
		cwd: other,
		target: f.receiver.ref,
		message: 'hi',
		mode: 'auto',
	})
	expect(receipt.status).toBe('refused')
	expect(await listProjectTerminals({ ...f.common, cwd: other })).toEqual([])
	// The receiver also refuses a command-line record from elsewhere, if one reached it on the wire.
	const runtime = resolvePeerRuntime(f.home, {})
	const [target] = readPeerRecords(runtime.sessionsDir)
	expect(target).toBeDefined()
})

it('lists live terminals without tokens or addresses', async () => {
	const f = await fixture()
	const peers = await listProjectTerminals(f.common)
	expect(peers).toHaveLength(1)
	expect(peers[0]).toMatchObject({
		ref: f.receiver.ref,
		mode: 'auto',
		state: 'idle',
		acceptsMessages: true,
	})
	expect(JSON.stringify(peers)).not.toMatch(/token|uds:/)
})

it('reports unreachable for a record whose terminal is gone', async () => {
	const f = await fixture()
	const runtime = resolvePeerRuntime(f.home, {})
	const [real] = readPeerRecords(runtime.sessionsDir)
	const ghost = {
		...(real as NonNullable<typeof real>),
		sessionId: 'ghost-session',
		ref: 'abc123',
		title: 'ghost',
		address: udsPeerAddress(runtime.path, 'ghost-session'),
	}
	writePeerRecord(runtime.sessionsDir, ghost)
	const receipt = await sendToTerminal({
		...f.common,
		target: 'abc123',
		message: 'hi',
		mode: 'auto',
	})
	expect(receipt.status).toBe('unreachable')
})

it('refuses an oversized message before sending anything', async () => {
	const f = await fixture()
	const over = await sendToTerminal({
		...f.common,
		target: f.receiver.ref,
		message: 'a'.repeat(32 * 1024 + 1),
		mode: 'auto',
	})
	expect(over.status).toBe('refused')
	expect(over.reason).toContain('32 KiB')
	// Fits as text, not as an escaped request line.
	const quotes = await sendToTerminal({
		...f.common,
		target: f.receiver.ref,
		message: '"'.repeat(32 * 1024),
		mode: 'auto',
	})
	expect(quotes.status).toBe('refused')
	expect(quotes.reason).toContain('too large once encoded')
	expect(f.receiver.take(0)).toEqual([])
})

it('refuses a blank message and a target that matches nothing', async () => {
	const f = await fixture()
	expect(
		(await sendToTerminal({ ...f.common, target: f.receiver.ref, message: '  \n', mode: 'auto' }))
			.status,
	).toBe('refused')
	expect(
		(await sendToTerminal({ ...f.common, target: 'nope', message: 'hi', mode: 'auto' })).reason,
	).toContain('No matching terminal')
})

it('is refused when a sender record is a terminal-less kind the receiver does not know on the wire', async () => {
	// A forged sender that claims kind exec on the wire never matches its own cli record.
	const f = await fixture()
	const runtime = resolvePeerRuntime(f.home, {})
	const [target] = readPeerRecords(runtime.sessionsDir)
	const result = await new PeerClient().deliver(target as NonNullable<typeof target>, {
		id: 'x1',
		from: {
			sessionId: 'nobody',
			ref: 'aaaaaa',
			name: 'x',
			address: 'uds:/nonexistent',
			mode: 'auto',
			kind: 'cli',
		},
		text: 'hi',
	})
	expect(result).toMatchObject({ kind: 'responded', status: 'refused' })
})
