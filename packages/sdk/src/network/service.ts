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

import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { networkInterfaces, hostname as osHostname, platform as osPlatform } from 'node:os'
import { z } from 'zod'
import { type AuditEntry, type AuditSink, createFileAuditSink, textHash } from './audit.js'
import { type NetworkClock, systemClock } from './clock.js'
import {
	type ComputerSecretSource,
	computerJoinProof,
	ensureComputerSecret,
	readComputerSecret,
	verifyComputerJoinProof,
} from './computer.js'
import {
	type DiscoveredEndpoint,
	type ListenAddress,
	type NetworkDiscovery,
	isPrivateNetworkAddress,
	privateInterfaces,
} from './discovery.js'
import { createNetworkIdentity, createSystemGatewayReader } from './fingerprint.js'
import { type MachineKey, generateMachineKey, machineIdOf, shortMachineId } from './identity.js'
import {
	JOIN_BACKOFF_DENIED_MS,
	JOIN_BACKOFF_OTHER_MS,
	JOIN_EXPIRY_MS,
	JOIN_ORPHAN_MS,
	JoinTable,
	type PendingJoin,
	formatJoinCode,
	joinCode,
} from './join.js'
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
import { buildMachineCertificate } from './x509.js'

export const DEFAULT_LISTEN_PORT = 47_310
export const BROWSE_WINDOW_MS = 5_000
/**
 * A network with one machine in it that was founded less than this long ago is "fresh": if a second fresh
 * one is heard nearby (two machines started together and each founded one), the younger asks to join the older.
 */
export const FRESH_NETWORK_MS = 60_000
export const INTERFACE_RECHECK_MS = 30_000
export const ROSTER_FRESH_MS = 15_000
const MAX_NEARBY_NETWORKS = 8

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
			readonly result: 'denied' | 'expired' | 'refused' | 'cancelled'
			readonly reason?: string
	  }
	| { readonly type: 'join-request'; readonly request: PendingJoin }
	| {
			/** A join was admitted without asking: a trusted network, `network.autoAdmit` `always`, or another home of the same person on this computer (`same-computer`, proven by the computer secret). */
			readonly type: 'join-auto'
			readonly requestId: string
			readonly name: string
			readonly machineId: string
			readonly mode: 'trusted-network' | 'always' | 'same-computer'
			/** The name of the trusted network, when that is why. */
			readonly network?: string
			readonly at: number
	  }
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
	/**
	 * Whether a join request is admitted without an Allow: on a trusted network (default), on any private
	 * network, or never. Read at each request.
	 */
	readonly autoAdmit?: () => AutoAdmitSetting
	/**
	 * The computer secret this home may use (the host decides; see `resolveComputerSecret`). Absent: this home
	 * never proves or accepts a same-computer join and asks like any other machine.
	 */
	readonly machineSecret?: ComputerSecretSource
	/** Whether a proof of the same computer admits without asking. Read at each request; default true. */
	readonly sameComputer?: () => boolean
	/** Tighten a directory the service creates (the CLI's also restricts a Windows ACL). */
	readonly hardenDirectory?: (path: string) => void
	/** Which local network an address is on (see `fingerprint.ts`); undefined when unknown. Tests inject one. */
	readonly networkIdentity?: (address: string) => Promise<string | undefined>
	readonly audit?: AuditSink
	readonly store?: NetworkStore
	readonly browseMs?: number
	readonly platform?: string
}

export type AutoAdmitSetting = 'trusted-networks' | 'always' | 'never'

/** A local network as the person sees it. */
export interface NetworkRef {
	readonly id: string
	/** The name it is trusted under, when it is trusted. */
	readonly trusted?: string
	/** A short default name to offer when the person trusts it. */
	readonly suggestedName: string
}

export interface TrustedNetwork {
	readonly id: string
	readonly name: string
	readonly trustedAt: number
}

/** Strip the IPv4-in-IPv6 prefix a socket may report. */
const plainAddress = (address: string) => address.replace(/^::ffff:/i, '')

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
		/** Only when the member admitted this machine on the computer proof. */
		sameComputer: z.literal(true).optional(),
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
/** Words from another machine that reach a screen or a model: no control characters, one line, short. */
function cleanReason(value: string | undefined): string | undefined {
	return value === undefined ? undefined : sanitizeName(value, 200)
}
const DeliverReplyParse = z
	.object({
		status: z.enum(['queued', 'held', 'refused']),
		reason: z.string().optional().transform(cleanReason),
	})
	.strict()
