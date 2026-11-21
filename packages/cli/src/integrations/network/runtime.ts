import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import {
	type AuditEntry,
	type NetworkClock,
	type NetworkDiscovery,
	type NetworkEvent,
	type NetworkService,
	type RosterView,
	createFileAuditSink,
	createMdnsDiscovery,
	createNamzuNetwork,
	createNetworkStore,
	hardenPeerRuntimeDir,
	pipePeerAddress,
	privateInterfaces,
	readPeerRecords,
	systemClock,
	udsPeerAddress,
} from '@namzu/sdk'
import { runsUnderAny } from '../peers/process-ancestry.js'
import { resolvePeerRuntime } from '../peers/runtime.js'
import type { NetworkLink } from '../peers/runtime.js'
import { restrictToOwner } from '../providers/credential-store.js'
import {
	type ControlServer,
	PERSON_ONLY_OPS,
	controlDispatch,
	createControlClient,
	newControlToken,
	readControlInfo,
	removeControlInfo,
	startControlServer,
	writeControlInfo,
} from './control.js'
import { type NetworkController, createNetworkController } from './controller.js'
import { modeWord } from './format.js'
import { type NetBridge, createNetworkHost, openNetBridge } from './host.js'
import { createLeadership, processExists } from './leader.js'
import { type NetworkDecision, decideNetwork } from './policy.js'
import { createRoleStore } from './role-store.js'
import type { NetworkControl, NetworkSettings, NetworkSummary } from './types.js'

export const LEADER_TICK_MS = 5_000
export const NOTICE_POLL_MS = 3_000
/** After the service failed to start, the terminal waits this long before leading again. */
export const LEADER_RETRY_MS = 60_000

export interface NetworkRuntimeOptions {
	readonly home: string
	readonly version: string
	readonly env?: NodeJS.ProcessEnv
	readonly settings: NetworkSettings
	/** True only for a terminal with a person at it. */
	readonly interactive: boolean
	/** A one-line notice for the person: a join request, a machine joined, held mail, how a message ended. */
	readonly notify: (text: string) => void
	/** The ref of the session this terminal runs, once it has one. */
	readonly ownRef?: () => string | undefined
	// Seams for tests; production passes none of them.
	/** Every event of the service this terminal runs, as it happens. */
	readonly onEvent?: (event: NetworkEvent) => void
	readonly clock?: NetworkClock
	readonly interfaces?: () => ReturnType<typeof networkInterfaces>
	readonly allowLoopback?: boolean
	readonly discovery?: () => NetworkDiscovery
	readonly pid?: number
	readonly isAlive?: (pid: number) => boolean
	readonly listenPort?: number
	readonly browseMs?: number
	readonly hostname?: string
}

export interface NetworkRuntime {
	readonly decision: NetworkDecision
	/** True when this terminal runs the service; the others reach it over the control channel. */
	readonly isLeader: boolean
	readonly control: NetworkControl
	/** What `LivePeers` needs to list and message sessions on other machines; undefined while the network is off. */
	readonly link: NetworkLink
	readonly roles: ReturnType<typeof createRoleStore>
	/** Writes one line to the network's audit log (decisions about mail between sessions here); no-op while the network is off. */
	audit(entry: Omit<AuditEntry, 'at'>): void
	/** Look once now (leadership and notices); tests and a screen that just opened use it. */
	refresh(): Promise<NetworkSummary | undefined>
	close(): Promise<void>
}

const hardenDirectory = (path: string) => {
	hardenPeerRuntimeDir(path, process.getuid?.())
	restrictToOwner(path)
}

export function controlPath(home: string, runtimeDir: string): string {
	return process.platform === 'win32'
		? pipePeerAddress(createHash('sha256').update(home).digest('hex').slice(0, 16), 'netctl').slice(
				'pipe:'.length,
			)
		: udsPeerAddress(runtimeDir, 'netctl').slice('uds:'.length)
}

class NetworkOff extends Error {}

