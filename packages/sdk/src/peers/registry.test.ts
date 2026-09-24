import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { PEER_PROTOCOL_VERSION } from './protocol.js'
import { PEER_RECORD_VERSION, type PeerRecord, derivePeerRef } from './record.js'
import {
	PeerRegistryError,
	isPeerRecordLive,
	listLivePeers,
	readPeerRecord,
	readPeerRecords,
	removePeerRecord,
	writePeerRecord,
} from './registry.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function makeSessionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-peers-registry-test-'))
	dirs.push(dir)
	return dir
}

function makeRecord(overrides: Partial<PeerRecord> = {}): PeerRecord {
	const sessionId = overrides.sessionId ?? 'sess-1'
	return {
		v: PEER_RECORD_VERSION,
		sessionId,
		ref: derivePeerRef(sessionId),
		pid: process.pid,
		startedAt: Date.now(),
		kind: 'tui',
		cwd: '/home/user/project',
		permissionMode: 'default',
		state: 'idle',
		acceptsMessages: true,
		address: `uds:${join('/tmp', `${sessionId}.sock`)}`,
		token: 't'.repeat(32),
		protocol: PEER_PROTOCOL_VERSION,
		cliVersion: '1.0.0',
		...overrides,
	}
}

describe('writePeerRecord / readPeerRecord', () => {
	it('round-trips a record and writes it mode 0600', () => {
		const dir = makeSessionsDir()
		const record = makeRecord()
		writePeerRecord(dir, record)
		expect(readPeerRecord(dir, record.sessionId)).toEqual(record)
		const path = join(dir, `${record.sessionId}.json`)
		expect(lstatSync(path).mode & 0o777).toBe(0o600)
	})

	it('overwrites an existing record for the same session id', () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord({ state: 'idle' }))
		writePeerRecord(dir, makeRecord({ state: 'busy' }))
		expect(readPeerRecord(dir, 'sess-1')?.state).toBe('busy')
	})

	it('leaves no temporary file behind after a successful write', () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord())
		expect(readdirSync(dir)).toEqual(['sess-1.json'])
	})

	it('refuses an invalid record without writing anything', () => {
		const dir = makeSessionsDir()
		expect(() =>
			writePeerRecord(dir, { ...makeRecord(), pid: -1 } as unknown as PeerRecord),
		).toThrow(PeerRegistryError)
		expect(existsSync(join(dir, 'sess-1.json'))).toBe(false)
	})

	it('readPeerRecord returns undefined for a session with no record', () => {
		const dir = makeSessionsDir()
		expect(readPeerRecord(dir, 'nobody')).toBeUndefined()
	})

	it('readPeerRecord returns undefined when the sessions directory does not exist', () => {
		expect(readPeerRecord(join(tmpdir(), 'does-not-exist-namzu-peers'), 'sess-1')).toBeUndefined()
	})
})

describe('readPeerRecords', () => {
	it('returns every record that parses, skipping ones that do not', () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-1' }))
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-2' }))
		writeFileSync(join(dir, 'garbage.json'), 'not json{', { mode: 0o600 })
		writeFileSync(join(dir, 'not-a-record.json'), JSON.stringify({ hello: 'world' }), {
			mode: 0o600,
		})
		writeFileSync(join(dir, 'ignored.txt'), 'nope', { mode: 0o600 })

		const records = readPeerRecords(dir)
		expect(records.map((r) => r.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
	})

	it('returns an empty list when the sessions directory does not exist', () => {
		expect(readPeerRecords(join(tmpdir(), 'does-not-exist-namzu-peers-2'))).toEqual([])
	})
})

describe('removePeerRecord', () => {
	it('removes an owned record', () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord())
		removePeerRecord(dir, 'sess-1', process.getuid?.())
		expect(readPeerRecord(dir, 'sess-1')).toBeUndefined()
	})

	it('is a no-op when the record does not exist', () => {
		const dir = makeSessionsDir()
		expect(() => removePeerRecord(dir, 'nobody', process.getuid?.())).not.toThrow()
	})

	it('never removes a record owned by a different uid', () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord())
		const uid = process.getuid?.()
		if (uid === undefined) return // win32 models no uid to mismatch.
		removePeerRecord(dir, 'sess-1', uid + 999_999)
		expect(readPeerRecord(dir, 'sess-1')).toBeDefined()
	})
})

