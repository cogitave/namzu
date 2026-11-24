import {
	type RosterMachineView,
	type RosterSession,
	type RosterView,
	permissionModeWord,
} from '@namzu/sdk'
import type { HeldLocalView } from '../peers/runtime.js'
import {
	cutRole,
	fit,
	machinesFromRoster,
	rowsFromRoster,
	sessionListLines,
} from './session-list.js'
import type {
	JoinRequestView,
	NetworkSummary,
	RemoteHeldView,
	TrustedNetworkView,
} from './types.js'

/** The word a person uses for a mode a session reports (the kernel's `classify` is `auto`). */
export function modeWord(mode: string): string {
	return permissionModeWord(mode)
}

export { cutRole, fit }

/** What a roster row says about a session's state: a machine that did not answer shows its sessions offline. */
function stateOf(machine: RosterMachineView, session: RosterSession): string {
	return machine.status === 'offline' ? 'offline' : session.state
}

export function ageText(ms: number): string {
	const minutes = Math.floor(ms / 60_000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

export function minutesLeft(expiresAt: number, now: number): string {
	const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000))
	return `${minutes} min`
}

export interface RosterTextOptions {
	/** The ref of the session this terminal runs, marked "this terminal". */
	readonly selfRef?: string
	/** Start times (ref to epoch ms) of the sessions on this machine; the network does not carry them. */
	readonly startTimes?: ReadonlyMap<string, number>
	readonly now: number
	/** The width to fit; leave out to print every word (piped output). */
	readonly columns?: number
}

/**
 * The roster as the shared session list (see `session-list.ts`): a counted header, one line per session with
 * its machine in the last field, the extras on a second line, and the machines in a short section of their own.
 */
export function rosterLines(view: RosterView, options: RosterTextOptions): string[] {
	return sessionListLines(
		rowsFromRoster(view, { selfRef: options.selfRef, startTimes: options.startTimes }),
		{ now: options.now, columns: options.columns, machines: machinesFromRoster(view) },
	)
}

/** `namzu peers list`: every machine, every live session. Names are the address; a ref only tells two rows with one name apart. */
export function renderRosterList(
	view: RosterView,
	options: Partial<RosterTextOptions> = {},
): string {
	return rosterLines(view, { now: Date.now(), ...options }).join('\n')
}

export interface RosterJsonMachine {
	readonly name: string
	readonly id: string
	readonly status: string
	readonly role?: string
	readonly sessions: readonly {
		readonly name: string
		readonly ref: string
		readonly folder: string
		readonly state: string
		readonly permissionMode: string
		readonly role?: string
		readonly startedAt?: number
		readonly acceptsMessages: boolean
	}[]
}

/** The roster as JSON for `namzu peers list --json`; never a token, a path or a key. */
export function rosterJson(
	view: RosterView,
	startTimes?: ReadonlyMap<string, number>,
): RosterJsonMachine[] {
	return view.machines.map((machine) => ({
		name: machine.name,
		id: machine.machineId.slice(0, 12),
		status: machine.status,
		...(machine.role ? { role: machine.role } : {}),
		sessions: machine.sessions.map((session) => ({
			name: session.name,
			ref: session.ref,
			folder: session.folder,
			state: stateOf(machine, session),
			permissionMode: modeWord(session.mode),
			...(session.role ? { role: session.role } : {}),
			...(machine.status === 'self' && startTimes?.has(session.ref)
				? { startedAt: startTimes.get(session.ref) }
				: {}),
			acceptsMessages: session.acceptsMessages && machine.status !== 'offline',
		})),
	}))
}

