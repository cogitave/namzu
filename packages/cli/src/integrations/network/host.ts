import { createHash, randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import {
	type LocalSession,
	type NetworkHost,
	PEER_PROTOCOL_VERSION,
	PeerClient,
	type PeerFrom,
	type PeerRecord,
	type RemoteMail,
	createPeerEndpoint,
	derivePeerRef,
	generateSessionId,
	isPeerRecordLive,
	pipePeerAddress,
	readPeerRecords,
	removePeerRecord,
	sanitizeName,
	sessionDisplayName,
	udsPeerAddress,
	writePeerRecord,
} from '@namzu/sdk'
import type { RoleFileStore } from './role-store.js'

/**
 * The network service's view of this machine: the live terminals in the peer registry, and the way mail
 * and roles reach them. Mail reaches a terminal through a `net` bridge record this process owns: the same
 * local channel terminals use among themselves, and the only sender a terminal accepts remote mail from.
 */

export interface NetBridge {
	readonly from: PeerFrom
	deliver(
		record: PeerRecord,
		mail: RemoteMail,
	): Promise<{ status: 'queued' | 'refused'; reason?: string }>
	close(): Promise<void>
}

export async function openNetBridge(options: {
	readonly home: string
	readonly runtimeDir: string
	readonly sessionsDir: string
	readonly version: string
}): Promise<NetBridge> {
	const uid = process.getuid?.()
	const sessionId = generateSessionId()
	const ref = derivePeerRef(sessionId)
	const address =
		process.platform === 'win32'
			? pipePeerAddress(
					createHash('sha256').update(options.home).digest('hex').slice(0, 16),
					sessionId,
				)
			: udsPeerAddress(options.runtimeDir, sessionId)
	const token = randomBytes(32).toString('hex')
	const from: PeerFrom = { sessionId, ref, name: 'network', address, mode: 'net', kind: 'net' }
	const endpoint = await createPeerEndpoint({
		address,
		token,
		uid,
		sessionsDir: options.sessionsDir,
		getState: () => 'idle',
		onDeliver: () => ({ status: 'refused', reason: 'The network bridge takes no messages.' }),
		onSubscribeIdle: () => ({ status: 'refused', reason: 'The network bridge takes no messages.' }),
		onNotice: () => {},
	})
	try {
		writePeerRecord(options.sessionsDir, {
			v: 1,
			sessionId,
			ref,
			pid: process.pid,
			startedAt: Date.now(),
			kind: 'net',
			title: 'network',
			cwd: options.home,
			permissionMode: 'net',
			state: 'idle',
			acceptsMessages: false,
			address,
			token,
			protocol: PEER_PROTOCOL_VERSION,
			cliVersion: options.version,
		})
	} catch (error) {
		await endpoint.close()
		throw error
	}
	const client = new PeerClient()
	return {
		from,
		async deliver(record, mail) {
			const result = await client.deliver(record, {
				id: mail.id,
				from,
				text: mail.text,
				...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
				remote: {
					machineId: mail.from.machineId,
					machineName: sanitizeName(mail.from.machineName, 80) || 'machine',
					sessionName: sanitizeName(mail.from.sessionName, 80) || 'session',
					sessionRef: mail.from.sessionRef,
					mode: mail.from.mode,
					hops: mail.hops,
					...(mail.allowedOnce ? { allowedOnce: true } : {}),
				},
			})
			if (result.kind !== 'responded')
				return { status: 'refused', reason: 'That session did not answer.' }
			return result.status === 'queued'
				? { status: 'queued', ...(result.reason ? { reason: result.reason } : {}) }
				: { status: 'refused', reason: result.reason ?? 'That session did not take the message.' }
		},
		async close() {
			await endpoint.close()
			try {
				removePeerRecord(options.sessionsDir, sessionId, uid)
			} catch {
				// a stale record of a dead pid is ignored by every reader
			}
		},
	}
}

const STATE: Readonly<Record<PeerRecord['state'], LocalSession['state']>> = {
	idle: 'idle',
	busy: 'running',
	'awaiting-permission': 'awaiting-approval',
}

/** The folder name a roster shows: one safe line, never a full path. */
export function folderName(cwd: string): string {
	return sanitizeName(basename(cwd), 120)
}

export function createNetworkHost(options: {
	readonly sessionsDir: string
	readonly bridge: NetBridge
	readonly roles: RoleFileStore
	readonly isAlive: (pid: number) => boolean
	readonly report?: (text: string) => void
}): NetworkHost {
	const liveRecords = () =>
		readPeerRecords(options.sessionsDir).filter(
			(peer) => peer.kind === 'tui' && options.isAlive(peer.pid),
		)
	return {
		listLocalSessions() {
			return liveRecords().map((peer) => {
				// The role file is the truth: a role set a moment ago shows before the terminal has noticed it.
				const stored =
					(peer.conversationId ? options.roles.read(peer.conversationId) : undefined) ??
					options.roles.read(`ref:${peer.ref}`)
				return {
					ref: peer.ref,
					name: sanitizeName(
						sessionDisplayName({
							sessionId: peer.sessionId,
							...(peer.title ? { title: peer.title } : {}),
						}),
						80,
					),
					folder: folderName(peer.cwd),
					state: STATE[peer.state],
					mode: peer.permissionMode,
					...(stored ? { role: stored.role } : {}),
					acceptsMessages: peer.acceptsMessages,
					kind: 'tui' as const,
					...(peer.conversationId ? { conversationId: peer.conversationId } : {}),
					bypass: peer.permissionMode === 'bypass',
				}
			})
		},
		async deliverLocal(sessionRef, mail) {
			const record = liveRecords().find((peer) => peer.ref === sessionRef)
			if (!record) return { status: 'refused', reason: 'That session is not running here.' }
			if (!record.acceptsMessages)
				return { status: 'refused', reason: 'That terminal is not taking messages.' }
			if (!(await isPeerRecordLive(record)))
				return { status: 'refused', reason: 'That session did not answer.' }
			return options.bridge.deliver(record, mail)
		},
		setLocalRole(sessionRef, role, info) {
			const record = liveRecords().find((peer) => peer.ref === sessionRef)
			if (!record) return false
			return options.roles.write(
				record.conversationId ?? `ref:${record.ref}`,
				role === null ? null : { role, by: info.by, at: info.at },
			)
		},
		report: options.report,
	}
}