export function createNetworkRuntime(options: NetworkRuntimeOptions): NetworkRuntime {
	const env = options.env ?? process.env
	const clock = options.clock ?? systemClock
	const interfaces = options.interfaces ?? networkInterfaces
	const decision = decideNetwork({
		settings: options.settings,
		env,
		interactive: options.interactive,
		interfaces,
		...(options.allowLoopback ? { allowLoopback: true } : {}),
	})
	const roles = createRoleStore({ home: options.home })
	const off = (text: string): NetworkControl => {
		const fail = () => Promise.reject(new NetworkOff(text))
		return {
			summary: fail,
			roster: fail,
			allow: fail,
			deny: fail,
			remove: fail,
			rename: fail,
			setRole: fail,
			send: () => Promise.resolve(undefined),
			add: fail,
			join: fail,
			cancelJoin: () => Promise.resolve(false),
			allowHeld: fail,
			denyHeld: fail,
			reportDelivered: () => Promise.resolve(),
		}
	}
	if (!decision.run) {
		const control = off(decision.text)
		return {
			decision,
			isLeader: false,
			control,
			link: { list: async () => undefined, send: async () => undefined, setRole: control.setRole },
			roles,
			audit: () => {},
			refresh: async () => undefined,
			close: async () => {},
		}
	}

	const networkDir = join(options.home, 'network')
	const leadership = createLeadership({
		dir: networkDir,
		pid: options.pid ?? process.pid,
		now: () => clock.now(),
		isAlive: options.isAlive ?? processExists,
		harden: hardenDirectory,
	})
	const auditSink = createFileAuditSink({ dir: networkDir })
	const runtimeDir = resolvePeerRuntime(options.home, env)
	const socketPath = controlPath(options.home, runtimeDir.path)
	const client = createControlClient(() => {
		const holder = leadership.holder()
		const info = holder ? readControlInfo(networkDir) : undefined
		return info && holder && info.pid === holder.pid ? info : undefined
	})

	let controller: NetworkController | undefined
	let service: NetworkService | undefined
	let server: ControlServer | undefined
	let bridge: NetBridge | undefined
	let failedAt: number | undefined
	let closed = false
	let starting: Promise<void> | undefined
	let cancelTick: (() => void) | undefined
	let cancelPoll: (() => void) | undefined
	let previous: NetworkSummary | undefined
	let previousMachines: ReadonlyMap<string, string> | undefined
	const seenOutcomes = new Set<string>()
	const pid = options.pid ?? process.pid

	const current = (): NetworkControl => controller ?? client

	async function stopLeading(): Promise<void> {
		const stopping = [server?.close(), service?.close(), bridge?.close()]
		controller?.dispose()
		controller = undefined
		service = undefined
		server = undefined
		bridge = undefined
		await Promise.allSettled(stopping)
		removeControlInfo(networkDir, pid)
		leadership.release()
	}

	async function startLeading(): Promise<void> {
		try {
			const runtime = resolvePeerRuntime(options.home, env)
			bridge = await openNetBridge({
				home: options.home,
				runtimeDir: runtime.path,
				sessionsDir: runtime.sessionsDir,
				version: options.version,
			})
			const host = createNetworkHost({
				sessionsDir: runtime.sessionsDir,
				bridge,
				roles,
				isAlive: options.isAlive ?? processExists,
				report: options.notify,
			})
			const eligible = () =>
				privateInterfaces(interfaces(), {
					...(options.allowLoopback ? { allowLoopback: true } : {}),
					...(options.settings.enabled === true ? { anyAddress: true } : {}),
				})
			const discovery =
				options.discovery?.() ??
				createMdnsDiscovery({
					dgram: (await import('node:dgram')) as never,
					interfaces: eligible,
					clock,
				})
			service = createNamzuNetwork({
				home: options.home,
				host,
				interactive: true,
				discovery,
				clock,
				interfaces,
				store: createNetworkStore({ home: options.home, hardenDirectory }),
				acceptMail: () => options.settings.acceptMail,
				...(options.allowLoopback ? { allowLoopback: true } : {}),
				...(options.settings.enabled === true ? { anyNetwork: true } : {}),
				...(options.settings.machineName ? { machineName: options.settings.machineName } : {}),
				...(options.listenPort !== undefined ? { listenPort: options.listenPort } : {}),
				...(options.browseMs !== undefined ? { browseMs: options.browseMs } : {}),
				...(options.hostname ? { hostname: options.hostname } : {}),
			})
			controller = createNetworkController({ service, clock })
			if (options.onEvent) service.on(options.onEvent)
			await service.start()
			const token = newControlToken()
			server = await startControlServer({
				path: socketPath,
				token,
				dispatch: controlDispatch(controller),
				guard: (op, caller) => {
					if (!PERSON_ONLY_OPS.includes(op)) return undefined
					const sessionPids = new Set<number>(
						readPeerRecords(runtime.sessionsDir)
							.filter((peer) => peer.kind === 'tui')
							.map((peer) => peer.pid),
					)
					return caller.underSession ||
						(caller.pid !== undefined && runsUnderAny(caller.pid, sessionPids))
						? 'That is for the person at a terminal: a command a session ran cannot admit a machine, remove one or let held mail in.'
						: undefined
				},
			})
			writeControlInfo(networkDir, { address: socketPath, token, pid })
		} catch (error) {
			failedAt = clock.now()
			await stopLeading()
			options.notify(
				`Your Namzu network could not start: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	async function tick(): Promise<void> {
		if (closed) return
		let leads = false
		try {
			leads = leadership.tryAcquire()
		} catch {
			leads = false
		}
		if (
			leads &&
			!service &&
			(failedAt === undefined || clock.now() - failedAt >= LEADER_RETRY_MS)
		) {
			starting = startLeading()
			await starting
		} else if (!leads && service) {
			await stopLeading()
		}
		if (!closed) cancelTick = clock.setTimer(() => void tick(), LEADER_TICK_MS)
	}

	/** Say what changed since the last look, as one line each. The first look only reports what already waits. */
	async function poll(): Promise<NetworkSummary | undefined> {
		if (closed) return undefined
		let now: NetworkSummary
		try {
			now = await current().summary()
		} catch {
			return undefined
		}
		const before = previous
		previous = now
		const joinsBefore = new Set(before?.joinRequests.map((j) => j.requestId))
		for (const join of now.joinRequests)
			if (!joinsBefore.has(join.requestId))
				options.notify(
					`${join.name} wants to join your Namzu network (code ${join.code}, from ${join.sourceAddr}). /peers to allow or deny.`,
				)
		const ref = options.ownRef?.()
		const heldBefore = new Set(before?.held.map((h) => h.id))
		for (const held of now.held)
			if (!heldBefore.has(held.id) && (ref === undefined || held.toSessionRef === ref))
				options.notify(
					`1 message from ${held.machineName} / ${held.fromSessionName} is held: ${held.reason}. /peers to allow or deny.`,
				)
		for (const outcome of now.outcomes) {
			const key = `${outcome.id}:${outcome.outcome}`
			if (seenOutcomes.has(key)) continue
			seenOutcomes.add(key)
			if (before === undefined || outcome.senderRef !== ref) continue
			if (outcome.outcome === 'queued') options.notify(`${outcome.to} allowed your message.`)
			else if (outcome.outcome === 'refused')
				options.notify(
					`${outcome.to} refused your message${outcome.detail ? `: ${outcome.detail}` : '.'}`,
				)
			else if (outcome.outcome === 'expired')
				options.notify(`${outcome.to} did not answer your message in time; it was dropped.`)
			else if (outcome.outcome === 'held')
				options.notify(`${outcome.to} is holding your message until its person answers.`)
		}
		if (seenOutcomes.size > 256) seenOutcomes.clear()
		if (before && now.members !== before.members) {
			try {
				const roster: RosterView = await current().roster()
				const names = new Map(roster.machines.map((m) => [m.machineId, m.name]))
				if (previousMachines)
					for (const [id, name] of names)
						if (!previousMachines.has(id)) options.notify(`${name} joined your Namzu network.`)
				if (previousMachines)
					for (const [id, name] of previousMachines)
						if (!names.has(id)) options.notify(`${name} left your Namzu network.`)
				previousMachines = names
			} catch {
				// the next look will do
			}
		}
		if (before && !before.removed && now.removed)
			options.notify('This machine was removed from your Namzu network. Its identity was reset.')
		if (now.joining && before?.joining?.code !== now.joining.code)
			options.notify(
				`Asking ${now.joining.endpoint} to let this machine join your Namzu network (code ${now.joining.code}). Allow it on one of your other machines; /peers cancel to withdraw.`,
			)
		if (now.state === 'ambiguous' && before?.state !== 'ambiguous')
			options.notify(
				`${now.nearby.length} Namzu networks are nearby and this machine asked none. /peers to pick yours.`,
			)
		if (before?.lastJoin?.at !== now.lastJoin?.at && now.lastJoin) {
			const text: Record<string, string> = {
				joined: 'Joined your Namzu network.',
				denied: 'Your request to join a Namzu network was denied.',
				expired: 'Your request to join a Namzu network was not answered in time.',
				refused: 'Your request to join a Namzu network was refused.',
				cancelled: 'You withdrew the request to join a Namzu network.',
			}
			options.notify(text[now.lastJoin.result] ?? 'Your request to join ended.')
		}
		return now
	}
	const schedulePoll = () => {
		if (closed) return
		cancelPoll = clock.setTimer(() => {
			void poll().finally(schedulePoll)
		}, NOTICE_POLL_MS)
	}

	void tick().then(() => {
		void poll().finally(schedulePoll)
	})

	const link: NetworkLink = {
		async list(selfRef) {
			let summary: NetworkSummary
			try {
				summary = await current().summary()
			} catch {
				return undefined
			}
			if (summary.state !== 'ready' || summary.members < 2) return undefined
			const roster = await current().roster()
			return roster.machines.flatMap((machine) =>
				machine.sessions.map((session) => ({
					machine: machine.name,
					name: session.name,
					ref: session.ref,
					folder: session.folder,
					state: machine.status === 'offline' ? 'offline' : session.state,
					permission_mode: modeWord(session.mode),
					...(session.role ? { role: session.role } : {}),
					accepts_messages: session.acceptsMessages && machine.status !== 'offline',
					self: machine.status === 'self' && session.ref === selfRef,
				})),
			)
		},
		async send(target, text, from) {
			try {
				return await current().send(target, text, from)
			} catch (error) {
				if (error instanceof NetworkOff) return undefined
				throw error
			}
		},
		delivered: (machineId, mailId, sessionRef) =>
			current()
				.reportDelivered(machineId, mailId, sessionRef)
				.catch(() => {}),
		setRole: (target, role) => current().setRole(target, role),
	}

	return {
		decision,
		get isLeader() {
			return leadership.isLeader && service !== undefined
		},
		control: {
			summary: () => current().summary(),
			roster: () => current().roster(),
			allow: (q) => current().allow(q),
			deny: (q) => current().deny(q),
			remove: (m, o) => current().remove(m, o),
			rename: (n, m) => current().rename(n, m),
			setRole: (t, r) => current().setRole(t, r),
			send: (t, x, f) => current().send(t, x, f),
			add: (h) => current().add(h),
			join: (e) => current().join(e),
			cancelJoin: () => current().cancelJoin(),
			allowHeld: (id) => current().allowHeld(id),
			denyHeld: (id) => current().denyHeld(id),
			reportDelivered: (m, i, r) => current().reportDelivered(m, i, r),
		},
		link,
		roles,
		audit: (entry) => {
			void auditSink.append({ at: clock.now(), ...entry }).catch(() => undefined)
		},
		async refresh() {
			await starting
			return poll()
		},
		async close() {
			closed = true
			cancelTick?.()
			cancelPoll?.()
			await starting?.catch(() => {})
			await stopLeading()
		},
	}
}
