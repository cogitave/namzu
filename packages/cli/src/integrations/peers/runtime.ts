import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import {
	type DeliverRequest,
	type DeliverResponse,
	HoldQueue,
	type Message,
	PEER_PROTOCOL_VERSION,
	PEER_TRAIL_MAX,
	PeerClient,
	type PeerExchange,
	type PeerFrom,
	type PeerRecord,
	type PeerSessionState,
	type RemoteOrigin,
	createPeerEndpoint,
	createRuntimeContextMessage,
	decideMail,
	defineTool,
	derivePeerRef,
	formatPeerMessage,
	formatRoleContext,
	generateSessionId,
	hardenPeerRuntimeDir,
	isPeerRecordLive,
	mcpJsonSchemaToZod,
	pipePeerAddress,
	readPeerRecords,
	removePeerRecord,
	resolvePeerRuntimeDir,
	systemClock,
	udsPeerAddress,
	writePeerRecord,
} from '@namzu/sdk'
import type { AuditEntry, NetworkClock } from '@namzu/sdk'
import { permissionModeWord, textHash } from '@namzu/sdk'
import { sanitizeLine } from '../notifications/desktop/sanitize.js'
import { restrictToOwner } from '../providers/credential-store.js'
import { processStartedBySession, runsUnderAny } from './process-ancestry.js'

const INBOX_CAPACITY = 32
const DEDUP_CAPACITY = 256

export interface PeerMail {
	readonly id: string
	readonly owner: number
	readonly from: PeerFrom
	readonly text: string
	/** Set when the message crossed machines: where it really came from (the bridge only carried it). */
	readonly remote?: RemoteOrigin
	/**
	 * The permission mode this terminal was in when it took the message in. Taking it in is not a grant to
	 * run the context under a later mode, so a changed mode discards it. A person's message has none.
	 */
	readonly acceptedMode?: string
}

export function peerMailMessage(mail: PeerMail): Message {
	return createRuntimeContextMessage(
		formatPeerMessage({
			id: mail.id,
			from: mail.from,
			text: mail.text,
			...(mail.remote
				? { machine: { name: mail.remote.machineName, id: mail.remote.machineId } }
				: {}),
		}),
		mail.from.kind === 'person' ? 'person-message' : 'peer-message',
	)
}

/** A message waiting for the person: another terminal's whose mode differs, or any mail while this terminal is in bypass. */
export interface HeldLocalMail {
	readonly id: string
	readonly from: PeerFrom
	readonly text: string
	readonly owner: number
	readonly reason: string
}

/** What a screen shows of a held message. */
export interface HeldLocalView {
	readonly id: string
	readonly fromName: string
	readonly fromRef: string
	readonly reason: string
	readonly text: string
	readonly expiresAt: number
}

/** A role another machine (or the person) gave this session. Descriptive; it grants nothing. */
export interface SessionRole {
	readonly role: string
	readonly by: string
	readonly at: number
}

/** The longest a person's message is drawn on its one transcript line; the model and the log hold all of it. */
const PERSON_LABEL_MAX = 400

/**
 * The transcript line for mail. The words are the kernel's; the sender's text is data after them: for the
 * person's message it is made one safe line (no line break to start a line of its own, no control or
 * direction character), so it cannot pose as a kernel line.
 */
export function peerMailLabel(mail: PeerMail): string {
	if (mail.from.kind === 'person')
		return `Message from another terminal of this account: ${sanitizeLine(mail.text, PERSON_LABEL_MAX)}`
	if (mail.remote)
		return `Message from ${sanitizeLine(mail.remote.sessionName, 80)} on ${sanitizeLine(mail.remote.machineName, 80)}: ${mail.text}`
	return `Message from ${mail.from.name}: ${mail.text}`
}

/** What a terminal needs of the Namzu network to list and message sessions on other machines. */
export interface NetworkLink {
	/** The roster as the model's `list_sessions` shows it; undefined while the network is off. */
	list(selfRef: string): Promise<readonly Record<string, unknown>[] | undefined>
	/** Send to `target` (`name`, `machine/name` or `[ref]`) on another machine. `undefined` when the target is not on the network. */
	send(
		target: string,
		text: string,
		from: { readonly sessionRef: string; readonly sessionName: string; readonly mode: string },
	): Promise<
		| {
				readonly id?: string
				readonly status: 'queued' | 'held' | 'refused'
				readonly reason?: string
		  }
		| undefined
	>
	/** A message from another machine was taken into a turn here: tell its sender. Never throws. */
	delivered?(machineId: string, mailId: string, sessionRef: string): Promise<void>
	/** Give a session or machine on any member a role; names resolve against the roster. */
	setRole(
		target: string,
		role: string | null,
	): Promise<{ readonly status: 'applied' | 'refused'; readonly reason?: string }>
}

