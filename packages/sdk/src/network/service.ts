/**
 * The Namzu network service: one object per machine that owns its identity,
 * membership, listener, discovery, roster, roles and cross-machine mail.
 *
 * Host-neutral. A host (the terminal today, the desktop later) supplies a
 * `NetworkHost` for what only it knows: its live sessions, how to hand a
 * message to one of them, how to set a role. The service never prints, never
 * reads a process-wide setting and never touches a clock or timer except
 * through the injected `NetworkClock`.
 *
 * Safety properties kept here (tests name each):
 * - a machine joins only after one Allow by an existing member;
 * - a non-member can do nothing but ask to join;
 * - a role is descriptive: no code path in this file changes a permission mode;
 * - mail from another machine is held, not accepted, when its mode differs,
 *   when the receiver is in bypass, or when the sender's mode cannot be
 *   confirmed; held mail expires and the sender is told.
 *
 * @experimental
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { networkInterfaces, hostname as osHostname, platform as osPlatform } from 'node:os'
import { z } from 'zod'
import { type AuditEntry, type AuditSink, createFileAuditSink, textHash } from './audit.js'
import { type NetworkClock, systemClock } from './clock.js'
import {
	type DiscoveredEndpoint,
	type ListenAddress,
	type NetworkDiscovery,
	privateInterfaces,
} from './discovery.js'
import { type MachineKey, generateMachineKey, machineIdOf, shortMachineId } from './identity.js'
import { JoinTable, type PendingJoin, formatJoinCode, joinCode } from './join.js'
import {
	HoldQueue,
	type MailSetting,
	SlidingCounter,
	TokenBuckets,
	decideMail,
} from './mail-policy.js'
import {
	type Admission,
	AdmissionSchema,
	type MembershipView,
	RevocationSchema,
	admittedBy,
	createFounding,
	evaluateMembership,
	mergeMembership,
	signAdmission,
	signRevocation,
} from './membership.js'
import {
	type LocalSession,
	type RosterMachineView,
	type RosterView,
	offlineSessions,
	resolveSessionTarget,
} from './roster.js'
import { type MachineFile, type NetworkStore, type PeersFile, createNetworkStore } from './store.js'
import {
	type NetClient,
	type NetListener,
	NetworkError,
	type PeerInfo,
	type ServerContext,
	type TlsIdentity,
	createNetListener,
	dialNet,
} from './transport.js'
import {
	type HostPort,
	MAX_HOPS,
	MAX_MEMBERS,
	MAX_NAME_LENGTH,
	MAX_NET_TEXT_BYTES,
	NET_PROTOCOL,
	type NetDeliverRequest,
	type NetNoticeRequest,
	type NetOutcome,
	type NetRequest,
	type RoleSetRequest,
	type Roster,
	RosterSchema,
	type RosterSession,
	sanitizeName,
	sanitizeRole,
} from './wire.js'
import { buildMachineCertificate, certificatePublicKeyDer } from './x509.js'

export const DEFAULT_LISTEN_PORT = 47_310
export const BROWSE_WINDOW_MS = 5_000
export const INTERFACE_RECHECK_MS = 30_000
export const ROSTER_FRESH_MS = 15_000

/** A message from a session on another machine, as the host receives it. */
export interface RemoteMail {
	readonly id: string
	readonly from: {
		readonly machineId: string
		readonly machineName: string
		readonly sessionRef: string
		readonly sessionName: string
		readonly mode: string
	}
	readonly text: string
	readonly inReplyTo?: string
	readonly hops: number
	/** True when the person allowed this held message once: the host re-checks nothing but a later mode change. */
	readonly allowedOnce: boolean
}

export interface NetworkHost {
	listLocalSessions(): readonly LocalSession[]
	/** Hand a message to a local session. `refused` when the session is gone or declines. */
	deliverLocal(
		sessionRef: string,
		mail: RemoteMail,
	): Promise<{ readonly status: 'queued' | 'refused'; readonly reason?: string }>
	/** Record a role on a local session; false when there is no such session. Never touches permissions. */
	setLocalRole?(
		sessionRef: string,
		role: string | null,
		info: { readonly by: string; readonly at: number },
	): boolean
	report?(text: string): void
}

export type NetworkState = 'off' | 'starting' | 'searching' | 'ready' | 'ambiguous' | 'removed'

export interface HeldMail {
	readonly id: string
	readonly machineId: string
	readonly machineName: string
	readonly fromSessionRef: string
	readonly fromSessionName: string
	readonly fromMode: string
	readonly toSessionRef: string
	readonly text: string
	readonly inReplyTo?: string
	readonly hops: number
	readonly reason: string
	readonly heldAt: number
	readonly expiresAt: number
}

export type NetworkEvent =
	| { readonly type: 'state'; readonly state: NetworkState; readonly reason?: string }
	| { readonly type: 'founded'; readonly netId: string }
	| {
			readonly type: 'join-waiting'
			readonly code: string
			readonly shownCode: string
			readonly endpoint: HostPort
	  }
	| { readonly type: 'joined'; readonly netId: string; readonly members: number }
	| {
			readonly type: 'join-ended'
			readonly result: 'denied' | 'expired' | 'refused'
			readonly reason?: string
	  }
	| { readonly type: 'join-request'; readonly request: PendingJoin }
	| {
			readonly type: 'join-settled'
			readonly requestId: string
			readonly result: 'allow' | 'deny' | 'expired'
	  }
	| { readonly type: 'member-added'; readonly machineId: string; readonly name?: string }
	| { readonly type: 'member-removed'; readonly machineId: string; readonly name?: string }
	| { readonly type: 'removed-self' }
	| { readonly type: 'nearby'; readonly networks: readonly string[] }
	| { readonly type: 'held'; readonly mail: HeldMail }
	| {
			readonly type: 'held-resolved'
			readonly id: string
			readonly result: 'allowed' | 'denied' | 'expired'
	  }
	| {
			readonly type: 'mail-outcome'
			readonly id: string
			readonly outcome: NetOutcome
			readonly machineId: string
			readonly detail?: string
	  }
	| {
			readonly type: 'role'
			readonly target: 'machine' | string
			readonly role: string | null
			readonly byMachine: string
			readonly at: number
	  }

export interface NetworkStatus {
	readonly state: NetworkState
	readonly reason?: string
	readonly machine:
		| { readonly id: string; readonly name: string; readonly role?: string }
		| undefined
	readonly netId: string | undefined
	readonly members: number
	readonly port: number | undefined
	readonly pendingJoins: number
	readonly held: number
	readonly nearbyNetworks: number
}

export interface NetworkServiceOptions {
	/** The Namzu home (`~/.namzu`); the service keeps its files in `<home>/network`. */
	readonly home: string
	readonly host: NetworkHost
	/** True only in a terminal with a person at it. A service constructed with false refuses to start unless `allowUnattended`. */
	readonly interactive: boolean
	readonly allowUnattended?: boolean
	readonly discovery: NetworkDiscovery
	readonly clock?: NetworkClock
	readonly interfaces?: () => NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>
	/** Tests only: 127.0.0.1 counts as a private interface. */
	readonly allowLoopback?: boolean
	/** The person said `network.enabled: true`: listen on non-private addresses too. */
	readonly anyNetwork?: boolean
	/** The port to listen on; 0 = ephemeral and not remembered. Defaults to the remembered one, then 47310, then ephemeral. */
	readonly listenPort?: number
	readonly hostname?: string
	readonly machineName?: string
	readonly acceptMail?: () => MailSetting
	readonly audit?: AuditSink
	readonly store?: NetworkStore
	readonly browseMs?: number
	readonly platform?: string
}