/** `namzu peers status` in words. */
export function renderStatus(summary: NetworkSummary, now: number): string {
	const lines: string[] = []
	if (summary.removed)
		lines.push('This machine was removed from your Namzu network. Its identity was reset.')
	const state = {
		off: summary.reason ? `off: ${summary.reason}` : 'off',
		starting: 'starting',
		searching: summary.reason ?? 'looking for a network nearby',
		ready: 'on',
		ambiguous: summary.reason ?? 'more than one network nearby',
		removed: 'this machine was removed',
	}[summary.state]
	lines.push(`Your Namzu network: ${state}`)
	if (summary.machine)
		lines.push(
			`This machine: ${summary.machine.name}${summary.machine.role ? ` (${cutRole(summary.machine.role)})` : ''}`,
		)
	if (summary.state === 'ready') lines.push(`Machines: ${summary.members}`)
	if (summary.nearbyNetworks > 0 && summary.state === 'ambiguous') {
		lines.push(
			`Networks nearby: ${summary.nearbyNetworks}. Choose one with \`namzu peers join <address>\`:`,
		)
		for (const network of summary.nearby) lines.push(`  ${network.host}:${network.port}`)
	}
	if (summary.joining)
		lines.push(`Waiting for an Allow on ${summary.joining.endpoint}; code ${summary.joining.code}.`)
	for (const join of summary.joinRequests)
		lines.push(
			`${join.name} wants to join: code ${join.code}, from ${join.sourceAddr}, expires in ${minutesLeft(join.expiresAt, now)}. \`namzu peers allow ${join.code.replace(' ', '')}\` or \`deny\`.${join.trustOffer ? ` \`allow ${join.code.replace(' ', '')} --trust\` also trusts this network, so new machines on it join without asking.` : ''}`,
		)
	if (summary.trustedNetworks.length > 0)
		lines.push(
			`Trusted networks: ${summary.trustedNetworks.map((n) => n.name).join(', ')}. \`namzu peers networks\` lists them, \`namzu peers untrust <name>\` removes one.`,
		)
	if (summary.held.length > 0)
		lines.push(`Held messages: ${summary.held.length}. /peers in a terminal shows them.`)
	return lines.join('\n')
}

export interface ScreenInput {
	readonly summary: NetworkSummary
	readonly roster: RosterView | undefined
	/** The ref of the session this terminal runs, marked in the list. */
	readonly selfRef?: string
	/** Start times (ref to epoch ms) of this machine's sessions. */
	readonly startTimes?: ReadonlyMap<string, number>
	/** Messages from another terminal on this machine, held here. */
	readonly heldLocal: readonly HeldLocalView[]
	readonly now: number
	readonly columns: number
}

const quote = (text: string, width: number) => {
	const one = Array.from(text.replace(/\s+/g, ' ').trim())
	const cut =
		one.length > width ? `${one.slice(0, Math.max(1, width - 1)).join('')}…` : one.join('')
	return `"${cut}"`
}

/**
 * The text of `/peers`: the roster, then what waits for the person. Under 60 columns a row collapses to a name
 * and a state, the rest on lines of their own.
 */
export function renderPeersScreen(input: ScreenInput): string {
	const { summary, roster, now } = input
	const lines: string[] = []
	const on = summary.state === 'ready'
	lines.push(
		`Your Namzu network · ${on ? 'on' : (summary.reason ?? summary.state)} · ${summary.members} machine${summary.members === 1 ? '' : 's'}`,
	)
	lines.push('')
	// What waits for an answer comes first: a machine asking to join is the one thing here that is time-bound.
	if (summary.joinRequests.length > 0) {
		lines.push(`Join requests (${summary.joinRequests.length})`)
		for (const join of summary.joinRequests) {
			lines.push(`  ${join.name} wants to join your Namzu network`)
			lines.push(
				`    code ${join.code}   from ${join.sourceAddr}   expires in ${minutesLeft(join.expiresAt, now)}`,
			)
			if (join.trustOffer)
				lines.push('    This network is not trusted yet: new machines on it would ask again.')
		}
		lines.push('')
	}
	if (!roster || roster.machines.length === 0) {
		lines.push('Nothing to show yet.')
	} else if (roster.machines.length === 1 && on) {
		lines.push(
			'Only this machine so far. Other machines running Namzu on this network will appear here.',
		)
		lines.push('')
	}
	if (roster)
		lines.push(
			...rosterLines(roster, {
				selfRef: input.selfRef,
				startTimes: input.startTimes,
				now,
				columns: input.columns,
			}),
		)
	const heldCount = summary.held.length + input.heldLocal.length
	if (heldCount > 0) {
		lines.push('')
		lines.push(`Held (${heldCount})`)
		for (const held of input.heldLocal) {
			lines.push(
				`  from ${held.fromName} · ${held.reason} · ${minutesLeft(held.expiresAt, now)} left`,
			)
			lines.push(`    ${quote(held.text, Math.max(20, input.columns - 8))}`)
		}
		for (const held of summary.held) {
			lines.push(
				`  from ${held.machineName} / ${held.fromSessionName} · ${held.reason} · ${minutesLeft(held.expiresAt, now)} left`,
			)
			lines.push(`    ${quote(held.text, Math.max(20, input.columns - 8))}`)
		}
	}
	if (summary.trustedNetworks.length > 0) {
		lines.push('')
		lines.push(`Trusted networks (${summary.trustedNetworks.length})`)
		for (const network of summary.trustedNetworks)
			lines.push(`  ${network.name}: new machines on it join without asking`)
	}
	if (summary.joining) {
		lines.push('')
		lines.push(`Waiting for an Allow on another machine (code ${summary.joining.code}).`)
		lines.push('  Pick "Cancel the request to join" below, or run /peers cancel, to withdraw it.')
	}
	if (summary.state === 'ambiguous' && summary.nearby.length > 0) {
		lines.push('')
		lines.push(
			`More than one Namzu network is nearby (${summary.nearby.length}). Pick the one that is yours:`,
		)
		for (const network of summary.nearby) lines.push(`  ${network.host}:${network.port}`)
	}
	return fit(lines, input.columns).join('\n')
}

