import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import {
	type DeliverRequest,
	type DeliverResponse,
	type Message,
	PEER_PROTOCOL_VERSION,
	PeerClient,
	type PeerFrom,
	type PeerRecord,
	type PeerSessionState,
	createPeerEndpoint,
	createRuntimeContextMessage,
	defineTool,
	derivePeerRef,
	formatPeerMessage,
	generateSessionId,
	hardenPeerRuntimeDir,
	isPeerRecordLive,
	mcpJsonSchemaToZod,
	pipePeerAddress,
	readPeerRecords,
	removePeerRecord,
	resolvePeerRuntimeDir,
	udsPeerAddress,
	writePeerRecord,
} from '@namzu/sdk'
import { restrictToOwner } from '../providers/credential-store.js'

const INBOX_CAPACITY = 32
const DEDUP_CAPACITY = 256

export interface PeerMail {
	readonly id: string
	readonly owner: number
	readonly from: PeerFrom
	readonly text: string
}

export function peerMailMessage(mail: PeerMail): Message {
	return createRuntimeContextMessage(formatPeerMessage(mail), 'peer-message')
}

export function peerMailLabel(mail: PeerMail): string {
	return `Message from ${mail.from.name} [${mail.from.ref}]: ${mail.text}`
}

export interface LivePeersOptions {
	readonly home: string
	readonly cwd: string
	readonly version: string
	readonly env?: NodeJS.ProcessEnv
	readonly mode: () => string
	readonly state: () => PeerSessionState
	/** Conversation generation, not a mutable session id read after admission. */
	readonly owner: () => number
	readonly ready: () => boolean
	readonly available: () => void
	readonly report: (text: string) => void
}