interface PeerState {
	name: string
	addresses: HostPort[]
	role?: string
	sessions?: readonly RosterSession[]
	rosterAt?: number
	seenAt?: number
	online: boolean
}

const PeerEntrySchema = z
	.object({
		machineId: z.string().length(64),
		name: z.string(),
		addresses: z.array(z.object({ host: z.string(), port: z.number().int() }).strict()).max(8),
	})
	.strict()
const AdmittedFrameSchema = z
	.object({
		status: z.literal('admitted'),
		netId: z.string().length(16).optional(),
		admissions: z.array(AdmissionSchema).max(MAX_MEMBERS * 2),
		revocations: z.array(RevocationSchema).max(MAX_MEMBERS * 2),
		peers: z.array(PeerEntrySchema).max(MAX_MEMBERS),
	})
	.strict()
const PendingFrameSchema = z
	.object({ status: z.literal('pending'), nonce: z.string(), netId: z.string().length(16) })
	.strict()
const EndFrameSchema = z
	.object({ status: z.enum(['denied', 'expired', 'refused']), reason: z.string().optional() })
	.strict()
const HelloReplySchema = z
	.object({
		machineName: z.string(),
		addresses: z.array(z.object({ host: z.string(), port: z.number().int() }).strict()).max(8),
	})
	.strict()
const SyncReplySchema = z
	.object({ admissions: z.array(AdmissionSchema), revocations: z.array(RevocationSchema) })
	.strict()
const DeliverReplyParse = z
	.object({ status: z.enum(['queued', 'held', 'refused']), reason: z.string().optional() })
	.strict()
const StatusReplySchema = z
	.object({ status: z.enum(['applied', 'refused']), reason: z.string().optional() })
	.strict()

export interface NetworkService {
	start(): Promise<void>
	status(): NetworkStatus
	identity(): { readonly machineId: string; readonly name: string } | undefined
	on(listener: (event: NetworkEvent) => void): () => void
	/** The roster: this machine first, then every member. Pulls fresh rosters unless `refresh` is false. */
	roster(options?: { readonly refresh?: boolean }): Promise<RosterView>
	members(): readonly {
		readonly machineId: string
		readonly name: string
		readonly self: boolean
	}[]
	pendingJoins(): readonly PendingJoin[]
	allow(query: string): Promise<PendingJoin>
	deny(query: string): Promise<PendingJoin>
	remove(
		machineId: string,
		options?: { readonly cascade?: boolean },
	): Promise<{ readonly removed: readonly string[] }>
	/** Who `machineId` admitted that is still a member: what a cascade would also remove. */
	admittedBy(machineId: string): readonly string[]
	rename(name: string): Promise<void>
	setRole(
		target: { readonly machineId: string; readonly sessionRef?: string },
		role: string | null,
	): Promise<{ readonly status: 'applied' | 'refused'; readonly reason?: string }>
	send(
		target: { readonly machineId: string; readonly sessionRef: string },
		text: string,
		from: { readonly sessionRef: string; readonly sessionName: string; readonly mode: string },
		options?: { readonly inReplyTo?: string; readonly hops?: number },
	): Promise<{
		readonly id: string
		readonly status: 'queued' | 'held' | 'refused'
		readonly reason?: string
	}>
	/** Resolve what a person typed (`name`, `machine/name`, `[ref]`) against the last roster. */
	resolve(text: string): ReturnType<typeof resolveSessionTarget>
	/** Add an address by hand (`namzu peers add`): joins when this machine has no network, remembers the address otherwise. */
	add(hostPort: string): Promise<'join-requested' | 'added'>
	/** Ask a nearby network to let this machine in. Resolves when the request is decided. */
	join(endpoint: HostPort): Promise<'joined' | 'denied' | 'expired' | 'refused'>
	held(): readonly HeldMail[]
	allowHeld(id: string): Promise<void>
	denyHeld(id: string): Promise<void>
	/** The host took held-then-allowed or accepted mail into a turn: tell the sender. */
	reportDelivered(machineId: string, mailId: string, fromSessionRef: string): Promise<void>
	close(): Promise<void>
}

export function parseHostPort(text: string, defaultPort = DEFAULT_LISTEN_PORT): HostPort {
	const trimmed = text.trim()
	const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed)
	let host: string
	let portText: string | undefined
	if (v6) {
		host = v6[1] as string
		portText = v6[2]
	} else {
		const idx = trimmed.lastIndexOf(':')
		if (idx > 0 && trimmed.indexOf(':') === idx) {
			host = trimmed.slice(0, idx)
			portText = trimmed.slice(idx + 1)
		} else {
			host = trimmed
		}
	}
	const port = portText === undefined ? defaultPort : Number(portText)
	if (
		!host ||
		!/^[A-Za-z0-9.:_%-]+$/.test(host) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	) {
		throw new NetworkError('invalid', 'That is not a valid address. Use host or host:port.')
	}
	return { host, port }
}

const same = (a: HostPort, b: HostPort) => a.host === b.host && a.port === b.port