/** What the person can do from the picker under `/peers`: one row each, Enter applies. */
export type PeersAction =
	| { readonly kind: 'allow-join'; readonly request: JoinRequestView }
	| { readonly kind: 'allow-join-trust'; readonly request: JoinRequestView; readonly name: string }
	| { readonly kind: 'deny-join'; readonly request: JoinRequestView }
	| { readonly kind: 'untrust-network'; readonly network: TrustedNetworkView }
	| { readonly kind: 'allow-held-remote'; readonly mail: RemoteHeldView }
	| { readonly kind: 'deny-held-remote'; readonly mail: RemoteHeldView }
	| {
			readonly kind: 'cancel-join'
			readonly joining: { readonly code: string; readonly endpoint: string }
	  }
	| {
			readonly kind: 'join-nearby'
			readonly network: { readonly netId: string; readonly host: string; readonly port: number }
	  }
	| { readonly kind: 'allow-held-local'; readonly mail: HeldLocalView }
	| { readonly kind: 'deny-held-local'; readonly mail: HeldLocalView }

export function peersActions(
	summary: NetworkSummary,
	heldLocal: readonly HeldLocalView[],
): PeersAction[] {
	const actions: PeersAction[] = []
	for (const request of summary.joinRequests) {
		actions.push({ kind: 'allow-join', request })
		if (request.trustOffer)
			actions.push({ kind: 'allow-join-trust', request, name: request.trustOffer.suggestedName })
		actions.push({ kind: 'deny-join', request })
	}
	if (summary.joining) actions.push({ kind: 'cancel-join', joining: summary.joining })
	if (summary.state === 'ambiguous')
		for (const network of summary.nearby) actions.push({ kind: 'join-nearby', network })
	for (const mail of heldLocal) {
		actions.push({ kind: 'allow-held-local', mail }, { kind: 'deny-held-local', mail })
	}
	for (const mail of summary.held) {
		actions.push({ kind: 'allow-held-remote', mail }, { kind: 'deny-held-remote', mail })
	}
	for (const network of summary.trustedNetworks) actions.push({ kind: 'untrust-network', network })
	return actions
}

export function describeAction(action: PeersAction): { label: string; description: string } {
	switch (action.kind) {
		case 'allow-join':
			return {
				label: `Allow ${action.request.name}`,
				description: `Let it join. Code ${action.request.code}.`,
			}
		case 'allow-join-trust':
			return {
				label: `Allow and trust this network (${action.name})`,
				description: 'Let it join. New machines here will join without asking.',
			}
		case 'untrust-network':
			return {
				label: `Stop trusting ${action.network.name}`,
				description: 'New machines on it will ask for an Allow again.',
			}
		case 'cancel-join':
			return {
				label: 'Cancel the request to join',
				description: `Stop waiting for an Allow (code ${action.joining.code}).`,
			}
		case 'join-nearby':
			return {
				label: `Ask to join the network at ${action.network.host}`,
				description: 'One Allow on one of its machines lets this one in.',
			}
		case 'deny-join':
			return { label: `Deny ${action.request.name}`, description: 'Do not let it join.' }
		case 'allow-held-remote':
			return {
				label: `Allow once: ${action.mail.machineName} / ${action.mail.fromSessionName}`,
				description: 'Deliver this message once.',
			}
		case 'deny-held-remote':
			return {
				label: `Deny: ${action.mail.machineName} / ${action.mail.fromSessionName}`,
				description: 'Refuse it. The sender is told.',
			}
		case 'allow-held-local':
			return {
				label: `Allow once: ${action.mail.fromName}`,
				description: 'Deliver this message once.',
			}
		case 'deny-held-local':
			return {
				label: `Deny: ${action.mail.fromName}`,
				description: 'Refuse it. The sender is told.',
			}
	}
}