const StatusReplySchema = z
	.object({
		status: z.enum(['applied', 'refused']),
		reason: z.string().optional().transform(cleanReason),
	})
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
	/**
	 * Admit a joiner. `trust` also marks the local network the request came from as trusted (a string names it);
	 * it throws, before admitting anything, when that network cannot be recognised.
	 */
	allow(query: string, options?: { readonly trust?: boolean | string }): Promise<PendingJoin>
	/** Which local network `address` is on, and whether it is trusted; undefined when it cannot be recognised. */
	networkOf(address: string): Promise<NetworkRef | undefined>
	trustedNetworks(): Promise<readonly TrustedNetwork[]>
	/** Mark the network `address` is on as trusted, or rename it when it already is. Returns the name. */
	trustNetwork(address: string, name?: string): Promise<TrustedNetwork>
	/** Stop trusting a network by name or id prefix. */
	untrustNetwork(query: string): Promise<TrustedNetwork>
	/** Give a trusted network another name. */
	renameNetwork(query: string, name: string): Promise<TrustedNetwork>
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
	join(endpoint: HostPort): Promise<'joined' | 'denied' | 'expired' | 'refused' | 'cancelled'>
	/** Withdraw the join request this machine is waiting on. False when none is waiting. */
	cancelJoin(): boolean
	/** The networks heard nearby while this machine has none of its own (or only a fresh one): one address each. */
	nearbyNetworks(): readonly {
		readonly netId: string
		readonly host: string
		readonly port: number
	}[]
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
	/** Requests admitted by the computer proof: their `admitted` frame says so. */
	const proven = new Set<string>()
	const unavailableSeen = new Set<string>()
	/** Machines of this computer, by proof, in either direction. */
	let sameComputerIds: Set<string> | undefined
	/** Cancels for the timers of requests whose connection dropped. */
	const orphanTimers = new Map<string, () => void>()
	/** What a waiting request was made of, so the same machine asking again with the same nonce gets the same code. */
	const askNonces = new Map<
		string,
		{ readonly joinerNonce: string; readonly memberNonce: string }
	>()
	const sent = new Map<
		string,
		{ machineId: string; at: number; session: string; bytes: number; textHash: string }
	>()
	const seenMail: string[] = []
	const inFlight = new Set<string>()
	const offDiscovery: Array<() => void> = []
	let cancelBrowse: (() => void) | undefined
	let cancelRecheck: (() => void) | undefined
	let joining = false
	let joinEndpoint: HostPort | undefined
	let joinClient: NetClient | undefined
	let joinCancelled = false
	let foundedAt: number | undefined
	const declinedNets = new Set<string>()
	const probing = new Set<string>()

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

	const identify =
		options.networkIdentity ??
		createNetworkIdentity({
			interfaces: options.interfaces ?? networkInterfaces,
			clock,
			gateway: createSystemGatewayReader({
				platform: osPlatform(),
				readText: (path) => readFile(path, 'utf8').catch(() => undefined),
				run: (command, args) =>
					new Promise((resolve) => {
						execFile(
							command,
							[...args],
							{ timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 },
							(error, stdout) => resolve(error ? undefined : String(stdout)),
						)
					}),
			}),
		})

	async function trustedList(): Promise<readonly TrustedNetwork[]> {
		const read = await store.readTrustedNetworks()
		return read.status === 'ok' ? read.value.networks : []
	}

	async function networkOf(address: string): Promise<NetworkRef | undefined> {
		const id = await identify(plainAddress(address)).catch(() => undefined)
		if (!id) return undefined
		const list = await trustedList()
		const known = list.find((n) => n.id === id)
		const names = new Set(list.map((n) => n.name.toLowerCase()))
		let n = list.length + 1
		while (names.has(`network ${n}`)) n++
		return { id, ...(known ? { trusted: known.name } : {}), suggestedName: `Network ${n}` }
	}

	async function trustNetwork(address: string, name?: string): Promise<TrustedNetwork> {
		const ref = await networkOf(address)
		if (!ref)
			throw new NetworkError(
				'invalid',
				'This network cannot be recognised (its gateway cannot be read), so it cannot be trusted.',
			)
		const list = await trustedList()
		const existing = list.find((n) => n.id === ref.id)
		const wanted =
			name === undefined ? (existing?.name ?? ref.suggestedName) : sanitizeName(name, 40)
		if (wanted.length === 0) throw new NetworkError('invalid', 'A network needs a name.')
		if (list.some((n) => n.id !== ref.id && n.name.toLowerCase() === wanted.toLowerCase()))
			throw new NetworkError('invalid', `Another trusted network is already called "${wanted}".`)
		const entry: TrustedNetwork = {
			id: ref.id,
			name: wanted,
			trustedAt: existing?.trustedAt ?? clock.now(),
		}
		await store.writeTrustedNetworks({
			v: 1,
			networks: [...list.filter((n) => n.id !== ref.id), entry],
		})
		logAudit({
			event: 'network_trusted',
			decision: existing ? 'renamed' : 'trusted',
			reason: wanted,
		})
		return entry
	}

	function findTrusted(list: readonly TrustedNetwork[], query: string): TrustedNetwork {
		const q = query.trim().toLowerCase()
		const hits = list.filter((n) => n.name.toLowerCase() === q)
		const matches = hits.length > 0 ? hits : list.filter((n) => q.length >= 4 && n.id.startsWith(q))
		if (matches.length !== 1)
			throw new NetworkError(
				'unknown_target',
				matches.length === 0
					? `No trusted network is called "${query}". \`namzu peers networks\` lists them.`
					: 'More than one trusted network matches that.',
			)
		return matches[0] as TrustedNetwork
	}

	async function renameNetwork(query: string, name: string): Promise<TrustedNetwork> {
		const list = await trustedList()
		const found = findTrusted(list, query)
		const wanted = sanitizeName(name, 40)
		if (wanted.length === 0) throw new NetworkError('invalid', 'A network needs a name.')
		if (list.some((n) => n.id !== found.id && n.name.toLowerCase() === wanted.toLowerCase()))
			throw new NetworkError('invalid', `Another trusted network is already called "${wanted}".`)
		const entry = { ...found, name: wanted }
		await store.writeTrustedNetworks({
			v: 1,
			networks: list.map((n) => (n.id === found.id ? entry : n)),
		})
		logAudit({ event: 'network_trusted', decision: 'renamed', reason: wanted })
		return entry
	}

	async function untrustNetwork(query: string): Promise<TrustedNetwork> {
		const list = await trustedList()
		const gone = findTrusted(list, query)
		await store.writeTrustedNetworks({ v: 1, networks: list.filter((n) => n.id !== gone.id) })
		logAudit({ event: 'network_untrusted', reason: gone.name })
		return gone
	}

	/** Why a request from `address` is admitted without asking, or undefined when it must ask. */
	async function autoAdmitMode(
		address: string,
	): Promise<{ mode: 'trusted-network' | 'always'; network?: string } | undefined> {
		const setting = options.autoAdmit?.() ?? 'trusted-networks'
		if (setting === 'never') return undefined
		const plain = plainAddress(address)
		if (setting === 'always')
			return options.allowLoopback || isPrivateNetworkAddress(plain)
				? { mode: 'always' }
				: undefined
		const ref = await networkOf(plain)
		return ref?.trusted ? { mode: 'trusted-network', network: ref.trusted } : undefined
	}

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
			logAudit({
				event: 'mail_expired',
				direction: 'in',
				machine: who(mail.machineId),
				session: mail.toSessionRef,
			})
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
		// A fresh certificate each start: its name is random, so it is no stable mark of this machine.
		const certPem = buildMachineCertificate(key, { now: clock.now() }).pem
		await store.writeCertificate(certPem)
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

	// ─── the computer secret ───────────────────────────────────────────────

	/** The secret, read afresh each time (a rotation or a loosened file takes effect at once). Never repaired. */
	async function computerSecret(): Promise<Buffer | undefined> {
		const source = options.machineSecret
		if (!source) return undefined
		const read = await readComputerSecret(source).catch(
			() => ({ status: 'unsafe', reason: 'the secret cannot be read' }) as const,
		)
		if (read.status === 'ok') return read.secret
		if (read.status === 'unsafe' && !unavailableSeen.has(read.reason)) {
			unavailableSeen.add(read.reason)
			logAudit({ event: 'same_computer_unavailable', reason: read.reason })
		}
		return undefined
	}

	async function ensureSecret(): Promise<void> {
		const source = options.machineSecret
		if (!source) return
		try {
			await ensureComputerSecret(source, options.hardenDirectory)
		} catch {
			// no secret: this home asks like any other
		}
	}

	async function sameComputerSet(): Promise<Set<string>> {
		if (!sameComputerIds) {
			const r = await store.readSameComputer().catch(() => undefined)
			sameComputerIds = new Set(r?.status === 'ok' ? r.value.machines : [])
		}
		return sameComputerIds
	}

	async function rememberSameComputer(machineId: string): Promise<void> {
		const set = await sameComputerSet()
		if (set.has(machineId)) return
		set.add(machineId)
		await store.writeSameComputer({ v: 1, machines: [...set].slice(-64) }).catch(() => undefined)
	}

	/** Whether this request proves the joiner holds the computer secret, and the person allows acting on it. */
	async function provesSameComputer(
		request: Extract<NetRequest, { op: 'join_request' }>,
		joinerId: string,
	): Promise<boolean> {
		if (request.computerProof === undefined) return false
		if (options.sameComputer?.() === false) return false
		if ((options.autoAdmit?.() ?? 'trusted-networks') === 'never') return false
		const secret = await computerSecret()
		if (!secret) return false
		const ok = verifyComputerJoinProof(
			secret,
			request.computerProof,
			joinerId,
			selfId(),
			request.nonce,
		)
		if (!ok)
			logAudit({
				event: 'same_computer_mismatch',
				machine: { id12: shortMachineId(joinerId), name: sanitizeName(request.machineName) },
			})
		return ok
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
		foundedAt = n.value.createdAt
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
		const before = await store.readNetwork()
		await store.writeNetwork({
			v: 1,
			netId,
			founderPublicKey: founding?.publicKey ?? '',
			createdAt:
				before.status === 'ok' && before.value.netId === netId
					? before.value.createdAt
					: clock.now(),
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
		foundedAt = undefined
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
		p.role = roster.machine.role === undefined ? undefined : sanitizeRole(roster.machine.role)
		// Everything another machine says about its sessions is text for a screen and for a model.
		p.sessions = roster.sessions.map(({ role, ...s }) => {
			const cleanRole = role === undefined ? undefined : sanitizeRole(role)
			return {
				...s,
				name: sanitizeName(s.name, 80) || 'session',
				folder: sanitizeName(s.folder, 120),
				mode: sanitizeName(s.mode, 40) || 'unknown',
				...(cleanRole ? { role: cleanRole } : {}),
			}
		})
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
		if (netId && view && view.members.size <= 1) {
			void considerStepDown(endpoint)
			return
		}
		if (!view || view.members.size <= 1) {
			if (!nearby.has(endpoint.netId) && nearby.size >= MAX_NEARBY_NETWORKS) return
			const list = nearby.get(endpoint.netId) ?? []
			if (list.length >= 8) return
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
		foundedAt = clock.now()
		adopt(next)
		await persistMembership()
		setState('ready')
		emit({ type: 'founded', netId: netId as string })
		await advertise()
	}

	/**
	 * Two machines that started together each browsed, heard nothing and founded a network. When a second
	 * fresh network that is also alone turns up, the younger one (by the age each reports on its own clock,
	 * ties by network id) asks the older to let it in; the person on the older one sees one line and one Allow.
	 */
	async function considerStepDown(endpoint: DiscoveredEndpoint): Promise<void> {
		if (!tls || !netId || foundedAt === undefined || closed) return
		if (joining || declinedNets.has(endpoint.netId)) return
		if (clock.now() - foundedAt > FRESH_NETWORK_MS) return
		if (await backingOff(endpoint.netId)) return
		const keyText = `${endpoint.host}:${endpoint.port}`
		if (probing.has(keyText)) return
		probing.add(keyText)
		let theirAge: number | undefined
		try {
			const client = await dialNet({
				identity: tls,
				host: endpoint.host,
				port: endpoint.port,
				clock,
			})
			try {
				const reply = (await client.request({ protocol: NET_PROTOCOL, op: 'ping_net' })) as {
					netId?: unknown
					ageMs?: unknown
				}
				if (reply.netId === endpoint.netId && typeof reply.ageMs === 'number')
					theirAge = reply.ageMs
			} finally {
				client.close()
			}
		} catch {
			return
		} finally {
			probing.delete(keyText)
		}
		if (theirAge === undefined || closed || joining || !netId || foundedAt === undefined) return
		if (!view || view.members.size > 1) return
		if (theirAge > FRESH_NETWORK_MS) return
		const mine = clock.now() - foundedAt
		const younger = mine < theirAge || (mine === theirAge && (netId as string) > endpoint.netId)
		if (!younger) return
		declinedNets.add(endpoint.netId)
		emit({ type: 'nearby', networks: [endpoint.netId] })
		await joinNetwork({ host: endpoint.host, port: endpoint.port }, endpoint.netId).catch(
			() => undefined,
		)
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
			if (await backingOff(target.netId)) {
				setState(
					'searching',
					'This machine asked to join a Namzu network lately; it will not ask again yet.',
				)
				return
			}
			setState('searching', 'Asking to join a Namzu network nearby.')
			void joinNetwork({ host: target.host, port: target.port }, target.netId).catch(
				() => undefined,
			)
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
		await ensureSecret()
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
			if (joined !== current && list.length === 0) {
				// Left the private network: nothing listens or is announced until one is back.
				current = joined
				void (async () => {
					await Promise.all(netListeners.splice(0).map((l) => l.close()))
					port = undefined
					addresses = []
					discovery.start(undefined)
					setState('off', 'This network is not known to be private.')
				})()
			} else if (joined !== current) {
				current = joined
				void (async () => {
					await Promise.all(netListeners.splice(0).map((l) => l.close()))
					await startListeners(list)
					await advertise()
					if (netId) setState('ready')
					else if (state === 'off') setState('searching')
				})()
			}
			cancelRecheck = clock.setTimer(tick, INTERFACE_RECHECK_MS)
		}
		cancelRecheck = clock.setTimer(tick, INTERFACE_RECHECK_MS)
	}

	/**
	 * Whether this machine asked `target` lately and was told no (or never answered): the ask is one per
	 * machine, kept in the machine's own network directory, so a terminal that opens later, or takes the
	 * lead from one that closed, does not ask again at once. A person's own `join` never waits on this.
	 */
	async function backingOff(target: string): Promise<boolean> {
		const attempt = await store.readJoinAttempt().catch(() => undefined)
		if (attempt?.status !== 'ok') return false
		const { value } = attempt
		if (value.target !== target || !value.result || value.endedAt === undefined) return false
		const wait = value.result === 'denied' ? JOIN_BACKOFF_DENIED_MS : JOIN_BACKOFF_OTHER_MS
		return clock.now() - value.endedAt < wait
	}

	/** A person's request: asks now, whatever happened to an earlier ask. */
	function join(
		endpoint: HostPort,
	): Promise<'joined' | 'denied' | 'expired' | 'refused' | 'cancelled'> {
		return joinNetwork(endpoint, undefined)
	}

	async function joinNetwork(
		endpoint: HostPort,
		netIdHint: string | undefined,
	): Promise<'joined' | 'denied' | 'expired' | 'refused' | 'cancelled'> {
		if (!tls || !key) throw new NetworkError('off', 'The Namzu network is not running.')
		if (view && view.members.size > 1)
			throw new NetworkError('invalid', 'This machine is already in a network.')
		if (joining) throw new NetworkError('invalid', 'A request to join is already waiting.')
		joining = true
		const publicKey = key.publicKeyDer.toString('base64')
		// One ask per machine and network: while it waits, a repeat (another terminal, a restart) uses the
		// same nonce, so the machine asked finds the same request and shows the same code.
		// A person's ask only knows the address until the member answers; the record is then keyed by the
		// network id, so a refusal of a person's ask backs the machine's own asks off like any other.
		let target = netIdHint ?? `${endpoint.host}:${endpoint.port}`
		const prior = await store.readJoinAttempt().catch(() => undefined)
		const reuse =
			prior?.status === 'ok' &&
			prior.value.target === target &&
			prior.value.result === undefined &&
			clock.now() - prior.value.startedAt < JOIN_EXPIRY_MS
		const nonce =
			reuse && prior?.status === 'ok' ? prior.value.nonce : randomBytes(16).toString('base64')
		if (!reuse)
			await store
				.writeJoinAttempt({ v: 1, target, nonce, startedAt: clock.now() })
				.catch(() => undefined)
		const settle = async (result: 'denied' | 'expired' | 'refused' | 'joined' | 'cancelled') => {
			if (result === 'joined' || result === 'cancelled') {
				await store.clearJoinAttempt().catch(() => undefined)
				return
			}
			await store
				.writeJoinAttempt({
					v: 1,
					target,
					nonce,
					startedAt: reuse && prior?.status === 'ok' ? prior.value.startedAt : clock.now(),
					result,
					endedAt: clock.now(),
				})
				.catch(() => undefined)
		}
		let client: NetClient | undefined
		joinCancelled = false
		try {
			client = await connectTo(endpoint, undefined).catch(() => undefined)
			if (!client) {
				client = await dialNet({ identity: tls, host: endpoint.host, port: endpoint.port, clock })
			}
			joinClient = client
			joinEndpoint = endpoint
			const secret = await computerSecret()
			const ask = (conn: NetClient, withProof: boolean) =>
				conn.request({
					protocol: NET_PROTOCOL,
					op: 'join_request',
					machineName: selfName(),
					publicKey,
					nonce,
					...(withProof && secret
						? {
								computerProof: computerJoinProof(
									secret,
									key?.machineId as string,
									conn.peer.machineId,
									nonce,
								),
							}
						: {}),
				})
			let first = await ask(client, true)
			if (
				secret &&
				typeof first === 'object' &&
				first !== null &&
				(first as { error?: unknown }).error === 'bad_request'
			) {
				// An older member does not know the proof field and closed on it: ask again plainly.
				client.close()
				client = await dialNet({ identity: tls, host: endpoint.host, port: endpoint.port, clock })
				joinClient = client
				first = await ask(client, false)
			}
			const pending = PendingFrameSchema.safeParse(first)
			if (!pending.success) {
				const reason = EndFrameSchema.safeParse(first)
				await settle('refused')
				emit({
					type: 'join-ended',
					result: 'refused',
					reason: reason.success ? reason.data.reason : undefined,
				})
				return 'refused'
			}
			target = pending.data.netId
			const code = joinCode(key.machineId, client.peer.machineId, nonce, pending.data.nonce)
			emit({ type: 'join-waiting', code, shownCode: formatJoinCode(code), endpoint })
			let final: unknown
			try {
				final = await client.nextFrame()
			} catch (error) {
				if (!joinCancelled) throw error
				await settle('cancelled')
				emit({ type: 'join-ended', result: 'cancelled' })
				return 'cancelled'
			}
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
				await settle(result)
				emit({ type: 'join-ended', result, reason: end.success ? end.data.reason : undefined })
				return result
			}
			const verdict = evaluateMembership(
				{ admissions: admitted.data.admissions, revocations: admitted.data.revocations },
				pending.data.netId,
			)
			if (verdict.netId !== pending.data.netId || !verdict.members.has(key.machineId)) {
				await settle('refused')
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
			foundedAt = undefined
			await persistMembership()
			await settle('joined')
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
			if (admitted.data.sameComputer === true && secret)
				await rememberSameComputer(client.peer.machineId)
			setState('ready')
			emit({ type: 'joined', netId: netId as string, members: verdict.members.size })
			await advertise()
			for (const id of verdict.members.keys()) if (id !== key.machineId) void reconnect(id)
			return 'joined'
		} finally {
			joining = false
			joinClient = undefined
			joinEndpoint = undefined
			client?.close()
		}
	}

	function cancelJoin(): boolean {
		if (!joining || !joinClient) return false
		joinCancelled = true
		joinClient.close()
		// Closing alone leaves the request waiting on the other machine; say that it is withdrawn.
		const at = joinEndpoint
		if (tls && at)
			void dialNet({ identity: tls, host: at.host, port: at.port, clock })
				.then(async (client) => {
					try {
						await client.request({ protocol: NET_PROTOCOL, op: 'join_cancel' })
					} finally {
						client.close()
					}
				})
				.catch(() => undefined)
		return true
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
				// A machine alone in a network just founded says how old it is, so two that founded
				// together can tell which is younger; a network with others in it says nothing more.
				return netId
					? view && view.members.size <= 1 && foundedAt !== undefined
						? { ok: true, netId, ageMs: Math.max(0, clock.now() - foundedAt) }
						: { ok: true, netId }
					: { ok: true }
			case 'join_request':
				return handleJoinRequest(request, ctx)
			case 'join_cancel': {
				// Only the machine that asked can withdraw its own request, and only the one it asked here.
				const waiting = joiners.findByJoiner(peerId)
				if (waiting?.local) retireJoin(waiting)
				return { ok: true }
			}
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
				// The same machine asking through another member replaces what was waiting from it.
				const earlier = joiners.findByJoiner(machineIdOf(Buffer.from(request.publicKey, 'base64')))
				if (earlier && !earlier.local && earlier.requestId !== request.requestId) {
					joiners.settle(earlier.requestId, 'deny')
					emit({ type: 'join-settled', requestId: earlier.requestId, result: 'deny' })
				}
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
		// A machine has one request waiting, however many times it asks: the same ask again (same nonce,
		// as when another terminal of that machine takes over) keeps the request and its code and only
		// takes over the held connection; a different ask replaces the old one.
		const prior = joiners.findByJoiner(joinerId)
		const known = prior ? askNonces.get(prior.requestId) : undefined
		if (prior?.local && known && known.joinerNonce === request.nonce) {
			const old = pendingConns.get(prior.requestId)
			pendingConns.set(prior.requestId, ctx)
			ctx.holdOpen()
			watchHeld(prior.requestId, ctx)
			ctx.write({ status: 'pending', nonce: known.memberNonce, netId })
			old?.close()
			return undefined
		}
		// A different ask is a new request and meets the same one-a-minute limit as any address; check
		// before the old one is retired, so a refused ask leaves it standing.
		// The proof is the only evidence of the same computer: no address, name or hint is read.
		const same = await provesSameComputer(request, joinerId).catch(() => false)
		if (!same && joiners.tooSoon(ctx.sourceAddress))
			return { status: 'refused', reason: 'Asked again too soon.' }
		if (prior) retireJoin(prior)
		const auto:
			| { mode: 'trusted-network' | 'always' | 'same-computer'; network?: string }
			| undefined = same
			? { mode: 'same-computer' }
			: await autoAdmitMode(ctx.sourceAddress).catch(() => undefined)
		const nonceM = randomBytes(16).toString('base64')
		const code = joinCode(joinerId, selfId(), request.nonce, nonceM)
		const requestId = randomUUID()
		const added = joiners.addLocal(
			{
				requestId,
				name: sanitizeName(request.machineName),
				code,
				sourceAddr: ctx.sourceAddress,
				viaMachineId: selfId(),
				joinerMachineId: joinerId,
				joinerPublicKey: request.publicKey,
			},
			same,
		)
		if (!added.ok)
			return {
				status: 'refused',
				reason:
					added.reason === 'rate' ? 'Asked again too soon.' : 'Too many requests are waiting.',
			}
		askNonces.set(requestId, { joinerNonce: request.nonce, memberNonce: nonceM })
		if (askNonces.size > 64)
			for (const id of askNonces.keys()) if (!joiners.get(id)) askNonces.delete(id)
		ctx.holdOpen()
		pendingConns.set(requestId, ctx)
		watchHeld(requestId, ctx)
		// The joiner must read `pending` before any decision can reach it, so write it first.
		ctx.write({ status: 'pending', nonce: nonceM, netId })
		logAudit({
			event: 'join_requested',
			machine: { id12: shortMachineId(joinerId), name: added.entry.name },
		})
		if (auto) {
			try {
				if (auto.mode === 'same-computer') proven.add(requestId)
				// Admitted without asking: nobody is shown a request, so the other members are not told of one.
				emit({
					type: 'join-auto',
					requestId,
					name: added.entry.name,
					machineId: joinerId,
					mode: auto.mode,
					...(auto.network ? { network: auto.network } : {}),
					at: clock.now(),
				})
				await decideJoin(
					requestId,
					'allow',
					auto.mode === 'same-computer'
						? 'automatically (same computer)'
						: auto.mode === 'always'
							? 'automatically (network.autoAdmit is always)'
							: `automatically (trusted network ${auto.network})`,
				)
				return undefined
			} catch {
				proven.delete(requestId)
				// fall through: the request waits for a person like any other
			}
		}
		emit({ type: 'join-request', request: added.entry })
		void gossipPending(added.entry, request.publicKey)
		return undefined
	}

	/**
	 * A waiting request outlives its connection: the terminal of the joining machine that asked may close
	 * (another one of the same machine asks again and finds the same request and code), and an Allow given
	 * meanwhile still lets the machine in. It ends by an answer, by the joiner's `join_cancel`, by a
	 * newer request from the same machine, or by its ten minutes.
	 */
	function watchHeld(requestId: string, ctx: ServerContext): void {
		orphanTimers.get(requestId)?.()
		orphanTimers.delete(requestId)
		ctx.onClose(() => {
			if (pendingConns.get(requestId) !== ctx) return
			pendingConns.delete(requestId)
			// Long enough for another terminal of the machine to take over; a stranger that asks and leaves
			// does not keep a slot for ten minutes.
			orphanTimers.set(
				requestId,
				clock.setTimer(() => {
					orphanTimers.delete(requestId)
					const entry = joiners.get(requestId)
					if (entry?.local && !pendingConns.has(requestId)) retireJoin(entry)
				}, JOIN_ORPHAN_MS),
			)
		})
	}

	/** A request that a newer one from the same machine replaced: gone from every screen, nobody told it no. */
	function retireJoin(entry: PendingJoin): void {
		orphanTimers.get(entry.requestId)?.()
		orphanTimers.delete(entry.requestId)
		const conn = pendingConns.get(entry.requestId)
		pendingConns.delete(entry.requestId)
		askNonces.delete(entry.requestId)
		joiners.settle(entry.requestId, 'deny')
		emit({ type: 'join-settled', requestId: entry.requestId, result: 'deny' })
		conn?.close()
		if (entry.local) void gossipDecision(entry.requestId, 'deny', undefined, selfId())
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

	/** The name a joiner gave itself, so the members that let it in show it before its own greeting arrives. */
	function rememberJoinerName(machineId: string, name: string): void {
		if (peerState.has(machineId)) return
		peerState.set(machineId, { name: sanitizeName(name), addresses: [], online: false })
	}

	async function handleJoinDecision(
		request: Extract<NetRequest, { op: 'join_decision' }>,
		from: string,
		note?: string,
	): Promise<unknown> {
		const entry = joiners.get(request.requestId)
		if (!entry) {
			joiners.settle(request.requestId, request.decision)
			return { ok: false, reason: 'already' }
		}
		if (!entry.local) {
			// Another member decided about a request that went through a third machine: just settle it.
			joiners.settle(request.requestId, request.decision)
			if (request.admission) {
				rememberJoinerName(request.admission.machineId, entry.name)
				await mergeIn([request.admission], [])
			}
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
			rememberJoinerName(a.machineId, entry.name)
			await mergeIn([a], [])
			if (!isMember(a.machineId)) {
				conn?.write({ status: 'refused', reason: 'The admission did not check out.' })
				conn?.close()
				return { ok: false }
			}
			if (proven.has(request.requestId)) await rememberSameComputer(a.machineId)
			conn?.write(
				proven.has(request.requestId)
					? { ...admittedFrame(), sameComputer: true }
					: admittedFrame(),
			)
			proven.delete(request.requestId)
			logAudit({
				event: 'join_allowed',
				machine: { id12: shortMachineId(a.machineId), name: entry.name },
				decision: note ?? `by ${shortMachineId(from)}`,
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

	async function decideJoin(
		query: string,
		decision: 'allow' | 'deny',
		note?: string,
	): Promise<PendingJoin> {
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
				note,
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

	/** Who set a role, on what, and a hash of the words: never the words. */
	function roleAudit(from: string, session: string, role: string | null) {
		return {
			machine: who(from),
			session,
			direction: from === selfId() ? undefined : ('in' as const),
			decision: role === null ? 'clear' : 'set',
			...(role === null
				? {}
				: { bytes: Buffer.byteLength(role, 'utf8'), textHash: textHash(role) }),
		}
	}

	async function handleRoleSet(request: RoleSetRequest, from: string): Promise<unknown> {
		if (!roleBuckets.take(from))
			return { status: 'refused', reason: 'Too many role changes from that machine.' }
		const role = request.role === null ? null : (sanitizeRole(request.role) ?? null)
		const byName = peerState.get(from)?.name ?? sanitizeName(request.by.machineName)
		if ('machine' in request.target) {
			if (!machine) return { status: 'refused', reason: 'No machine.' }
			machine = { ...machine, ...(role === null ? { role: undefined } : { role }) }
			await store.writeMachine(machine)
			logAudit({ event: 'role_set', ...roleAudit(from, 'machine', role) })
			emit({ type: 'role', target: 'machine', role, byMachine: byName, at: request.at })
			return { status: 'applied' }
		}
		const ref = request.target.sessionRef
		const local = host.listLocalSessions().find((s) => s.ref === ref)
		if (!host.setLocalRole || !local) {
			return { status: 'refused', reason: 'That session is not running here.' }
		}
		// A role from another machine reaches the model as context nobody here has read. A session that
		// skips approvals takes none: the person sets its role at that terminal.
		if (from !== selfId() && (local.bypass === true || local.mode === 'bypass')) {
			logAudit({ event: 'role_refused', ...roleAudit(from, ref, role) })
			return {
				status: 'refused',
				reason: 'That session skips approvals, so its role is set at its own terminal.',
			}
		}
		const ok = host.setLocalRole(ref, role, { by: byName, at: request.at })
		if (!ok) return { status: 'refused', reason: 'That session is not running here.' }
		logAudit({ event: 'role_set', ...roleAudit(from, ref, role) })
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
		logAudit({
			event: reply.data.status === 'applied' ? 'role_set' : 'role_refused',
			machine: who(target.machineId),
			session: target.sessionRef ?? 'machine',
			direction: 'out',
			decision: clean === null || clean === undefined ? 'clear' : 'set',
			...(clean ? { bytes: Buffer.byteLength(clean, 'utf8'), textHash: textHash(clean) } : {}),
			...(reply.data.reason ? { reason: reply.data.reason } : {}),
		})
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
				direction: 'in',
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
			const key = `${from}:${request.from.sessionRef}:${request.id}`
			if (remember256(key))
				return {
					status: heldQueue.list().some((e) => e.item.id === request.id) ? 'held' : 'queued',
				}
			const perSender = heldQueue.list().filter((e) => e.item.machineId === from).length
			if (perSender >= 4) return refuse('Too many messages from that machine are waiting here.')
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
				direction: 'in',
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
			direction: 'in',
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
		const settled: Partial<Record<NetOutcome, AuditEntry['event']>> = {
			queued: 'mail_allowed',
			refused: 'mail_denied',
			expired: 'mail_expired',
		}
		const event = settled[request.outcome]
		if (event && event !== undefined)
			logAudit({
				event,
				direction: 'out',
				machine: who(from),
				session: expected.session,
				bytes: expected.bytes,
				textHash: expected.textHash,
			})
		emit({
			type: 'mail-outcome',
			id: request.about.id,
			outcome: request.outcome,
			machineId: from,
			detail: request.detail === undefined ? undefined : sanitizeName(request.detail, 200),
		})
		return { ok: true }
	}

	async function releaseHeld(id: string, allow: boolean): Promise<void> {
		const entry = heldQueue.release(id)
		if (!entry) throw new NetworkError('unknown_target', 'That message is no longer waiting.')
		const mail = entry.item
		if (!allow) {
			logAudit({
				event: 'mail_denied',
				direction: 'in',
				machine: who(mail.machineId),
				session: mail.toSessionRef,
			})
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
			logAudit({
				event: 'mail_denied',
				direction: 'in',
				machine: who(mail.machineId),
				session: mail.toSessionRef,
				reason: result.reason,
			})
			emit({ type: 'held-resolved', id, result: 'denied' })
			await notifySender(mail, 'refused', result.reason ?? 'That terminal declined the message.')
			return
		}
		logAudit({
			event: 'mail_allowed',
			direction: 'in',
			machine: who(mail.machineId),
			session: mail.toSessionRef,
		})
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
		const bytes = Buffer.byteLength(text, 'utf8')
		const hash = textHash(text)
		logAudit({
			event:
				reply.data.status === 'refused'
					? 'mail_refused'
					: reply.data.status === 'held'
						? 'mail_held'
						: 'mail_accepted',
			direction: 'out',
			machine: who(target.machineId),
			session: target.sessionRef,
			bytes,
			textHash: hash,
			...(reply.data.reason ? { reason: reply.data.reason } : {}),
		})
		if (reply.data.status !== 'refused') {
			sent.set(id, {
				machineId: target.machineId,
				at: clock.now(),
				session: target.sessionRef,
				bytes,
				textHash: hash,
			})
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
		// A live fact: remembered machines count only while this home can still read the secret.
		const sameSet = (await computerSecret()) ? await sameComputerSet() : new Set<string>()
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
				...(sameSet.has(id) ? { sameComputer: true } : {}),
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
		// Held mail lives in the terminal that runs the network: when it stops, each sender is told.
		const stillHeld = heldQueue.list().map((e) => e.item)
		heldQueue.clear()
		await Promise.allSettled(
			stillHeld.map((mail) =>
				notifySender(mail, 'expired', 'The terminal holding the message was closed.'),
			),
		)
		for (const c of pendingConns.values()) c.close()
		pendingConns.clear()
		for (const cancel of orphanTimers.values()) cancel()
		orphanTimers.clear()
		// A terminal that stops lets go of its waiting ask without withdrawing it, as when its process ends.
		joinClient?.close()
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
		async allow(q, opts = {}) {
			if (opts.trust) {
				const entry = joiners.find(q)
				if (!entry) throw new NetworkError('unknown_target', 'No request to join matches that.')
				if (!(await networkOf(entry.sourceAddr)))
					throw new NetworkError(
						'invalid',
						'This network cannot be recognised (its gateway cannot be read), so it cannot be trusted.',
					)
			}
			const entry = await decideJoin(q, 'allow')
			if (opts.trust)
				await trustNetwork(
					entry.sourceAddr,
					typeof opts.trust === 'string' ? opts.trust : undefined,
				)
			return entry
		},
		networkOf,
		trustedNetworks: trustedList,
		trustNetwork,
		untrustNetwork,
		renameNetwork,
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
		cancelJoin,
		nearbyNetworks: () =>
			[...nearby.entries()].flatMap(([id, list]) =>
				list.slice(0, 1).map((e) => ({ netId: id, host: e.host, port: e.port })),
			),
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
