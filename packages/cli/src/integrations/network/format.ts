import {
	type RosterMachineView,
	type RosterSession,
	type RosterView,
	sessionLabel,
} from '@namzu/sdk'
import { isPermissionMode, permissionModeName } from '../../permissions/mode.js'
import type { HeldLocalView } from '../peers/runtime.js'
import type { JoinRequestView, NetworkSummary, RemoteHeldView } from './types.js'

/** The word a person uses for a mode a session reports (the kernel's `classify` is `auto`). */
export function modeWord(mode: string): string {
	return isPermissionMode(mode) ? permissionModeName(mode) : mode
}

const ROLE_CUT = 60

export function cutRole(role: string, max = ROLE_CUT): string {
	const chars = Array.from(role)
	return chars.length <= max ? role : `${chars.slice(0, max - 1).join('')}…`
}

/** What a roster row says about a session's state: a machine that did not answer shows its sessions offline. */
function stateOf(machine: RosterMachineView, session: RosterSession): string {
	return machine.status === 'offline' ? 'offline' : session.state
}

const pad = (text: string, width: number) =>
	text + ' '.repeat(Math.max(0, width - Array.from(text).length))

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

/**
 * `namzu peers list`: every machine, every live session. Names are the address; a ref is added only to tell
 * two rows with the same name apart.
 */
export function renderRosterList(view: RosterView): string {
	const rows = view.machines.flatMap((machine) =>
		machine.sessions.map((session) => ({
			machine,
			name: sessionLabel(view, machine, session),
			session,
		})),
	)
	const nameWidth = Math.max(0, ...rows.map((row) => Array.from(row.name).length))
	const folderWidth = Math.max(0, ...rows.map((row) => Array.from(row.session.folder).length))
	const stateWidth = Math.max(0, ...rows.map((row) => stateOf(row.machine, row.session).length))
	const modeWidth = Math.max(0, ...rows.map((row) => modeWord(row.session.mode).length))
	const lines: string[] = []
	for (const machine of view.machines) {
		const heading =
			machine.status === 'self'
				? `${machine.name} (this machine)`
				: machine.status === 'offline' && machine.sessions.length === 0
					? `${machine.name} (offline)`
					: machine.name
		lines.push(heading)
		if (machine.role) lines.push(`  role: ${cutRole(machine.role)}`)
		for (const row of rows.filter((r) => r.machine === machine)) {
			const cells = [
				pad(row.name, nameWidth),
				pad(row.session.folder, folderWidth),
				pad(stateOf(machine, row.session), stateWidth),
				pad(modeWord(row.session.mode), modeWidth),
				row.session.role ? cutRole(row.session.role) : '',
			]
			lines.push(`  ${cells.join('  ').trimEnd()}`)
		}
	}
	return lines.join('\n')
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
		readonly acceptsMessages: boolean
	}[]
}