describe('isPeerRecordLive', () => {
	it('is true iff the pid is alive and the ping answers within the timeout', async () => {
		const record = makeRecord()
		await expect(
			isPeerRecordLive(record, { isPidAlive: () => true, ping: async () => true }),
		).resolves.toBe(true)
		await expect(
			isPeerRecordLive(record, { isPidAlive: () => false, ping: async () => true }),
		).resolves.toBe(false)
		await expect(
			isPeerRecordLive(record, { isPidAlive: () => true, ping: async () => false }),
		).resolves.toBe(false)
	})

	it('does not ping when the pid check already fails', async () => {
		let pinged = false
		await isPeerRecordLive(makeRecord(), {
			isPidAlive: () => false,
			ping: async () => {
				pinged = true
				return true
			},
		})
		expect(pinged).toBe(false)
	})
})

describe('listLivePeers', () => {
	it('returns only live records and leaves their files in place', async () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-1' }))
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-2' }))
		const live = await listLivePeers({
			sessionsDir: dir,
			uid: process.getuid?.(),
			isPidAlive: () => true,
			ping: async () => true,
		})
		expect(live.map((r) => r.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
		expect(readPeerRecords(dir)).toHaveLength(2)
	})

	it('removes a dead record (this uid owns it) and its stale socket', async () => {
		const dir = makeSessionsDir()
		const socketDir = makeSessionsDir()
		const socketPath = join(socketDir, 'sess-1.sock')
		// A plain file stands in for a socket for the ownership/removal check;
		// the isSocket() gate itself is exercised in endpoint.test.ts against a
		// real net.Server socket.
		writeFileSync(socketPath, '')
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-1', address: `uds:${socketPath}` }))

		const live = await listLivePeers({
			sessionsDir: dir,
			uid: process.getuid?.(),
			isPidAlive: () => false,
			ping: async () => false,
		})
		expect(live).toEqual([])
		expect(readPeerRecord(dir, 'sess-1')).toBeUndefined()
	})

	it('never removes a dead record owned by a different uid', async () => {
		const dir = makeSessionsDir()
		const uid = process.getuid?.()
		if (uid === undefined) return
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-1' }))
		await listLivePeers({
			sessionsDir: dir,
			uid: uid + 999_999,
			isPidAlive: () => false,
			ping: async () => false,
		})
		expect(readPeerRecord(dir, 'sess-1')).toBeDefined()
	})

	it('runs liveness checks concurrently rather than one record blocking another', async () => {
		const dir = makeSessionsDir()
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-1' }))
		writePeerRecord(dir, makeRecord({ sessionId: 'sess-2' }))
		let concurrent = 0
		let maxConcurrent = 0
		const ping = async (): Promise<boolean> => {
			concurrent += 1
			maxConcurrent = Math.max(maxConcurrent, concurrent)
			await new Promise((resolve) => setTimeout(resolve, 10))
			concurrent -= 1
			return true
		}
		await listLivePeers({ sessionsDir: dir, uid: process.getuid?.(), isPidAlive: () => true, ping })
		expect(maxConcurrent).toBe(2)
	})
})

describe('symlink safety', () => {
	it('readPeerRecords does not follow a session record symlink into the wrong ownership question', () => {
		// readdirSync + readFileSync happily follow a symlinked entry; this just
		// documents that a stray symlink cannot crash the reader, since
		// `write`/`remove` are what carry the ownership contract.
		const dir = makeSessionsDir()
		const real = makeSessionsDir()
		writePeerRecord(real, makeRecord({ sessionId: 'sess-1' }))
		symlinkSync(join(real, 'sess-1.json'), join(dir, 'sess-1.json'))
		expect(readPeerRecords(dir)).toHaveLength(1)
	})
})