export function createNamzuNetwork(options: NetworkServiceOptions): NetworkService {
	if (!options.interactive && !options.allowUnattended) {
		throw new NetworkError(
			'unattended',
			'The Namzu network runs only in a terminal with a person at it.',
		)
	}
	const clock = options.clock ?? systemClock
	const store = options.store ?? createNetworkStore({ home: options.home })
	const audit: AuditSink =
		options.audit ??
		createFileAuditSink({ dir: store.dir, report: (m) => options.host.report?.(m) })
	const discovery = options.discovery
	const host = options.host
	const platform = options.platform ?? osPlatform()
	const listeners = new Set<(event: NetworkEvent) => void>()

	let state: NetworkState = 'off'
	let stateReason: string | undefined
	let key: MachineKey | undefined
	let tls: TlsIdentity | undefined
	let machine: MachineFile | undefined
	let netId: string | undefined
	let adm: Admission[] = []
	let rev: import('./membership.js').Revocation[] = []
	let view: MembershipView | undefined
	let membersRev = 0
	let port: number | undefined
	let addresses: ListenAddress[] = []
	let started = false
	let closed = false
	const netListeners: NetListener[] = []
	const peerState = new Map<string, PeerState>()
	const nearby = new Map<string, DiscoveredEndpoint[]>()
	const pendingConns = new Map<string, ServerContext>()
	const sent = new Map<string, { machineId: string; at: number }>()
	const seenMail: string[] = []
	const inFlight = new Set<string>()
	const offDiscovery: Array<() => void> = []
	let cancelBrowse: (() => void) | undefined
	let cancelRecheck: (() => void) | undefined
	let joining = false

	const emit = (event: NetworkEvent) => {
		for (const l of [...listeners]) {
			try {
				l(event)
			} catch {
				// a listener must not break the service
			}
		}
	}
	const setState = (next: NetworkState, reason?: string) => {
		if (state === next && stateReason === reason) return
		state = next
		stateReason = reason
		emit({ type: 'state', state, reason })
	}
	const logAudit = (entry: Omit<AuditEntry, 'at'>) => {
		void audit.append({ at: clock.now(), ...entry })
	}
	const who = (machineId: string) => ({
		id12: shortMachineId(machineId),
		name: peerState.get(machineId)?.name,
	})

	const joiners = new JoinTable({
		clock,
		onExpire: (entry) => {
			pendingConns.get(entry.requestId)?.write({ status: 'expired' })
			pendingConns.get(entry.requestId)?.close()
			pendingConns.delete(entry.requestId)
			logAudit({
				event: 'join_expired',
				machine: { id12: entry.viaMachineId.slice(0, 12), name: entry.name },
			})
			emit({ type: 'join-settled', requestId: entry.requestId, result: 'expired' })
		},
	})
	const heldQueue = new HoldQueue<HeldMail>({
		clock,
		capacity: 32,
		onExpire: (id, mail) => {
			logAudit({ event: 'mail_expired', machine: who(mail.machineId), session: mail.toSessionRef })
			emit({ type: 'held-resolved', id, result: 'expired' })
			void notifySender(mail, 'expired', 'The message was not answered in time and has expired.')
		},
	})
	const mailBuckets = new TokenBuckets({ capacity: 30, refillPerSecond: 0.5, clock })
	const roleBuckets = new TokenBuckets({ capacity: 6, refillPerSecond: 0.1, clock })
	const pairs = new SlidingCounter(clock, 60_000)

	const selfName = () => machine?.name ?? 'this machine'
	const isMember = (machineId: string) => view?.members.has(machineId) === true
	const selfId = () => key?.machineId as string

	// ─── identity and files ────────────────────────────────────────────────

	async function loadIdentity(): Promise<void> {
		const k = await store.readKey()
		if (k.status === 'ok') key = k.value
		else {
			key = generateMachineKey()
			if (k.status === 'corrupt')
				host.report?.('The machine key was unreadable; this machine starts a new identity.')
			await store.writeKey(key)
		}
		const cert = await store.readCertificate()
		let certPem = cert
		if (!certPem || !certMatches(certPem, key)) {
			certPem = buildMachineCertificate(key, { now: clock.now() }).pem
			await store.writeCertificate(certPem)
		}
		tls = { key, certificatePem: certPem }
		const m = await store.readMachine()
		const name = sanitizeName(
			options.machineName ?? (m.status === 'ok' ? m.value.name : undefined) ?? defaultName(),
		)
		if (m.status === 'ok' && m.value.machineId === key.machineId) {
			machine = { ...m.value, name }
		} else {
			machine = { v: 1, machineId: key.machineId, name, createdAt: clock.now() }
		}
		await store.writeMachine(machine)
	}

	function certMatches(pem: string, k: MachineKey): boolean {
		try {
			const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64')
			return certificatePublicKeyDer(der).equals(k.publicKeyDer)
		} catch {
			return false
		}
	}

	function defaultName(): string {
		const raw = (options.hostname ?? osHostname()).split('.')[0] ?? ''
		return raw.trim().length > 0 ? raw : 'this-machine'
	}

	async function loadNetwork(): Promise<void> {
		const n = await store.readNetwork()
		const m = await store.readMembers()
		if (n.status !== 'ok' || m.status !== 'ok') return
		const v = evaluateMembership(
			{ admissions: m.value.members, revocations: m.value.revoked },
			n.value.netId,
		)
		if (!v.netId || !v.members.has(selfId())) return
		netId = v.netId
		adm = [...v.admissions]
		rev = [...v.revocations]
		view = v
		membersRev = m.value.rev
		const peers = await store.readPeers()
		if (peers.status === 'ok') {
			for (const [id, p] of Object.entries(peers.value.machines)) {
				peerState.set(id, {
					name: p.name,
					addresses: p.addresses.map((a) => ({ host: a.host, port: a.port })),
					online: false,
				})
			}
		}
	}

	async function persistMembership(): Promise<void> {
		if (!view || !netId) return
		membersRev++
		const founding = view.admissions.find((a) => a.admittedBy === a.machineId)
		await store.writeNetwork({
			v: 1,
			netId,
			founderPublicKey: founding?.publicKey ?? '',
			createdAt: clock.now(),
		})
		await store.writeMembers({
			v: 1,
			rev: membersRev,
			members: [...view.admissions],
			revoked: [...view.revocations],
		})
	}

	async function persistPeers(): Promise<void> {
		const machines: PeersFile['machines'] = {}
		for (const [id, p] of peerState) {
			if (!isMember(id) || id === selfId()) continue
			machines[id] = {
				name: p.name.slice(0, 80),
				addresses: p.addresses
					.slice(0, 4)
					.map((a) => ({ host: a.host, port: a.port, at: clock.now() })),
			}
		}
		await store.writePeers({ v: 1, machines }).catch(() => undefined)
	}

	// ─── membership changes ────────────────────────────────────────────────

	function adopt(next: MembershipView): { added: string[]; removed: string[] } {
		const before = new Set(view?.members.keys() ?? [])
		const added = [...next.members.keys()].filter((id) => !before.has(id))
		const removed = [...before].filter((id) => !next.members.has(id))
		view = next
		adm = [...next.admissions]
		rev = [...next.revocations]
		return { added, removed }
	}

	async function mergeIn(
		admissions: readonly Admission[],
		revocations: readonly import('./membership.js').Revocation[],
	): Promise<boolean> {
		if (!netId) return false
		const merged = mergeMembership(
			{ admissions: adm, revocations: rev },
			{ admissions, revocations },
			netId,
		)
		if (!merged.netId) return false
		const sizeBefore = adm.length + rev.length
		const { added, removed } = adopt(merged)
		if (
			added.length === 0 &&
			removed.length === 0 &&
			merged.admissions.length + merged.revocations.length === sizeBefore
		)
			return false
		await persistMembership()
		for (const id of added) {
			if (id !== selfId())
				emit({ type: 'member-added', machineId: id, name: peerState.get(id)?.name })
		}
		for (const id of removed) {
			if (id === selfId()) continue
			for (const l of netListeners) l.closeMachine(id)
			logAudit({ event: 'removed', machine: who(id) })
			emit({ type: 'member-removed', machineId: id, name: peerState.get(id)?.name })
		}
		if (!merged.members.has(selfId())) await handleSelfRemoved()
		return added.length > 0 || removed.length > 0
	}

	async function handleSelfRemoved(): Promise<void> {
		await stopNetworking()
		await store.reset()
		key = undefined
		tls = undefined
		machine = undefined
		netId = undefined
		view = undefined
		adm = []
		rev = []
		peerState.clear()
		started = false
		setState('removed', 'This machine was removed from the network. Its identity was reset.')
		emit({ type: 'removed-self' })
	}

	async function pushSync(except?: string): Promise<void> {
		if (!view) return
		const request = {
			protocol: NET_PROTOCOL,
			op: 'members_sync',
			admissions: adm,
			revocations: rev,
		}
		const targets = new Set([...view.members.keys(), ...view.admissions.map((a) => a.machineId)])
		await Promise.all(
			[...targets]
				.filter((id) => id !== selfId() && id !== except)
				.map(async (id) => {
					try {
						const reply = SyncReplySchema.safeParse(await callMachine(id, request))
						if (reply.success) await mergeIn(reply.data.admissions, reply.data.revocations)
					} catch {
						// offline members catch up when they next connect
					}
				}),
		)
	}

	// ─── dialing ───────────────────────────────────────────────────────────

	function ownAddress(h: HostPort): boolean {
		return port === h.port && addresses.some((a) => a.address === h.host)
	}

	function candidateAddresses(machineId: string): HostPort[] {
		const out: HostPort[] = []
		for (const a of peerState.get(machineId)?.addresses ?? [])
			if (!out.some((o) => same(o, a))) out.push(a)
		return out
	}

	async function connectTo(h: HostPort, expectMachineId?: string): Promise<NetClient> {
		if (!tls) throw new NetworkError('off', 'The Namzu network is not running.')
		return dialNet({
			identity: tls,
			host: h.host,
			port: h.port,
			clock,
			expectMachineId,
			accept: expectMachineId ? undefined : (peer: PeerInfo) => isMember(peer.machineId),
		})
	}

	function remember(machineId: string, h: HostPort): void {
		const p = peerState.get(machineId) ?? {
			name: machineId.slice(0, 12),
			addresses: [],
			online: true,
		}
		p.addresses = [h, ...p.addresses.filter((a) => !same(a, h))].slice(0, 4)
		peerState.set(machineId, p)
	}

	async function callMachine(machineId: string, request: object): Promise<unknown> {
		let last: unknown
		for (const address of candidateAddresses(machineId)) {
			if (ownAddress(address)) continue
			try {
				const client = await connectTo(address, machineId)
				try {
					const reply = await client.request(request)
					remember(machineId, address)
					const p = peerState.get(machineId)
					if (p) {
						p.online = true
						p.seenAt = clock.now()
					}
					return reply
				} finally {
					client.close()
				}
			} catch (error) {
				last = error
			}
		}
		const p = peerState.get(machineId)
		if (p) p.online = false
		throw last instanceof NetworkError
			? last
			: new NetworkError('dial', 'That machine could not be reached.')
	}

	// ─── greeting: hello, members_sync, roster over one connection ───────────

	function ourHostPorts(): HostPort[] {
		return port === undefined
			? []
			: addresses.map((a) => ({ host: a.address, port: port as number }))
	}

	async function greet(client: NetClient, address: HostPort): Promise<void> {
		const peerId = client.peer.machineId
		remember(peerId, address)
		const hello = HelloReplySchema.safeParse(
			await client.request({
				protocol: NET_PROTOCOL,
				op: 'hello',
				machineName: selfName(),
				addresses: ourHostPorts().slice(0, 8),
				protocolMax: 1,
			}),
		)
		const p = peerState.get(peerId) as PeerState
		if (hello.success) {
			p.name = sanitizeName(hello.data.machineName)
			for (const a of hello.data.addresses) remember(peerId, a)
			remember(peerId, address)
		}
		p.online = true
		p.seenAt = clock.now()
		const sync = SyncReplySchema.safeParse(
			await client.request({
				protocol: NET_PROTOCOL,
				op: 'members_sync',
				admissions: adm,
				revocations: rev,
			}),
		)
		if (sync.success) await mergeIn(sync.data.admissions, sync.data.revocations)
		const roster = RosterSchema.safeParse(
			await client.request({ protocol: NET_PROTOCOL, op: 'roster' }),
		)
		if (roster.success) applyRoster(peerId, roster.data)
		await persistPeers()
	}

	function applyRoster(machineId: string, roster: Roster): void {
		const p = peerState.get(machineId)
		if (!p || roster.machine.id !== machineId) return
		p.name = sanitizeName(roster.machine.name)
		p.role = roster.machine.role
		p.sessions = roster.sessions
		p.rosterAt = clock.now()
		p.seenAt = clock.now()
		p.online = true
	}

	async function discover(endpoint: DiscoveredEndpoint): Promise<void> {
		const h = { host: endpoint.host, port: endpoint.port }
		if (ownAddress(h)) return
		const keyText = `${h.host}:${h.port}`
		if (inFlight.has(keyText)) return
		inFlight.add(keyText)
		try {
			const client = await connectTo(h)
			try {
				await greet(client, h)
			} finally {
				client.close()
			}
		} catch {
			// not a member, or unreachable: nothing to do
		} finally {
			inFlight.delete(keyText)
		}
	}

	function onEndpoint(endpoint: DiscoveredEndpoint): void {
		if (closed) return
		if (netId && endpoint.netId === netId) {
			void discover(endpoint)
			return
		}
		if (!view || view.members.size <= 1) {
			const list = nearby.get(endpoint.netId) ?? []
			if (!list.some((e) => e.host === endpoint.host && e.port === endpoint.port))
				list.push(endpoint)
			nearby.set(endpoint.netId, list)
			if (state === 'searching' || state === 'ambiguous')
				emit({ type: 'nearby', networks: [...nearby.keys()] })
		} else if (endpoint.netId !== netId) {
			emit({ type: 'nearby', networks: [endpoint.netId] })
		}
	}

	// ─── start / found / join ──────────────────────────────────────────────

	function eligibleAddresses(): ListenAddress[] {
		return privateInterfaces((options.interfaces ?? networkInterfaces)(), {
			allowLoopback: options.allowLoopback,
			anyAddress: options.anyNetwork,
		})
	}

	async function startListeners(list: ListenAddress[]): Promise<void> {
		if (!tls) return
		const identity = tls
		const preferred = options.listenPort ?? machine?.listenPort ?? DEFAULT_LISTEN_PORT
		addresses = list
		port = undefined
		for (const a of list) {
			const l = createNetListener({
				identity,
				clock,
				isMember,
				handle: handle,
				onRefused: (info) =>
					logAudit({
						event: 'connection_refused',
						machine: info.machineId ? { id12: shortMachineId(info.machineId) } : undefined,
						reason: `${info.reason}${info.op ? `:${info.op}` : ''}`,
					}),
			})
			const want = port ?? preferred
			let bound: number
			try {
				bound = await l.listen(a.bindHost, want)
			} catch {
				if (port !== undefined || want === 0) continue
				bound = await l.listen(a.bindHost, 0)
			}
			port ??= bound
			netListeners.push(l)
		}
		if (
			port !== undefined &&
			options.listenPort === undefined &&
			machine &&
			machine.listenPort !== port
		) {
			machine = { ...machine, listenPort: port }
			await store.writeMachine(machine)
		}
	}

	async function advertise(): Promise<void> {
		if (netId && port !== undefined) {
			discovery.start({ netId, port, addresses: addresses.map((a) => a.address) })
		}
	}

	async function found(): Promise<void> {
		if (!key || netId) return
		const founding = createFounding(key, clock.now())
		const next = evaluateMembership({ admissions: [founding], revocations: [] })
		netId = next.netId
		adopt(next)
		await persistMembership()
		setState('ready')
		emit({ type: 'founded', netId: netId as string })
		await advertise()
	}

	async function afterBrowse(): Promise<void> {
		cancelBrowse = undefined
		if (closed || netId) return
		const nets = [...nearby.keys()]
		if (nets.length === 0) return found()
		if (nets.length === 1) {
			const target = (
				nearby.get(nets[0] as string) as DiscoveredEndpoint[]
			)[0] as DiscoveredEndpoint
			setState('searching', 'Asking to join a Namzu network nearby.')
			void join({ host: target.host, port: target.port }).catch(() => undefined)
			return
		}
		setState('ambiguous', `Found ${nets.length} Namzu networks nearby.`)
		emit({ type: 'nearby', networks: nets })
	}

	async function start(): Promise<void> {
		if (started) return
		started = true
		closed = false
		setState('starting')
		const list = eligibleAddresses()
		if (list.length === 0) {
			started = false
			setState('off', 'This network is not known to be private.')
			return
		}
		await loadIdentity()
		await loadNetwork()
		await startListeners(list)
		logAudit({ event: 'network_on' })
		offDiscovery.push(discovery.onFound(onEndpoint))
		if (netId) {
			setState('ready')
			discovery.start({ netId, port: port as number, addresses: list.map((a) => a.address) })
			for (const id of view?.members.keys() ?? []) {
				if (id === selfId()) continue
				void reconnect(id)
			}
		} else {
			setState('searching')
			discovery.start(undefined)
			cancelBrowse = clock.setTimer(() => void afterBrowse(), options.browseMs ?? BROWSE_WINDOW_MS)
		}
		watchInterfaces(list)
	}

	async function reconnect(machineId: string): Promise<void> {
		for (const address of candidateAddresses(machineId)) {
			if (ownAddress(address)) continue
			try {
				const client = await connectTo(address, machineId)
				try {
					await greet(client, address)
				} finally {
					client.close()
				}
				return
			} catch {
				// try the next address
			}
		}
	}

	function watchInterfaces(initial: ListenAddress[]): void {
		let current = initial
			.map((a) => a.address)
			.sort()
			.join(',')
		const tick = () => {
			if (closed) return
			const list = eligibleAddresses()
			const joined = list
				.map((a) => a.address)
				.sort()
				.join(',')
			if (joined !== current && list.length > 0) {
				current = joined
				void (async () => {
					await Promise.all(netListeners.splice(0).map((l) => l.close()))
					await startListeners(list)
					await advertise()
				})()
			}
			cancelRecheck = clock.setTimer(tick, INTERFACE_RECHECK_MS)
		}
		cancelRecheck = clock.setTimer(tick, INTERFACE_RECHECK_MS)
	}

	async function join(endpoint: HostPort): Promise<'joined' | 'denied' | 'expired' | 'refused'> {
		if (!tls || !key) throw new NetworkError('off', 'The Namzu network is not running.')
		if (view && view.members.size > 1)
			throw new NetworkError('invalid', 'This machine is already in a network.')
		if (joining) throw new NetworkError('invalid', 'A request to join is already waiting.')
		joining = true
		const publicKey = key.publicKeyDer.toString('base64')
		const nonce = randomBytes(16).toString('base64')
		let client: NetClient | undefined
		try {
			client = await connectTo(endpoint, undefined).catch(() => undefined)
			if (!client) {
				client = await dialNet({ identity: tls, host: endpoint.host, port: endpoint.port, clock })
			}
			const first = await client.request({
				protocol: NET_PROTOCOL,
				op: 'join_request',
				machineName: selfName(),
				publicKey,
				nonce,
			})
			const pending = PendingFrameSchema.safeParse(first)
			if (!pending.success) {
				const reason = EndFrameSchema.safeParse(first)
				emit({
					type: 'join-ended',
					result: 'refused',
					reason: reason.success ? reason.data.reason : undefined,
				})
				return 'refused'
			}
			const code = joinCode(key.machineId, client.peer.machineId, nonce, pending.data.nonce)
			emit({ type: 'join-waiting', code, shownCode: formatJoinCode(code), endpoint })
			const final = await client.nextFrame()
			const admitted = AdmittedFrameSchema.safeParse(final)
			if (!admitted.success) {
				const end = EndFrameSchema.safeParse(final)
				const result = end.success
					? end.data.status === 'denied'
						? 'denied'
						: end.data.status === 'expired'
							? 'expired'
							: 'refused'
					: 'refused'
				emit({ type: 'join-ended', result, reason: end.success ? end.data.reason : undefined })
				return result
			}
			const verdict = evaluateMembership(
				{ admissions: admitted.data.admissions, revocations: admitted.data.revocations },
				pending.data.netId,
			)
			if (verdict.netId !== pending.data.netId || !verdict.members.has(key.machineId)) {
				emit({
					type: 'join-ended',
					result: 'refused',
					reason: 'The network sent a membership list that did not check out.',
				})
				return 'refused'
			}
			if (cancelBrowse) cancelBrowse()
			cancelBrowse = undefined
			adopt(verdict)
			netId = verdict.netId
			await persistMembership()
			for (const p of admitted.data.peers) {
				if (p.machineId === key.machineId) continue
				const existing = peerState.get(p.machineId)
				peerState.set(p.machineId, {
					name: sanitizeName(p.name),
					addresses: p.addresses,
					online: existing?.online ?? false,
				})
			}
			remember(client.peer.machineId, endpoint)
			setState('ready')
			emit({ type: 'joined', netId: netId as string, members: verdict.members.size })
			await advertise()
			for (const id of verdict.members.keys()) if (id !== key.machineId) void reconnect(id)
			return 'joined'
		} finally {
			joining = false
			client?.close()
		}
	}

	// ─── request handling ──────────────────────────────────────────────────

	function peersForJoiner(): z.infer<typeof PeerEntrySchema>[] {
		const out: z.infer<typeof PeerEntrySchema>[] = [
			{ machineId: selfId(), name: selfName(), addresses: ourHostPorts().slice(0, 8) },
		]
		for (const [id, p] of peerState) {
			if (isMember(id) && id !== selfId())
				out.push({ machineId: id, name: p.name, addresses: p.addresses.slice(0, 4) })
		}
		return out.slice(0, MAX_MEMBERS)
	}

	function admittedFrame() {
		return { status: 'admitted', netId, admissions: adm, revocations: rev, peers: peersForJoiner() }
	}

	function buildSelfRoster(): Roster {
		const sessions: RosterSession[] = host
			.listLocalSessions()
			.slice(0, 64)
			.map((s) => ({
				ref: s.ref,
				name: s.name,
				folder: s.folder,
				state: s.state,
				mode: s.mode,
				...(s.role ? { role: s.role } : {}),
				acceptsMessages: s.acceptsMessages,
				kind: 'tui' as const,
			}))
		return {
			machine: {
				id: selfId(),
				name: selfName(),
				...(machine?.role ? { role: machine.role } : {}),
				platform,
			},
			sessions,
		}
	}

	async function handle(request: NetRequest, ctx: ServerContext): Promise<unknown> {
		const peerId = ctx.peer.machineId
		switch (request.op) {
			case 'ping_net':
				return netId ? { ok: true, netId } : { ok: true }
			case 'join_request':
				return handleJoinRequest(request, ctx)
			case 'hello': {
				const p = peerState.get(peerId) ?? {
					name: request.machineName,
					addresses: [],
					online: true,
				}
				p.name = sanitizeName(request.machineName)
				p.online = true
				p.seenAt = clock.now()
				peerState.set(peerId, p)
				for (const a of request.addresses) remember(peerId, a)
				void persistPeers()
				return { machineName: selfName(), addresses: ourHostPorts().slice(0, 8) }
			}
			case 'members_sync': {
				await mergeIn(request.admissions, request.revocations)
				return { admissions: adm, revocations: rev }
			}
			case 'join_pending': {
				const created = joiners.addRemote({
					requestId: request.requestId,
					name: sanitizeName(request.name),
					code: request.code,
					sourceAddr: request.sourceAddr,
					createdAt: request.createdAt,
					viaMachineId: request.viaMachineId,
					joinerMachineId: machineIdOf(Buffer.from(request.publicKey, 'base64')),
					joinerPublicKey: request.publicKey,
				})
				if (created) emit({ type: 'join-request', request: created })
				return { ok: true }
			}
			case 'join_decision':
				return handleJoinDecision(request, peerId)
			case 'roster':
				return buildSelfRoster()
			case 'role_set':
				return handleRoleSet(request, peerId)
			case 'net_deliver':
				return handleDeliver(request, peerId)
			case 'net_notice':
				return handleNotice(request, peerId)
		}
	}

	async function handleJoinRequest(
		request: Extract<NetRequest, { op: 'join_request' }>,
		ctx: ServerContext,
	): Promise<unknown> {
		if (!netId || !view) return { status: 'refused', reason: 'This machine is not in a network.' }
		const joinerKey = Buffer.from(request.publicKey, 'base64')
		const joinerId = machineIdOf(joinerKey)
		if (joinerId !== ctx.peer.machineId)
			return { status: 'refused', reason: 'The key does not match the connection.' }
		if (view.members.has(joinerId)) return { ...admittedFrame() }
		if (view.removed.has(joinerId))
			return { status: 'refused', reason: 'This machine was removed from the network.' }
		const nonceM = randomBytes(16).toString('base64')
		const code = joinCode(joinerId, selfId(), request.nonce, nonceM)
		const requestId = randomUUID()
		const added = joiners.addLocal({
			requestId,
			name: sanitizeName(request.machineName),
			code,
			sourceAddr: ctx.sourceAddress,
			viaMachineId: selfId(),
			joinerMachineId: joinerId,
			joinerPublicKey: request.publicKey,
		})
		if (!added.ok)
			return {
				status: 'refused',
				reason:
					added.reason === 'rate' ? 'Asked again too soon.' : 'Too many requests are waiting.',
			}
		ctx.holdOpen()
		pendingConns.set(requestId, ctx)
		ctx.onClose(() => {
			pendingConns.delete(requestId)
			if (joiners.get(requestId)) {
				joiners.settle(requestId, 'deny')
				emit({ type: 'join-settled', requestId, result: 'deny' })
			}
		})
		// The joiner must read `pending` before any decision can reach it, so write it first.
		ctx.write({ status: 'pending', nonce: nonceM, netId })
		logAudit({
			event: 'join_requested',
			machine: { id12: shortMachineId(joinerId), name: added.entry.name },
		})
		emit({ type: 'join-request', request: added.entry })
		void gossipPending(added.entry, request.publicKey)
		return undefined
	}

	async function gossipPending(entry: PendingJoin, publicKey: string): Promise<void> {
		const frame = {
			protocol: NET_PROTOCOL,
			op: 'join_pending',
			requestId: entry.requestId,
			name: entry.name,
			code: entry.code,
			sourceAddr: entry.sourceAddr,
			createdAt: entry.createdAt,
			viaMachineId: selfId(),
			publicKey,
		}
		await Promise.all(
			[...(view?.members.keys() ?? [])]
				.filter((id) => id !== selfId())
				.map((id) => callMachine(id, frame).catch(() => undefined)),
		)
	}

	async function handleJoinDecision(
		request: Extract<NetRequest, { op: 'join_decision' }>,
		from: string,
	): Promise<unknown> {
		const entry = joiners.get(request.requestId)
		if (!entry) {
			joiners.settle(request.requestId, request.decision)
			return { ok: false, reason: 'already' }
		}
		if (!entry.local) {
			// Another member decided about a request that went through a third machine: just settle it.
			joiners.settle(request.requestId, request.decision)
			if (request.admission) await mergeIn([request.admission], [])
			emit({ type: 'join-settled', requestId: request.requestId, result: request.decision })
			return { ok: true }
		}
		if (joiners.decide(request.requestId, request.decision) !== 'ok')
			return { ok: false, reason: 'already' }
		const conn = pendingConns.get(request.requestId)
		pendingConns.delete(request.requestId)
		if (request.decision === 'allow') {
			const a = request.admission
			if (!a || a.machineId !== entry.joinerMachineId || a.admittedBy !== from) {
				conn?.write({ status: 'refused', reason: 'The admission did not match the request.' })
				conn?.close()
				return { ok: false }
			}
			await mergeIn([a], [])
			if (!isMember(a.machineId)) {
				conn?.write({ status: 'refused', reason: 'The admission did not check out.' })
				conn?.close()
				return { ok: false }
			}
			conn?.write(admittedFrame())
			logAudit({
				event: 'join_allowed',
				machine: { id12: shortMachineId(a.machineId), name: entry.name },
				decision: `by ${shortMachineId(from)}`,
			})
			emit({ type: 'join-settled', requestId: request.requestId, result: 'allow' })
			void pushSync()
			void gossipDecision(request.requestId, 'allow', a, from)
		} else {
			conn?.write({ status: 'denied' })
			logAudit({
				event: 'join_denied',
				machine: { id12: shortMachineId(entry.joinerMachineId ?? ''), name: entry.name },
				decision: `by ${shortMachineId(from)}`,
			})
			emit({ type: 'join-settled', requestId: request.requestId, result: 'deny' })
			void gossipDecision(request.requestId, 'deny', undefined, from)
		}
		conn?.close()
		return { ok: true }
	}

	async function gossipDecision(
		requestId: string,
		decision: 'allow' | 'deny',
		admission: Admission | undefined,
		except: string,
	): Promise<void> {
		const frame = {
			protocol: NET_PROTOCOL,
			op: 'join_decision',
			requestId,
			decision,
			...(admission ? { admission } : {}),
		}
		await Promise.all(
			[...(view?.members.keys() ?? [])]
				.filter((id) => id !== selfId() && id !== except)
				.map((id) => callMachine(id, frame).catch(() => undefined)),
		)
	}

	async function decideJoin(query: string, decision: 'allow' | 'deny'): Promise<PendingJoin> {
		if (!key || !netId) throw new NetworkError('no_network', 'This machine is not in a network.')
		const entry = joiners.find(query)
		if (!entry) throw new NetworkError('unknown_target', 'No request to join matches that.')
		if (entry.local) {
			// This machine is the one the joiner reached: decide here.
			const admission =
				decision === 'allow'
					? signAdmission(
							key,
							netId,
							{
								machineId: entry.joinerMachineId as string,
								publicKey: entry.joinerPublicKey as string,
							},
							clock.now(),
						)
					: undefined
			await handleJoinDecision(
				{
					protocol: NET_PROTOCOL,
					op: 'join_decision',
					requestId: entry.requestId,
					decision,
					...(admission ? { admission } : {}),
				},
				selfId(),
			)
			return entry
		}
		const admission =
			decision === 'allow'
				? signAdmission(
						key,
						netId,
						{
							machineId: entry.joinerMachineId as string,
							publicKey: entry.joinerPublicKey as string,
						},
						clock.now(),
					)
				: undefined
		const reply = (await callMachine(entry.viaMachineId, {
			protocol: NET_PROTOCOL,
			op: 'join_decision',
			requestId: entry.requestId,
			decision,
			...(admission ? { admission } : {}),
		})) as { ok?: boolean }
		joiners.settle(entry.requestId, decision)
		if (reply?.ok === false)
			throw new NetworkError('refused', 'That request was already decided on another machine.')
		emit({ type: 'join-settled', requestId: entry.requestId, result: decision })
		return entry
	}

	// ─── roles ─────────────────────────────────────────────────────────────

	async function handleRoleSet(request: RoleSetRequest, from: string): Promise<unknown> {
		if (!roleBuckets.take(from))
			return { status: 'refused', reason: 'Too many role changes from that machine.' }
		const role = request.role === null ? null : (sanitizeRole(request.role) ?? null)
		const byName = peerState.get(from)?.name ?? sanitizeName(request.by.machineName)
		if ('machine' in request.target) {
			if (!machine) return { status: 'refused', reason: 'No machine.' }
			machine = { ...machine, ...(role === null ? { role: undefined } : { role }) }
			await store.writeMachine(machine)
			logAudit({ event: 'role_set', machine: who(from), session: 'machine' })
			emit({ type: 'role', target: 'machine', role, byMachine: byName, at: request.at })
			return { status: 'applied' }
		}
		const ref = request.target.sessionRef
		if (!host.setLocalRole || !host.listLocalSessions().some((s) => s.ref === ref)) {
			return { status: 'refused', reason: 'That session is not running here.' }
		}
		const ok = host.setLocalRole(ref, role, { by: byName, at: request.at })
		if (!ok) return { status: 'refused', reason: 'That session is not running here.' }
		logAudit({ event: 'role_set', machine: who(from), session: ref })
		emit({ type: 'role', target: ref, role, byMachine: byName, at: request.at })
		return { status: 'applied' }
	}

	async function setRole(target: { machineId: string; sessionRef?: string }, role: string | null) {
		if (!machine) throw new NetworkError('off', 'The Namzu network is not running.')
		const clean = role === null ? null : sanitizeRole(role)
		if (role !== null && clean === undefined)
			throw new NetworkError('invalid', 'A role needs some words.')
		const at = clock.now()
		const body = target.sessionRef ? { sessionRef: target.sessionRef } : { machine: true as const }
		if (target.machineId === selfId()) {
			return (await handleRoleSet(
				{
					protocol: NET_PROTOCOL,
					op: 'role_set',
					target: body,
					role: clean ?? null,
					by: { machineName: selfName() },
					at,
				},
				selfId(),
			)) as { status: 'applied' | 'refused'; reason?: string }
		}
		if (!isMember(target.machineId))
			throw new NetworkError('not_member', 'That machine is not in your network.')
		const reply = StatusReplySchema.safeParse(
			await callMachine(target.machineId, {
				protocol: NET_PROTOCOL,
				op: 'role_set',
				target: body,
				role: clean ?? null,
				by: { machineName: selfName() },
				at,
			}),
		)
		if (!reply.success)
			throw new NetworkError('bad_frame', 'The other machine answered something unexpected.')
		return reply.data
	}

	// ─── mail ──────────────────────────────────────────────────────────────

	async function voucherMode(machineId: string, sessionRef: string): Promise<string | undefined> {
		const p = peerState.get(machineId)
		const stale = !p || p.rosterAt === undefined || clock.now() - p.rosterAt > ROSTER_FRESH_MS
		if (stale) {
			try {
				const roster = RosterSchema.safeParse(
					await callMachine(machineId, { protocol: NET_PROTOCOL, op: 'roster' }),
				)
				if (roster.success) applyRoster(machineId, roster.data)
			} catch {
				// no pull possible: the mode stays unconfirmed
			}
		}
		return peerState.get(machineId)?.sessions?.find((s) => s.ref === sessionRef)?.mode
	}

	function remember256(id: string): boolean {
		if (seenMail.includes(id)) return true
		seenMail.push(id)
		if (seenMail.length > 256) seenMail.shift()
		return false
	}

	async function handleDeliver(request: NetDeliverRequest, from: string): Promise<unknown> {
		const fromName = peerState.get(from)?.name ?? from.slice(0, 12)
		const target = host.listLocalSessions().find((s) => s.ref === request.to.sessionRef)
		const text = request.text
		const refuse = (reason: string) => {
			logAudit({
				event: 'mail_refused',
				machine: who(from),
				session: request.to.sessionRef,
				reason,
				bytes: Buffer.byteLength(text, 'utf8'),
				textHash: textHash(text),
			})
			return { status: 'refused', reason }
		}
		if (!target) return refuse('That session is not running here.')
		const vouched = await voucherMode(from, request.from.sessionRef)
		const decision = decideMail({
			scope: 'remote',
			text,
			hops: request.hops,
			receiver: {
				mode: target.mode,
				bypass: target.bypass === true,
				accepting: target.acceptsMessages,
				setting: options.acceptMail?.() ?? 'members',
			},
			sender: { claimedMode: request.from.mode, vouchedMode: vouched },
			rateOk: mailBuckets.take(from),
			pairCount: pairs.record(`${from}:${request.from.sessionRef}>${request.to.sessionRef}`),
		})
		if (decision.action === 'refuse') return refuse(decision.reason)
		const mail: RemoteMail = {
			id: request.id,
			from: {
				machineId: from,
				machineName: fromName,
				sessionRef: request.from.sessionRef,
				sessionName: sanitizeName(request.from.sessionName, 80),
				mode: vouched ?? request.from.mode,
			},
			text,
			inReplyTo: request.inReplyTo,
			hops: request.hops,
			allowedOnce: false,
		}
		if (decision.action === 'hold') {
			const perTerminal = heldQueue.list().filter((e) => e.item.toSessionRef === target.ref).length
			if (perTerminal >= 8) return refuse('Too many messages are waiting for that terminal.')
			const now = clock.now()
			const entry: HeldMail = {
				id: request.id,
				machineId: from,
				machineName: fromName,
				fromSessionRef: request.from.sessionRef,
				fromSessionName: mail.from.sessionName,
				fromMode: mail.from.mode,
				toSessionRef: target.ref,
				text,
				inReplyTo: request.inReplyTo,
				hops: request.hops,
				reason: decision.reason,
				heldAt: now,
				expiresAt: now + 10 * 60 * 1000,
			}
			if (!heldQueue.hold(request.id, entry))
				return refuse('Too many messages are waiting for this machine.')
			logAudit({
				event: 'mail_held',
				machine: who(from),
				session: target.ref,
				reason: decision.reason,
				bytes: Buffer.byteLength(text, 'utf8'),
				textHash: textHash(text),
			})
			emit({ type: 'held', mail: entry })
			return { status: 'held', reason: decision.reason }
		}
		if (remember256(`${from}:${request.from.sessionRef}:${request.id}`)) return { status: 'queued' }
		const result = await host.deliverLocal(target.ref, mail)
		if (result.status === 'refused')
			return refuse(result.reason ?? 'That terminal declined the message.')
		logAudit({
			event: 'mail_accepted',
			machine: who(from),
			session: target.ref,
			bytes: Buffer.byteLength(text, 'utf8'),
			textHash: textHash(text),
		})
		return { status: 'queued' }
	}

	async function notifySender(mail: HeldMail, outcome: NetOutcome, detail?: string): Promise<void> {
		try {
			await callMachine(mail.machineId, {
				protocol: NET_PROTOCOL,
				op: 'net_notice',
				about: { id: mail.id },
				outcome,
				...(detail ? { detail: detail.slice(0, 200) } : {}),
				from: { sessionRef: mail.toSessionRef },
			})
		} catch {
			// the sender is offline; it finds out when it looks
		}
	}

	async function handleNotice(request: NetNoticeRequest, from: string): Promise<unknown> {
		const expected = sent.get(request.about.id)
		if (!expected || expected.machineId !== from) return { ok: false }
		if (request.outcome !== 'queued' && request.outcome !== 'held') sent.delete(request.about.id)
		emit({
			type: 'mail-outcome',
			id: request.about.id,
			outcome: request.outcome,
			machineId: from,
			detail: request.detail,
		})
		return { ok: true }
	}

	async function releaseHeld(id: string, allow: boolean): Promise<void> {
		const entry = heldQueue.release(id)
		if (!entry) throw new NetworkError('unknown_target', 'That message is no longer waiting.')
		const mail = entry.item
		if (!allow) {
			logAudit({ event: 'mail_denied', machine: who(mail.machineId), session: mail.toSessionRef })
			emit({ type: 'held-resolved', id, result: 'denied' })
			await notifySender(mail, 'refused', 'The person at that terminal did not allow the message.')
			return
		}
		const result = await host.deliverLocal(mail.toSessionRef, {
			id: mail.id,
			from: {
				machineId: mail.machineId,
				machineName: mail.machineName,
				sessionRef: mail.fromSessionRef,
				sessionName: mail.fromSessionName,
				mode: mail.fromMode,
			},
			text: mail.text,
			inReplyTo: mail.inReplyTo,
			hops: mail.hops,
			allowedOnce: true,
		})
		if (result.status === 'refused') {
			emit({ type: 'held-resolved', id, result: 'denied' })
			await notifySender(mail, 'refused', result.reason ?? 'That terminal declined the message.')
			return
		}
		logAudit({ event: 'mail_allowed', machine: who(mail.machineId), session: mail.toSessionRef })
		emit({ type: 'held-resolved', id, result: 'allowed' })
		await notifySender(mail, 'queued')
	}

	async function send(
		target: { machineId: string; sessionRef: string },
		text: string,
		from: { sessionRef: string; sessionName: string; mode: string },
		opts: { inReplyTo?: string; hops?: number } = {},
	) {
		if (!machine) throw new NetworkError('off', 'The Namzu network is not running.')
		if (!isMember(target.machineId) || target.machineId === selfId())
			throw new NetworkError('not_member', 'That machine is not in your network.')
		if (text.trim().length === 0) throw new NetworkError('invalid', 'The message is empty.')
		if (Buffer.byteLength(text, 'utf8') > MAX_NET_TEXT_BYTES)
			throw new NetworkError('invalid', 'The message is too long.')
		const hops = opts.hops ?? 0
		if (hops > MAX_HOPS)
			throw new NetworkError('invalid', 'This conversation between sessions is going in circles.')
		const id = randomUUID()
		const reply = DeliverReplyParse.safeParse(
			await callMachine(target.machineId, {
				protocol: NET_PROTOCOL,
				op: 'net_deliver',
				id,
				to: { sessionRef: target.sessionRef },
				from: {
					sessionRef: from.sessionRef,
					sessionName: sanitizeName(from.sessionName, 80),
					mode: from.mode,
					kind: 'tui',
				},
				text,
				...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
				hops,
			}),
		)
		if (!reply.success)
			throw new NetworkError('bad_frame', 'The other machine answered something unexpected.')
		if (reply.data.status !== 'refused') {
			sent.set(id, { machineId: target.machineId, at: clock.now() })
			if (sent.size > 256) sent.delete(sent.keys().next().value as string)
		}
		return { id, ...reply.data }
	}

	// ─── roster view ───────────────────────────────────────────────────────

	async function roster(opts: { refresh?: boolean } = {}): Promise<RosterView> {
		if (!machine) return { machines: [] }
		if (opts.refresh !== false) {
			await Promise.all(
				[...(view?.members.keys() ?? [])]
					.filter((id) => id !== selfId())
					.map(async (id) => {
						try {
							const r = RosterSchema.safeParse(
								await callMachine(id, { protocol: NET_PROTOCOL, op: 'roster' }),
							)
							if (r.success) applyRoster(id, r.data)
						} catch {
							// shown offline below
						}
					}),
			)
		}
		const now = clock.now()
		const own = buildSelfRoster()
		const machines: RosterMachineView[] = [
			{
				machineId: selfId(),
				name: selfName(),
				status: 'self',
				role: own.machine.role,
				sessions: own.sessions,
			},
		]
		for (const id of [...(view?.members.keys() ?? [])].filter((m) => m !== selfId())) {
			const p = peerState.get(id)
			const online =
				p?.online === true &&
				p.rosterAt !== undefined &&
				now - (p.seenAt ?? 0) < ROSTER_FRESH_MS * 4
			machines.push({
				machineId: id,
				name: p?.name ?? id.slice(0, 12),
				status: online || (opts.refresh === false && p?.online === true) ? 'online' : 'offline',
				seenAt: p?.seenAt,
				role: p?.role,
				sessions: p?.sessions
					? online
						? p.sessions
						: offlineSessions(p.sessions, p.rosterAt ?? 0, now)
					: [],
			})
		}
		return { machines }
	}

	// ─── lifecycle ─────────────────────────────────────────────────────────

	async function stopNetworking(): Promise<void> {
		cancelBrowse?.()
		cancelRecheck?.()
		cancelBrowse = undefined
		cancelRecheck = undefined
		for (const off of offDiscovery.splice(0)) off()
		joiners.clear()
		heldQueue.clear()
		for (const c of pendingConns.values()) c.close()
		pendingConns.clear()
		await discovery.close().catch(() => undefined)
		await Promise.all(netListeners.splice(0).map((l) => l.close()))
	}

	async function close(): Promise<void> {
		if (closed) return
		closed = true
		const wasOn = state !== 'off' && state !== 'removed'
		await stopNetworking()
		if (wasOn) logAudit({ event: 'network_off' })
		await audit.append({ at: clock.now(), event: 'network_off' }).catch(() => undefined)
		started = false
		setState('off')
	}

	return {
		start,
		status: () => ({
			state,
			reason: stateReason,
			machine:
				machine && key
					? { id: key.machineId, name: machine.name ?? selfName(), role: machine.role }
					: undefined,
			netId,
			members: view?.members.size ?? 0,
			port,
			pendingJoins: joiners.list().length,
			held: heldQueue.size,
			nearbyNetworks: nearby.size,
		}),
		identity: () => (key && machine ? { machineId: key.machineId, name: selfName() } : undefined),
		on(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		roster,
		members: () =>
			[...(view?.members.keys() ?? [])].map((id) => ({
				machineId: id,
				name: id === key?.machineId ? selfName() : (peerState.get(id)?.name ?? id.slice(0, 12)),
				self: id === key?.machineId,
			})),
		pendingJoins: () => joiners.list(),
		allow: (q) => decideJoin(q, 'allow'),
		deny: (q) => decideJoin(q, 'deny'),
		async remove(machineId, opts = {}) {
			if (!key || !netId || !view)
				throw new NetworkError('no_network', 'This machine is not in a network.')
			if (!view.members.has(machineId))
				throw new NetworkError('unknown_target', 'That machine is not in your network.')
			const before = new Set(view.members.keys())
			const revocation = signRevocation(key, netId, machineId, opts.cascade === true, clock.now())
			await mergeIn([], [revocation])
			const removedNow = [...before].filter((id) => !view?.members.has(id))
			// Tell everyone, the removed machines too, so they learn it and reset.
			await pushSync()
			return { removed: removedNow }
		},
		admittedBy: (id) => (view ? admittedBy(view, id) : []),
		async rename(name) {
			const clean = sanitizeName(name)
			if (clean.length === 0 || !machine)
				throw new NetworkError('invalid', 'A machine needs a name.')
			machine = { ...machine, name: clean }
			await store.writeMachine(machine)
			logAudit({ event: 'machine_renamed' })
			void Promise.all(
				[...(view?.members.keys() ?? [])]
					.filter((id) => id !== selfId())
					.map((id) =>
						callMachine(id, {
							protocol: NET_PROTOCOL,
							op: 'hello',
							machineName: clean,
							addresses: ourHostPorts().slice(0, 8),
							protocolMax: 1,
						}).catch(() => undefined),
					),
			)
		},
		setRole,
		send,
		resolve: (text) => {
			const machines: RosterMachineView[] = [
				{
					machineId: selfId(),
					name: selfName(),
					status: 'self',
					sessions: buildSelfRoster().sessions,
				},
			]
			for (const [id, p] of peerState) {
				if (id === selfId() || !isMember(id)) continue
				machines.push({
					machineId: id,
					name: p.name,
					status: p.online ? 'online' : 'offline',
					sessions: p.sessions ?? [],
				})
			}
			return resolveSessionTarget({ machines }, text)
		},
		async add(text) {
			const h = parseHostPort(text)
			if (!tls) throw new NetworkError('off', 'The Namzu network is not running.')
			if (!view || view.members.size <= 1) {
				void join(h).catch(() => undefined)
				return 'join-requested'
			}
			const client = await connectTo(h)
			try {
				await greet(client, h)
			} finally {
				client.close()
			}
			return 'added'
		},
		join,
		held: () => heldQueue.list().map((e) => e.item),
		allowHeld: (id) => releaseHeld(id, true),
		denyHeld: (id) => releaseHeld(id, false),
		async reportDelivered(machineId, mailId, fromSessionRef) {
			await callMachine(machineId, {
				protocol: NET_PROTOCOL,
				op: 'net_notice',
				about: { id: mailId },
				outcome: 'delivered',
				from: { sessionRef: fromSessionRef },
			}).catch(() => undefined)
		},
		close,
	}
}

export { MAX_NAME_LENGTH }