/** Roles of sessions on this machine, kept across a resume. Reads never throw. */
export interface SessionRoleStore {
	read(key: string): SessionRole | undefined
}

export interface LivePeersOptions {
	/** The parent of a process, for telling a person's terminal from a tool; tests supply their own. */
	readonly parentPid?: (pid: number) => number | undefined
	/** Whether a process started with the session marker in its environment; tests supply their own. */
	readonly startedBySession?: (pid: number) => boolean
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
	/** The slot a workspaces host launched this terminal under. */
	readonly hostSlot?: string
	/** The conversation this terminal is on, once it has one. */
	readonly conversation?: () => string | undefined
	/**
	 * What the conversation is called (the name a person gave it, else the one the
	 * small model wrote). It becomes the session's display name, so two sessions in
	 * one folder tell each other apart by more than a ref.
	 */
	readonly name?: () => string | undefined
	/** The non-default account label the conversation is bound to. */
	readonly account?: () => string | undefined
	/** Clock for hold expiry; tests supply a manual one. */
	readonly clock?: NetworkClock
	/** The mode that skips permission prompts; a terminal in it holds every message from another session. */
	readonly bypass?: () => boolean
	/** Where a role set from another terminal or machine is kept, keyed by the conversation (else the ref). */
	readonly roles?: SessionRoleStore
	/** The Namzu network on this machine, once it runs; absent or returning undefined means no other machines. */
	readonly network?: () => NetworkLink | undefined
	/**
	 * Where a decision about mail from another session on this machine is written down (the Namzu network's
	 * audit log): who sent it, what was decided, a hash and a size, never the words. Absent: nothing is written.
	 */
	readonly audit?: (entry: Omit<AuditEntry, 'at'>) => void
	/** True while the bound account is out of allowance. */
	readonly limited?: () => boolean
	/** When the spent allowance is expected back (epoch ms), if known. */
	readonly limitedUntil?: () => number | undefined
}

/** The longest display name a record carries: it is drawn in a narrow sidebar and in a message header. */
const TITLE_MAX = 40

/** Whether two recorded folders are the same real folder; one that cannot be resolved counts as different. */
function sameFolder(a: string, b: string): boolean {
	try {
		return realpathSync.native(a) === realpathSync.native(b)
	} catch {
		return false
	}
}

/** The session's display name: its conversation's name as one safe line, else the folder's. */
export function displayTitle(name: string | undefined, cwd: string): string {
	const line = name === undefined ? '' : sanitizeLine(name, TITLE_MAX)
	return line === '' ? basename(cwd) : line
}

/** The directory live-session records and sockets are kept in, hardened for the current user. */
export function resolvePeerRuntime(home: string, env: NodeJS.ProcessEnv = process.env) {
	return resolvePeerRuntimeDir({
		env,
		namzuHome: home,
		uid: process.getuid?.(),
		hardenDirectory: (path, owner) => {
			// Includes Windows current-user ACL validation; POSIX ownership is
			// checked by the SDK before the directory can be used.
			resolvePeerRuntimeDirHardening(path, owner)
		},
	})
}

