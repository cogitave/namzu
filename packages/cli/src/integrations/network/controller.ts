import {
	type NetworkClock,
	type NetworkEvent,
	type NetworkService,
	type RosterMachineView,
	type RosterView,
	formatJoinCode,
	resolveSessionTarget,
	sanitizeRole,
} from '@namzu/sdk'
import type {
	JoinRequestView,
	MailOutcomeView,
	NetworkControl,
	NetworkSummary,
	SendReceipt,
} from './types.js'

const MAX_OUTCOMES = 32

/**
 * What a person can ask of the network on this machine, over the running service. Names are resolved
 * here (a machine by name or by the start of its id, a session by the roster's rules), so a screen, a
 * command line and the model's tools all say the same thing the same way.
 */
export interface NetworkController extends NetworkControl {
	/** Stop listening to the service. */
	dispose(): void
}

export function createNetworkController(options: {
	readonly service: NetworkService
	readonly clock: NetworkClock
}): NetworkController {
	const { service, clock } = options
	let joining: NetworkSummary['joining']
	let lastJoin: NetworkSummary['lastJoin']
	let removed = false
	const outcomes: MailOutcomeView[] = []
	/** Mail sent from here that has not ended: who sent it and to whom, to attribute the outcome. */
	const sentMail = new Map<string, { senderRef: string; to: string }>()

	const off = service.on((event: NetworkEvent) => {
		switch (event.type) {
			case 'join-waiting':
				joining = {
					code: event.shownCode,
					endpoint: `${event.endpoint.host}:${event.endpoint.port}`,
				}
				break
			case 'joined':
				joining = undefined
				lastJoin = { result: 'joined', at: clock.now() }
				break
			case 'join-ended':
				joining = undefined
				lastJoin = { result: event.result, at: clock.now() }
				break
			case 'removed-self':
				removed = true
				break
			case 'mail-outcome': {
				const known = sentMail.get(event.id)
				if (!known) break
				if (event.outcome !== 'queued' && event.outcome !== 'held') sentMail.delete(event.id)
				outcomes.push({
					id: event.id,
					senderRef: known.senderRef,
					to: known.to,
					outcome: event.outcome,
					...(event.detail ? { detail: event.detail } : {}),
					at: clock.now(),
				})
				if (outcomes.length > MAX_OUTCOMES) outcomes.splice(0, outcomes.length - MAX_OUTCOMES)
				break
			}
		}
	})

	const joinView = (join: ReturnType<NetworkService['pendingJoins']>[number]): JoinRequestView => ({
		requestId: join.requestId,
		name: join.name,
		code: formatJoinCode(join.code),
		sourceAddr: join.sourceAddr,
		expiresAt: join.expiresAt,
	})

	const findMachine = (query: string) => {
		const wanted = query.trim().toLowerCase().replace(/\/$/, '')
		const members = service.members()
		const byId = members.filter((m) => m.machineId.startsWith(wanted) && wanted.length >= 6)
		const byName = members.filter((m) => m.name.toLowerCase() === wanted)
		const hits = byName.length > 0 ? byName : byId
		if (hits.length === 1) return hits[0] as (typeof members)[number]
		throw new Error(
			hits.length === 0
				? `No machine called "${query}" in your network.`
				: `More than one machine is called "${query}"; use the start of its id.`,
		)
	}

	/** A session (`name`, `machine/name`, `[ref]`) or a machine (`machine/` or a machine's name when no session has it). */
	const resolveRoleTarget = async (target: string) => {
		const view: RosterView = await service.roster()
		const text = target.trim()
		if (text.endsWith('/')) {
			const machine = findMachine(text)
			return { machineId: machine.machineId, label: machine.name }
		}
		const session = resolveSessionTarget(view, text)
		if (session.ok)
			return {
				machineId: session.machine.machineId,
				sessionRef: session.session.ref,
				label: `${session.machine.name} / ${session.session.name}`,
			}
		const asMachine = view.machines.filter(
			(m: RosterMachineView) => m.name.toLowerCase() === text.toLowerCase(),
		)
		if (session.reason === 'none' && asMachine.length === 1) {
			const machine = asMachine[0] as RosterMachineView
			return { machineId: machine.machineId, label: machine.name }
		}
		if (session.reason === 'ambiguous')
			throw new Error(
				`More than one session matches "${target}": ${session.candidates.join(', ')}.`,
			)
		throw new Error(
			`No session or machine called "${target}". \`namzu peers list\` shows the names.`,
		)
	}

	return {
		dispose: off,
		async summary() {
			const status = service.status()
			return {
				state: status.state,
				...(status.reason ? { reason: status.reason } : {}),
				...(status.machine
					? {
							machine: {
								id: status.machine.id,
								name: status.machine.name,
								...(status.machine.role ? { role: status.machine.role } : {}),
							},
						}
					: {}),
				members: status.members,
				...(status.port !== undefined ? { port: status.port } : {}),
				nearbyNetworks: status.nearbyNetworks,
				joinRequests: service.pendingJoins().map(joinView),
				held: service.held().map((mail) => ({
					id: mail.id,
					machineName: mail.machineName,
					fromSessionName: mail.fromSessionName,
					fromMode: mail.fromMode,
					toSessionRef: mail.toSessionRef,
					reason: mail.reason,
					text: mail.text,
					expiresAt: mail.expiresAt,
				})),
				...(joining ? { joining } : {}),
				...(lastJoin ? { lastJoin } : {}),
				...(removed ? { removed } : {}),
				outcomes: [...outcomes],
			}
		},
		roster: () => service.roster(),
		async allow(query) {
			return joinView(await service.allow(query))
		},
		async deny(query) {
			return joinView(await service.deny(query))
		},
		async remove(machine, opts = {}) {
			const target = findMachine(machine)
			if (target.self)
				throw new Error('This machine cannot remove itself. Remove it from another machine.')
			const names = new Map(service.members().map((m) => [m.machineId, m.name]))
			const admitted = service
				.admittedBy(target.machineId)
				.map((id) => names.get(id) ?? id.slice(0, 12))
			if (opts.dryRun) return { removed: [], admitted }
			const result = await service.remove(target.machineId, { cascade: opts.cascade === true })
			return { removed: result.removed.map((id) => names.get(id) ?? id.slice(0, 12)), admitted }
		},
		async rename(name, machine) {
			if (machine !== undefined && !findMachine(machine).self)
				throw new Error('A machine is renamed on that machine: run `namzu peers rename` there.')
			await service.rename(name)
		},
		async setRole(target, role) {
			const clean = role === null ? null : sanitizeRole(role)
			if (role !== null && clean === undefined)
				return { status: 'refused', reason: 'A role needs some words.' }
			const where = await resolveRoleTarget(target)
			return service.setRole(
				{
					machineId: where.machineId,
					...(where.sessionRef ? { sessionRef: where.sessionRef } : {}),
				},
				clean ?? null,
			)
		},
		async send(target, text, from): Promise<SendReceipt | undefined> {
			await service.roster()
			const resolved = service.resolve(target)
			if (!resolved.ok) {
				if (resolved.reason === 'none') return undefined
				return {
					status: 'refused',
					reason: `More than one session matches "${target}": ${resolved.candidates.join(', ')}.`,
				}
			}
			if (resolved.machine.status === 'self')
				return {
					status: 'refused',
					reason:
						'That session is on this machine in another folder; messages go between terminals in the same project.',
				}
			const to = `${resolved.machine.name} / ${resolved.session.name}`
			if (!resolved.session.acceptsMessages)
				return { status: 'refused', reason: `${to} is not taking messages.` }
			const receipt = await service.send(
				{ machineId: resolved.machine.machineId, sessionRef: resolved.session.ref },
				text,
				from,
			)
			if (receipt.status !== 'refused') sentMail.set(receipt.id, { senderRef: from.sessionRef, to })
			if (sentMail.size > 256) sentMail.delete(sentMail.keys().next().value as string)
			return receipt
		},
		add: (hostPort) => service.add(hostPort),
		async join(endpoint) {
			if (endpoint) {
				await service.add(endpoint)
				return { networks: [] }
			}
			return {
				networks: Array.from({ length: service.status().nearbyNetworks }, (_, i) => `${i + 1}`),
			}
		},
		allowHeld: (id) => service.allowHeld(id),
		denyHeld: (id) => service.denyHeld(id),
		reportDelivered: (machineId, mailId, sessionRef) =>
			service.reportDelivered(machineId, mailId, sessionRef),
	}
}