/** The roster as JSON for `namzu peers list --json`; never a token, a path or a key. */
export function rosterJson(view: RosterView): RosterJsonMachine[] {
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
	if (summary.nearbyNetworks > 0 && summary.state === 'ambiguous')
		lines.push(
			`Networks nearby: ${summary.nearbyNetworks}. \`namzu peers add <host[:port]>\` of a machine in the one you want.`,
		)
	if (summary.joining)
		lines.push(`Waiting for an Allow on ${summary.joining.endpoint}; code ${summary.joining.code}.`)
	for (const join of summary.joinRequests)
		lines.push(
			`${join.name} wants to join: code ${join.code}, from ${join.sourceAddr}, expires in ${minutesLeft(join.expiresAt, now)}. \`namzu peers allow ${join.code.replace(' ', '')}\` or \`deny\`.`,
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

function machineHeading(machine: RosterMachineView, now: number): string {
	if (machine.status === 'self') return `  This machine: ${machine.name}`
	const seen = machine.seenAt ? ` · seen ${ageText(now - machine.seenAt)}` : ''
	if (machine.status === 'offline') return `  ${machine.name}  (offline${seen})`
	return machine.seenAt ? `  ${machine.name}  (idle${seen})` : `  ${machine.name}`
}

/**
 * The text of `/peers`: the roster, then what waits for the person. Wide below 60 columns collapses to a
 * name and a state, with the role on its own line.
 */
export function renderPeersScreen(input: ScreenInput): string {
	const { summary, roster, now } = input
	const narrow = input.columns < 60
	const lines: string[] = []
	const on = summary.state === 'ready'
	lines.push(
		`Your Namzu network · ${on ? 'on' : (summary.reason ?? summary.state)} · ${summary.members} machine${summary.members === 1 ? '' : 's'}`,
	)
	lines.push('')
	if (!roster || roster.machines.length === 0) {
		lines.push('Nothing to show yet.')
	} else if (roster.machines.length === 1 && on) {
		lines.push(
			'Only this machine so far. Other machines running Namzu on this network will appear here.',
		)
		lines.push('')
	}
	if (roster) {
		const rows = roster.machines.flatMap((m) =>
			m.sessions.map((s) => ({ m, s, name: sessionLabel(roster, m, s) })),
		)
		const nameWidth = Math.min(
			24,
			Math.max(
				0,
				...rows.map((r) => Array.from(r.name).length + (r.s.ref === input.selfRef ? 16 : 0)),
			),
		)
		const folderWidth = Math.max(0, ...rows.map((r) => Array.from(r.s.folder).length + 3))
		const stateWidth = Math.max(0, ...rows.map((r) => stateOf(r.m, r.s).length))
		const modeWidth = Math.max(0, ...rows.map((r) => modeWord(r.s.mode).length))
		for (const machine of roster.machines) {
			lines.push(machineHeading(machine, now))
			if (machine.role) lines.push(`    role: ${cutRole(machine.role)}`)
			for (const row of rows.filter((r) => r.m === machine)) {
				const mark = row.s.ref === input.selfRef ? `${row.name} (this terminal)` : row.name
				const state = stateOf(machine, row.s)
				if (narrow) {
					lines.push(`    ${mark}  ${state}`)
					if (row.s.role)
						lines.push(`      ${cutRole(row.s.role, Math.max(10, input.columns - 8))}`)
				} else {
					const cells = [
						pad(mark, nameWidth),
						pad(`in ${row.s.folder}`, folderWidth),
						pad(state, stateWidth),
						pad(modeWord(row.s.mode), modeWidth),
						row.s.role ? cutRole(row.s.role) : '',
					]
					lines.push(`    ${cells.join('  ').trimEnd()}`)
				}
			}
		}
	}
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
	if (summary.joinRequests.length > 0) {
		lines.push('')
		lines.push(`Join requests (${summary.joinRequests.length})`)
		for (const join of summary.joinRequests) {
			lines.push(`  ${join.name} wants to join your Namzu network`)
			lines.push(
				`    code ${join.code}   from ${join.sourceAddr}   expires in ${minutesLeft(join.expiresAt, now)}`,
			)
		}
	}
	if (summary.joining) {
		lines.push('')
		lines.push(`Waiting for an Allow on another machine (code ${summary.joining.code}).`)
	}
	return fit(lines, input.columns).join('\n')
}

/** Wrap what is wider than the screen at its spaces, keeping the line's indent (plus two for the rest). */
export function fit(lines: readonly string[], columns: number): string[] {
	const width = Math.max(20, columns)
	const out: string[] = []
	for (const line of lines) {
		if (Array.from(line).length <= width) {
			out.push(line)
			continue
		}
		const indent = /^\s*/.exec(line)?.[0] ?? ''
		const next = `${indent}  `
		let current = indent
		for (const word of line.trim().split(/\s+/)) {
			const joined = current.trim() === '' ? `${current}${word}` : `${current} ${word}`
			if (Array.from(joined).length > width && current.trim() !== '') {
				out.push(current)
				current = `${next}${word}`
			} else current = joined
		}
		out.push(current)
	}
	return out
}

/** What the person can do from the picker under `/peers`: one row each, Enter applies. */
export type PeersAction =
	| { readonly kind: 'allow-join'; readonly request: JoinRequestView }
	| { readonly kind: 'deny-join'; readonly request: JoinRequestView }
	| { readonly kind: 'allow-held-remote'; readonly mail: RemoteHeldView }
	| { readonly kind: 'deny-held-remote'; readonly mail: RemoteHeldView }
	| { readonly kind: 'allow-held-local'; readonly mail: HeldLocalView }
	| { readonly kind: 'deny-held-local'; readonly mail: HeldLocalView }

export function peersActions(
	summary: NetworkSummary,
	heldLocal: readonly HeldLocalView[],
): PeersAction[] {
	const actions: PeersAction[] = []
	for (const mail of heldLocal) {
		actions.push({ kind: 'allow-held-local', mail }, { kind: 'deny-held-local', mail })
	}
	for (const mail of summary.held) {
		actions.push({ kind: 'allow-held-remote', mail }, { kind: 'deny-held-remote', mail })
	}
	for (const request of summary.joinRequests)
		actions.push({ kind: 'allow-join', request }, { kind: 'deny-join', request })
	return actions
}

export function describeAction(action: PeersAction): { label: string; description: string } {
	switch (action.kind) {
		case 'allow-join':
			return {
				label: `Allow ${action.request.name}`,
				description: `Let it join your Namzu network (code ${action.request.code}, from ${action.request.sourceAddr}).`,
			}
		case 'deny-join':
			return { label: `Deny ${action.request.name}`, description: 'Do not let it join.' }
		case 'allow-held-remote':
			return {
				label: `Allow once: ${action.mail.machineName} / ${action.mail.fromSessionName}`,
				description: `Deliver this message once. ${action.mail.reason}.`,
			}
		case 'deny-held-remote':
			return {
				label: `Deny: ${action.mail.machineName} / ${action.mail.fromSessionName}`,
				description: 'Refuse this message. The sender is told.',
			}
		case 'allow-held-local':
			return {
				label: `Allow once: ${action.mail.fromName}`,
				description: `Deliver this message once. ${action.mail.reason}.`,
			}
		case 'deny-held-local':
			return {
				label: `Deny: ${action.mail.fromName}`,
				description: 'Refuse this message. The sender is told.',
			}
	}
}