/** Live-instance mailbox. Durable conversation history begins only on drain. */
export async function openLivePeers(options: LivePeersOptions) {
	const uid = process.getuid?.()
	const runtime = resolvePeerRuntime(options.home, options.env ?? process.env)
	const sessionId = generateSessionId()
	const ref = derivePeerRef(sessionId)
	const cwd = realpathSync.native(options.cwd)
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
	/** The latest exchanges with other terminals, for a host that draws who is talking to whom. Who, which way, when: never text. */
	const trail: PeerExchange[] = []
	const noteExchange = (peerRef: string, dir: 'in' | 'out') => {
		trail.push({ with: peerRef, dir, at: Date.now() })
		if (trail.length > PEER_TRAIL_MAX) trail.splice(0, trail.length - PEER_TRAIL_MAX)
		publish()
	}
	const pending: PeerMail[] = []
	const accepted = new Map<string, { readonly text: string; readonly owner: number }>()
	const client = new PeerClient()
	const clock = options.clock ?? systemClock
	/** Mail sent from here that the other side held: its outcome is told to the person when it arrives. */
	const sentHeld = new Set<string>()
	let role: SessionRole | undefined
	let roleRendered: { readonly of: SessionRole; readonly text: string } | undefined
	const readStoredRole = (): SessionRole | undefined => {
		const conversation = options.conversation?.()
		return (
			(conversation ? options.roles?.read(conversation) : undefined) ??
			options.roles?.read(`ref:${ref}`)
		)
	}
	const bypassNow = () => options.bypass?.() === true || options.mode() === 'bypass'
	const auditMail = (
		event: AuditEntry['event'],
		from: { readonly ref: string; readonly name: string },
		text: string,
		reason?: string,
	) => {
		try {
			options.audit?.({
				event,
				session: ref,
				decision: `from ${sanitizeLine(from.name, 40)} [${from.ref}]`,
				bytes: Buffer.byteLength(text, 'utf8'),
				textHash: textHash(text),
				...(reason ? { reason } : {}),
			})
		} catch {
			// the audit log never stops a message
		}
	}
	const held = new HoldQueue<HeldLocalMail>({
		clock,
		onExpire: (_id, item) => {
			auditMail('mail_expired', item.from, item.text)
			tellOutcome(item, 'expired')
			options.report(`A held message from ${item.from.name} expired without an answer.`)
		},
	})
	const record = (): PeerRecord => ({
		v: 1,
		sessionId,
		ref,
		pid: process.pid,
		startedAt,
		kind: 'tui',
		title: displayTitle(options.name?.(), cwd),
		cwd,
		permissionMode: options.mode(),
		state: options.state(),
		acceptsMessages: enabled && options.ready() && !closed,
		address,
		token,
		protocol: PEER_PROTOCOL_VERSION,
		cliVersion: options.version,
		...(options.hostSlot ? { hostSlot: options.hostSlot } : {}),
		...(options.conversation?.() ? { conversationId: options.conversation() as string } : {}),
		...(options.account?.() ? { account: options.account() as string } : {}),
		...(options.limited?.() ? { limited: true } : {}),
		...(options.limited?.() && options.limitedUntil?.()
			? { limitedUntil: options.limitedUntil() as number }
			: {}),
		// Only a terminal inside a workspaces host writes it, like the other host-facing fields, so a
		// plain terminal stays readable by builds that predate it.
		...(options.hostSlot && trail.length > 0 ? { trail: [...trail] } : {}),
		...(role ? { role: role.role, roleBy: role.by, roleAt: role.at } : {}),
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
		syncRole()
		discardStale()
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
		const mode = options.mode()
		let dropped = 0
		let modeChanged = 0
		for (let index = pending.length - 1; index >= 0; index--) {
			const mail = pending[index]
			if (!mail) continue
			if (mail.owner !== owner) {
				pending.splice(index, 1)
				dropped++
			} else if (mail.from.kind !== 'person' && (mail.acceptedMode ?? mail.from.mode) !== mode) {
				// Admission is not a grant to run this context under a later mode.
				// Recheck at peek AND consumption: a scheduled idle wake can outlive
				// a mode change. Discard rather than inventing approval or replay.
				pending.splice(index, 1)
				modeChanged++
			}
		}
		if (dropped)
			options.report(
				`${dropped} peer message(s) were not delivered because the conversation changed.`,
			)
		if (modeChanged)
			options.report(
				`${modeChanged} peer message(s) were not delivered because the permission mode changed.`,
			)
	}
	/** Tell the sender of a held message how it ended; a sender that has gone away simply hears nothing. */
	const tellOutcome = (
		item: Pick<HeldLocalMail, 'id' | 'from'>,
		outcome: 'queued' | 'refused' | 'expired',
	) => {
		const target = readPeerRecords(runtime.sessionsDir).find(
			(peer) => peer.sessionId === item.from.sessionId && peer.kind === 'tui',
		)
		if (!target) return
		const current = from()
		void client
			.notice(target, {
				from: current,
				kind: 'delivery',
				about: { sessionId, name: current.name, ref },
				outcome,
				detail: item.id,
			})
			.catch(() => {})
	}
	/** Put accepted mail in the inbox: one place, so a held message that is allowed enters exactly as a new one. */
	const admit = (request: DeliverRequest, fromIdentity: PeerFrom): DeliverResponse => {
		const key = `${request.remote ? `${request.remote.machineId}:${request.remote.sessionRef}` : request.from.sessionId}:${request.id}`
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
			from: fromIdentity,
			text: request.text,
			acceptedMode: options.mode(),
			...(request.remote ? { remote: request.remote } : {}),
		})
		options.available()
		noteExchange(fromIdentity.ref, 'in')
		return {
			status: 'queued',
			reason: 'Accepted in the live inbox; this is not proof of model delivery.',
		}
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
		if (request.remote) {
			// Mail from another machine arrives only through this machine's network bridge (a `net` record the
			// endpoint verified). The network service already decided to deliver it: this terminal only checks
			// that the bridge is who it says and that the mail is for the conversation it is on.
			if (sender?.kind !== 'net')
				return {
					status: 'refused',
					reason: 'Only the network bridge may carry mail from another machine.',
				}
			// The bridge is a process a terminal started: never one a session's own tools started. A record
			// written by a command a model ran descends from a terminal, so it cannot pose as the bridge.
			const terminals = new Set<number>([process.pid])
			for (const peer of readPeerRecords(runtime.sessionsDir))
				if (peer.kind === 'tui') terminals.add(peer.pid)
			if (runsUnderAny(sender.pid, terminals, options.parentPid))
				return {
					status: 'refused',
					reason: 'Only the network bridge may carry mail from another machine.',
				}
			// The service judged by the mode this terminal last published. A switch since then (to bypass, or
			// to a mode the sender does not share) is seen here, and the mail is not taken in.
			if (!request.remote.allowedOnce) {
				const recheck = decideMail({
					scope: 'local',
					text: request.text,
					hops: 0,
					receiver: {
						mode: options.mode(),
						bypass: bypassNow(),
						accepting: true,
						setting: 'members',
					},
					sender: { claimedMode: request.remote.mode, vouchedMode: request.remote.mode },
					rateOk: true,
					pairCount: 0,
				})
				if (recheck.action !== 'accept')
					return {
						status: 'refused',
						reason:
							'This terminal changed its permission mode while the message was on its way; send it again.',
					}
			}
			return admit(request, {
				sessionId: `${request.remote.machineId}:${request.remote.sessionRef}`,
				ref: request.remote.sessionRef,
				name: request.remote.sessionName,
				address: request.from.address,
				mode: request.remote.mode,
				kind: 'net',
			})
		}
		// A command-line sender (`namzu peers send`) is a verified record like a terminal's, but
		// listed apart: its mail says so, and it never takes mail.
		const person = sender?.kind === 'person'
		// The person's own message names the conversation it meant, so it is checked by what it
		// is addressed to, not by the folder: a terminal in another folder can be the right one.
		if (!sender || (sender.kind !== 'tui' && sender.kind !== 'cli' && !person))
			return {
				status: 'refused',
				reason: 'Only live Namzu terminals of this user on this computer may send here.',
			}
		if (person) {
			// A person's message comes from outside every Namzu session. A command a model ran through its
			// shell descends from the terminal that runs it, so it is not the person, whatever it claims.
			const sessions = new Set<number>([process.pid])
			for (const peer of readPeerRecords(runtime.sessionsDir))
				if (peer.kind === 'tui') sessions.add(peer.pid)
			if (
				runsUnderAny(sender.pid, sessions, options.parentPid) ||
				(options.startedBySession ?? processStartedBySession)(sender.pid)
			)
				return {
					status: 'refused',
					reason:
						'This was sent from inside a Namzu session, by a tool or an agent, not by a person at another terminal.',
				}
			if (!request.conversation || request.conversation !== options.conversation?.())
				return {
					status: 'refused',
					reason: 'This terminal is not on that conversation now.',
				}
			return admit(request, request.from)
		}
		// The person has no permission mode to match. An agent's mail that does not match, or that reaches a
		// terminal in bypass, is not argued out of the person's hands and not dropped either: it is held for
		// the person to allow once or deny, and the sender is told which.
		let decision = decideMail({
			scope: 'local',
			text: request.text,
			hops: 0,
			receiver: {
				mode: options.mode(),
				bypass: bypassNow(),
				accepting: true,
				setting: 'members',
			},
			sender: { claimedMode: request.from.mode, vouchedMode: sender.permissionMode },
			rateOk: true,
			pairCount: 0,
		})
		if (decision.action === 'refuse') {
			auditMail('mail_refused', request.from, request.text, decision.reason)
			return { status: 'refused', reason: decision.reason }
		}
		// The list shows every session on this computer and any of them may be messaged, but an agent in
		// another project is not argued into this one's context: its mail waits for the person here.
		const otherFolder = !sameFolder(sender.cwd, cwd)
		const folderReason = 'it comes from a session in another folder'
		if (decision.action === 'accept' && otherFolder) {
			decision = { action: 'hold', reason: folderReason }
		} else if (decision.action === 'hold' && otherFolder) {
			decision = { action: 'hold', reason: `${decision.reason}; ${folderReason}` }
		}
		if (decision.action === 'hold') {
			const duplicate = accepted.get(`${request.from.sessionId}:${request.id}`)
			if (duplicate) return admit(request, request.from)
			const item: HeldLocalMail = {
				id: request.id,
				from: request.from,
				text: request.text,
				owner: options.owner(),
				reason: decision.reason,
			}
			if (!held.hold(request.id, item)) {
				auditMail('mail_refused', request.from, request.text, 'held mail is full')
				return {
					status: 'refused',
					reason: 'This terminal already holds as many messages as it keeps.',
				}
			}
			auditMail('mail_held', request.from, request.text, decision.reason)
			options.report(
				`1 message from ${sanitizeLine(request.from.name, 40)} is held: ${decision.reason}. /peers to allow or deny it.`,
			)
			return {
				status: 'held',
				reason: `Held for the person at the receiving terminal: ${decision.reason}.`,
			}
		}
		const result = admit(request, request.from)
		auditMail(
			result.status === 'queued' ? 'mail_accepted' : 'mail_refused',
			request.from,
			request.text,
			result.status === 'queued' ? undefined : result.reason,
		)
		return result
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
		onNotice: (notice) => {
			if (notice.kind !== 'delivery' || !notice.detail || !sentHeld.delete(notice.detail)) return
			const who = sanitizeLine(notice.about.name, 40)
			if (notice.outcome === 'queued') options.report(`${who} allowed your held message.`)
			else if (notice.outcome === 'refused') options.report(`${who} refused your held message.`)
			else if (notice.outcome === 'expired')
				options.report(`${who} did not answer your held message in time; it was dropped.`)
		},
	})
	try {
		writePeerRecord(runtime.sessionsDir, record())
	} catch (error) {
		await endpoint.close()
		throw error
	}
	/**
	 * A person's message is told it was taken: this process has it out of the inbox and into the turn it is
	 * running, to be recorded and sent with the next request. Said once, to the sender's own endpoint, which
	 * verifies this record before it believes it. A sender that has gone away simply hears nothing; the
	 * message is taken all the same.
	 */
	const tellTaken = (taken: readonly PeerMail[]) => {
		for (const mail of taken)
			if (mail.remote) {
				const remote = mail.remote
				void options.network?.()?.delivered?.(remote.machineId, mail.id, ref)
			}
		const people = taken.filter((mail) => mail.from.kind === 'person')
		if (people.length === 0) return
		publish()
		const current = from()
		for (const mail of people) {
			const target = readPeerRecords(runtime.sessionsDir).find(
				(peer) => peer.sessionId === mail.from.sessionId && peer.kind === 'person',
			)
			if (!target) continue
			void client
				.notice(target, {
					from: current,
					kind: 'delivery',
					about: { sessionId, name: current.name, ref },
					outcome: 'delivered',
					detail: mail.id,
				})
				.catch(() => {})
		}
	}
	/** When each live terminal of this machine started, by ref. */
	const startTimes = (): ReadonlyMap<string, number> =>
		new Map(
			readPeerRecords(runtime.sessionsDir)
				.filter((peer) => peer.kind === 'tui')
				.map((peer) => [peer.ref, peer.startedAt] as const),
		)
	const list = async (): Promise<readonly Record<string, unknown>[]> => {
		// The Namzu network, when it runs, lists every machine's sessions the same way a person sees them.
		const net = options.network?.()
		const roster = net ? await net.list(ref).catch(() => undefined) : undefined
		if (roster) {
			// The network does not carry start times; this machine's own records do.
			const started = startTimes()
			return roster.map((row) =>
				typeof row.ref === 'string' && started.has(row.ref)
					? { ...row, started_at: started.get(row.ref) }
					: row,
			)
		}
		// A failed ping is an unavailable observation, not permission to delete
		// another running process's endpoint (or a replaced registry record).
		// Every live terminal of this user on this computer, whatever its folder.
		const records = readPeerRecords(runtime.sessionsDir).filter((peer) => peer.kind === 'tui')
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
				permission_mode: permissionModeWord(peer.permissionMode),
				state: peer.state,
				started_at: peer.startedAt,
				accepts_messages: peer.acceptsMessages,
				self: peer.sessionId === sessionId,
				...(peer.role ? { role: peer.role } : {}),
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
				peer.kind === 'tui' &&
				(peer.sessionId === target ||
					peer.ref === target ||
					peer.title === target ||
					peer.address === target),
		)
		// A name that is not a terminal on this computer may be a session on another machine of this person's
		// network (`machine/name` always is).
		const net = options.network?.()
		if (net && (candidates.length === 0 || target.includes('/'))) {
			const current = from()
			const remote = await net
				.send(target, message, { sessionRef: ref, sessionName: current.name, mode: current.mode })
				.catch((error: unknown) => ({
					id: '',
					status: 'refused' as const,
					reason: error instanceof Error ? error.message : String(error),
				}))
			if (remote)
				return {
					...(remote.id ? { id: remote.id } : {}),
					status: remote.status,
					...(remote.reason ? { reason: remote.reason } : {}),
				}
		}
		if (candidates.length !== 1)
			return {
				status: 'refused',
				reason: candidates.length
					? `Target is ambiguous; use its exact live session id or ref. It matches: ${candidates.map((peer) => `${peer.ref} (${peer.cwd})`).join(', ')}.`
					: 'No matching terminal on this computer. Use list_sessions.',
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
		if (result.kind === 'responded' && result.status === 'queued') noteExchange(peer.ref, 'out')
		if (result.kind === 'responded' && result.status === 'held') {
			// The receiver will say how it ended; it only believes a notice about a delivery it knows we made.
			endpoint.registerOutstandingDelivery(peer.sessionId)
			sentHeld.add(id)
		}
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

	/** Read the role the network wrote for this session's conversation; a new one is shown once. */
	function syncRole() {
		const stored = readStoredRole()
		if (stored === undefined && role === undefined) return
		if (stored && role && stored.role === role.role && stored.at === role.at) return
		if (!stored && role) {
			role = undefined
			options.report('Your role in the Namzu network was cleared.')
			return
		}
		if (!stored) return
		role = stored
		options.report(`Role set from ${stored.by}: ${sanitizeLine(stored.role, 200)}`)
	}
	const heldView = (): HeldLocalView[] =>
		held.list().map((entry) => ({
			id: entry.id,
			fromName: entry.item.from.name,
			fromRef: entry.item.from.ref,
			reason: entry.item.reason,
			text: entry.item.text,
			expiresAt: entry.expiresAt,
		}))
	const decideHeld = (id: string, allow: boolean): boolean => {
		const entry = held.release(id)
		if (!entry) return false
		const item = entry.item
		if (!allow || closed || !enabled || item.owner !== options.owner()) {
			auditMail('mail_denied', item.from, item.text, allow ? 'the conversation changed' : undefined)
			tellOutcome(item, 'refused')
			return !allow
		}
		// Allowed once: it enters as if just accepted, under the mode this terminal is in now. Nothing is remembered.
		const result = admit(
			{
				protocol: PEER_PROTOCOL_VERSION,
				op: 'deliver',
				token,
				id: item.id,
				from: item.from,
				text: item.text,
			},
			item.from,
		)
		auditMail(
			result.status === 'queued' ? 'mail_allowed' : 'mail_denied',
			item.from,
			item.text,
			result.status === 'queued' ? undefined : result.reason,
		)
		tellOutcome(item, result.status === 'queued' ? 'queued' : 'refused')
		return result.status === 'queued'
	}

	return {
		id: sessionId,
		ref,
		publish,
		list,
		startTimes,
		send,
		/** Give a session or machine (here or on another machine) a role, or clear it with `null`. */
		async setRole(
			target: string,
			text: string | null,
		): Promise<{ readonly status: 'applied' | 'refused'; readonly reason?: string }> {
			const net = options.network?.()
			if (!net) return { status: 'refused', reason: 'Your Namzu network is not running.' }
			return net.setRole(target, text).catch((error: unknown) => ({
				status: 'refused' as const,
				reason: error instanceof Error ? error.message : String(error),
			}))
		},
		/** Mail waiting for the person's decision, newest last. */
		held: heldView,
		allowHeld: (id: string) => decideHeld(id, true),
		denyHeld: (id: string) => decideHeld(id, false),
		get role(): SessionRole | undefined {
			return role
		},
		/**
		 * What the model is told about its role, as request-only context: after the history, never in it.
		 * Every request of every turn carries it while a role is set, so it needs nothing to survive a resume
		 * or a compaction, and a role set while the terminal was idle is in the very first request of the next
		 * turn. The text frames the role as another machine's unreviewed description that grants nothing.
		 */
		roleContext(): string | undefined {
			syncRole()
			if (!role || closed) return undefined
			// One rendering per role, so every request of a turn carries the same bytes.
			if (!roleRendered || roleRendered.of !== role)
				roleRendered = {
					of: role,
					text: formatRoleContext({ role: role.role, byMachine: role.by, at: role.at }),
				}
			return roleRendered.text
		},
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
			const taken = index < 0 ? undefined : pending.splice(index, 1)[0]
			if (taken) tellTaken([taken])
			return taken
		},
		take(owner: number, limit = INBOX_CAPACITY): PeerMail[] {
			discardStale()
			if (closed || !enabled || owner !== options.owner()) return []
			const taken = pending.splice(0, limit)
			tellTaken(taken)
			return taken
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
			held.clear()
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
				'List live terminals for peer messaging: the ones on this computer, in any folder, and, when your Namzu network is on, the sessions on your other machines (machine, name, folder, state, permission mode, role). These are independent processes, not child tasks or archived conversations. Tokens are never returned.',
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
							'Exact live session id, short ref or unambiguous title from list_sessions; `machine/name` or a name for a session on another machine.',
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
					success: receipt.status === 'queued' || receipt.status === 'held',
					output: JSON.stringify(receipt),
					data: receipt,
				}
			},
		}),
		defineTool({
			name: 'set_session_role',
			description:
				'Give a session or a machine in your Namzu network a role: a short description of what it is for (for example "orchestrator" or "you will build the parser"). The role is shown in the list of sessions and told to that session as context. It grants nothing: no permission, no approval, no change of permission mode. An empty role clears it.',
			inputSchema: mcpJsonSchemaToZod({
				type: 'object',
				properties: {
					target: {
						type: 'string',
						description:
							'A session name or `machine/name` from list_sessions; `machine/` (with the slash) addresses a machine.',
					},
					role: { type: 'string', description: 'The role, one short paragraph. Empty clears it.' },
				},
				required: ['target', 'role'],
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
				if (!peers) return { success: false, output: '', error: 'Peer messaging is not ready.' }
				const { target, role } = input as { target: string; role: string }
				// A role on another machine is set by the person (`/peers role`), not by the model: it
				// reaches that session's model as context, and no person has seen it.
				const rows = (await peers.list().catch(() => [])) as readonly Record<string, unknown>[]
				const selfRow = rows.find((row) => row.self === true)
				const localMachine = typeof selfRow?.machine === 'string' ? selfRow.machine : undefined
				const wanted = target.trim().toLowerCase()
				const onThisMachine =
					localMachine !== undefined
						? wanted.endsWith('/')
							? wanted.slice(0, -1) === localMachine.toLowerCase()
							: rows.some(
									(row) =>
										row.machine === localMachine &&
										(`${String(row.machine).toLowerCase()}/${String(row.name).toLowerCase()}` ===
											wanted ||
											String(row.name).toLowerCase() === wanted ||
											`[${String(row.ref)}]` === wanted) &&
										!rows.some(
											(other) =>
												other.machine !== localMachine &&
												String(other.name).toLowerCase() === wanted,
										),
								)
						: rows.length === 0
				if (!onThisMachine)
					return {
						success: false,
						output: '',
						error:
							'A role on another machine is set by the person at a terminal (`/peers role`), not by the model.',
					}
				const result = await peers.setRole(target, role.trim() === '' ? null : role)
				return {
					success: result.status === 'applied',
					output: JSON.stringify(result),
					data: result,
				}
			},
		}),
	]
}