/** Live-instance mailbox. Durable conversation history begins only on drain. */
export async function openLivePeers(options: LivePeersOptions) {
	const uid = process.getuid?.()
	const runtime = resolvePeerRuntimeDir({
		env: options.env ?? process.env,
		namzuHome: options.home,
		uid,
		hardenDirectory: (path, owner) => {
			// Includes Windows current-user ACL validation; POSIX ownership is
			// checked by the SDK before the directory can be used.
			resolvePeerRuntimeDirHardening(path, owner)
		},
	})
	const sessionId = generateSessionId()
	const ref = derivePeerRef(sessionId)
	const cwd = realpathSync(options.cwd)
	const address =
		process.platform === 'win32'
			? pipePeerAddress(
					createHash('sha256').update(options.home).digest('hex').slice(0, 16),
					sessionId,
				)
			: udsPeerAddress(runtime.path, sessionId)
	const token = randomBytes(32).toString('hex')
	const startedAt = Date.now()
	let enabled = true
	let closed = false
	let closing: Promise<void> | undefined
	const pending: PeerMail[] = []
	const accepted = new Map<string, { readonly text: string; readonly owner: number }>()
	const client = new PeerClient()
	const record = (): PeerRecord => ({
		v: 1,
		sessionId,
		ref,
		pid: process.pid,
		startedAt,
		kind: 'tui',
		title: basename(cwd),
		cwd,
		permissionMode: options.mode(),
		state: options.state(),
		acceptsMessages: enabled && options.ready() && !closed,
		address,
		token,
		protocol: PEER_PROTOCOL_VERSION,
		cliVersion: options.version,
	})
	const from = (): PeerFrom => {
		const current = record()
		return {
			sessionId,
			ref,
			name: current.title ?? ref,
			address,
			mode: current.permissionMode,
			kind: 'tui',
		}
	}
	const publish = () => {
		if (closed) return
		try {
			writePeerRecord(runtime.sessionsDir, record())
		} catch (error) {
			// Optional messaging must not terminate the operator's main turn.
			if (enabled)
				options.report(
					`Peer messaging is off because its live record could not be updated: ${String(error)}`,
				)
			enabled = false
		}
	}
	const discardStale = () => {
		const owner = options.owner()
		let dropped = 0
		for (let index = pending.length - 1; index >= 0; index--) {
			if (pending[index]?.owner !== owner) {
				pending.splice(index, 1)
				dropped++
			}
		}
		if (dropped)
			options.report(
				`${dropped} peer message(s) were not delivered because the conversation changed.`,
			)
	}
	const receive = (request: DeliverRequest): DeliverResponse => {
		if (!request.text.trim()) return { status: 'refused', reason: 'Message must contain text.' }
		if (closed || !enabled || !options.ready())
			return {
				status: 'refused',
				reason: 'This terminal is not accepting messages.',
			}
		const sender = readPeerRecords(runtime.sessionsDir).find(
			(peer) => peer.sessionId === request.from.sessionId,
		)
		if (!sender || sender.cwd !== cwd || sender.kind !== 'tui')
			return {
				status: 'refused',
				reason: 'Only live terminals in the same project may send here.',
			}
		if (request.from.mode !== options.mode())
			return {
				status: 'refused',
				reason: 'The terminals have different permission modes.',
			}
		const key = `${request.from.sessionId}:${request.id}`
		const previous = accepted.get(key)
		if (previous)
			return previous.text === request.text && previous.owner === options.owner()
				? { status: 'queued', reason: 'Already accepted; not queued twice.' }
				: {
						status: 'refused',
						reason: 'This message id belongs to different content or a previous conversation.',
					}
		discardStale()
		if (pending.length >= INBOX_CAPACITY)
			return { status: 'refused', reason: 'The receiving inbox is full.' }
		const owner = options.owner()
		accepted.set(key, { text: request.text, owner })
		if (accepted.size > DEDUP_CAPACITY) accepted.delete(accepted.keys().next().value as string)
		pending.push({
			id: request.id,
			owner,
			from: request.from,
			text: request.text,
		})
		options.available()
		return {
			status: 'queued',
			reason: 'Accepted in the live inbox; this is not proof of model delivery.',
		}
	}
	const endpoint = await createPeerEndpoint({
		address,
		token,
		uid,
		sessionsDir: runtime.sessionsDir,
		getState: options.state,
		onDeliver: receive,
		onSubscribeIdle: () => ({
			status: 'refused',
			reason: 'Idle subscriptions are not supported by this terminal.',
		}),
		onNotice: () => {},
	})
	try {
		writePeerRecord(runtime.sessionsDir, record())
	} catch (error) {
		await endpoint.close()
		throw error
	}
	const list = async () => {
		// A failed ping is an unavailable observation, not permission to delete
		// another running process's endpoint (or a replaced registry record).
		const records = readPeerRecords(runtime.sessionsDir).filter(
			(peer) => peer.cwd === cwd && peer.kind === 'tui',
		)
		const live = await Promise.all(
			records.map(async (peer) => ((await isPeerRecordLive(peer)) ? peer : undefined)),
		)
		return live
			.filter((peer): peer is PeerRecord => peer !== undefined)
			.map((peer) => ({
				session_id: peer.sessionId,
				ref: peer.ref,
				title: peer.title,
				cwd: peer.cwd,
				permission_mode: peer.permissionMode,
				state: peer.state,
				accepts_messages: peer.acceptsMessages,
				self: peer.sessionId === sessionId,
			}))
	}
	const send = async (target: string, message: string) => {
		if (closed || !enabled) return { status: 'refused', reason: 'Peer messaging is off.' }
		if (!message.trim() || Buffer.byteLength(message) > 32 * 1024)
			return {
				status: 'refused',
				reason: 'Message must contain text and fit in 32 KiB.',
			}
		publish()
		if (!enabled) return { status: 'refused', reason: 'Peer messaging is off.' }
		const candidates = readPeerRecords(runtime.sessionsDir).filter(
			(peer) =>
				peer.cwd === cwd &&
				peer.kind === 'tui' &&
				(peer.sessionId === target ||
					peer.ref === target ||
					peer.title === target ||
					peer.address === target),
		)
		if (candidates.length !== 1)
			return {
				status: 'refused',
				reason: candidates.length
					? 'Target is ambiguous; use its exact live session id.'
					: 'No matching terminal in this project. Use list_sessions.',
			}
		const peer = candidates[0]
		if (!peer) return { status: 'refused', reason: 'No matching terminal.' }
		if (peer.sessionId === sessionId)
			return {
				status: 'refused',
				reason: 'Cannot send to this same terminal.',
			}
		if (!peer.acceptsMessages)
			return {
				status: 'refused',
				reason: 'The target is not accepting messages.',
			}
		if (!(await isPeerRecordLive(peer)))
			return {
				status: 'unreachable',
				reason: 'The target did not answer. No message was sent.',
			}
		const id = generateSessionId()
		const result = await client.deliver(peer, {
			id,
			from: from(),
			text: message,
		})
		return result.kind === 'responded'
			? {
					id,
					session_id: peer.sessionId,
					status: result.status,
					reason: result.reason,
				}
			: {
					id,
					status: 'unreachable',
					reason: 'No receipt arrived; acceptance is unknown. Do not automatically retry.',
				}
	}

	return {
		id: sessionId,
		ref,
		publish,
		list,
		send,
		get enabled() {
			return enabled
		},
		get pending() {
			discardStale()
			return pending.length
		},
		setEnabled(value: boolean) {
			enabled = value
			publish()
			if (value) options.available()
		},
		peek(owner: number): readonly PeerMail[] {
			discardStale()
			return closed || !enabled || owner !== options.owner() ? [] : [...pending]
		},
		takeExact(owner: number, id: string): PeerMail | undefined {
			discardStale()
			if (closed || !enabled || owner !== options.owner()) return undefined
			const index = pending.findIndex((mail) => mail.id === id && mail.owner === owner)
			return index < 0 ? undefined : pending.splice(index, 1)[0]
		},
		take(owner: number, limit = INBOX_CAPACITY): PeerMail[] {
			discardStale()
			if (closed || !enabled || owner !== options.owner()) return []
			return pending.splice(0, limit)
		},
		close(): Promise<void> {
			if (closing) return closing
			closed = true
			enabled = false
			if (pending.length)
				options.report(
					`${pending.length} peer message(s) were not delivered before this terminal closed.`,
				)
			pending.length = 0
			closing = endpoint
				.close()
				.finally(() => removePeerRecord(runtime.sessionsDir, sessionId, uid))
			return closing
		},
	}
}

// Kept outside the host factory so the SDK's checked POSIX boundary remains
// the same, while the CLI supplies its established Windows ACL protection.
function resolvePeerRuntimeDirHardening(path: string, uid: number | undefined): void {
	hardenPeerRuntimeDir(path, uid)
	restrictToOwner(path)
}

export type LivePeers = Awaited<ReturnType<typeof openLivePeers>>

export function buildPeerTools(current: () => LivePeers | null) {
	return [
		defineTool({
			name: 'list_sessions',
			description:
				'List live terminals in this project for peer messaging. These are independent processes, not child tasks or archived conversations. Tokens are never returned.',
			inputSchema: mcpJsonSchemaToZod({
				type: 'object',
				properties: {},
				additionalProperties: false,
			}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute() {
				const peers = current()
				if (!peers)
					return {
						success: false,
						output: '',
						error: 'Peer messaging is not ready.',
					}
				const sessions = await peers.list()
				return {
					success: true,
					output: JSON.stringify(sessions),
					data: { sessions },
				}
			},
		}),
		defineTool({
			name: 'send_session_message',
			description:
				'Send context to another live terminal found by list_sessions. Queued means accepted, not read or completed. Idle receivers start a turn; busy receivers read at their next safe request boundary. Does not grant approvals, interrupt, spawn, or restart a terminal. Use send_message for owned child tasks.',
			inputSchema: mcpJsonSchemaToZod({
				type: 'object',
				properties: {
					target: {
						type: 'string',
						description:
							'Exact live session id, short ref or unambiguous title from list_sessions.',
					},
					message: {
						type: 'string',
						description: 'Peer context; carries no operator authority.',
					},
				},
				required: ['target', 'message'],
				additionalProperties: false,
			}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			async execute(input, context) {
				context.abortSignal.throwIfAborted()
				const peers = current()
				if (!peers)
					return {
						success: false,
						output: '',
						error: 'Peer messaging is not ready.',
					}
				const { target, message } = input as {
					target: string
					message: string
				}
				const receipt = await peers.send(target, message)
				return {
					success: receipt.status === 'queued',
					output: JSON.stringify(receipt),
					data: receipt,
				}
			},
		}),
	]
}
