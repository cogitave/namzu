/**
 * What a person sees of their machines: a roster of machines, each with its
 * live sessions. The name is the address: a session is reached by its name,
 * with a short ref added to a row only when two rows share a name.
 *
 * Session names are the session's title, or a readable `<adjective>-<noun>`
 * derived from its id so the name is stable for the life of the session.
 *
 * @experimental
 */

import { createHash } from 'node:crypto'
import type { RosterSession } from './wire.js'

const ADJECTIVES = [
	'calm',
	'quiet',
	'swift',
	'brisk',
	'bright',
	'gentle',
	'steady',
	'keen',
	'merry',
	'nimble',
	'proud',
	'rustic',
	'sunny',
	'tidy',
	'warm',
	'witty',
] as const
const NOUNS = [
	'heron',
	'otter',
	'finch',
	'marten',
	'badger',
	'falcon',
	'lynx',
	'wren',
	'maple',
	'cedar',
	'harbor',
	'meadow',
	'comet',
	'ember',
	'river',
	'summit',
] as const

/** A readable name chosen deterministically from the session id. */
export function generateSessionName(sessionId: string): string {
	const digest = createHash('sha256').update(sessionId, 'utf8').digest()
	return `${ADJECTIVES[(digest[0] as number) % ADJECTIVES.length]}-${NOUNS[(digest[1] as number) % NOUNS.length]}`
}

export function sessionDisplayName(session: {
	readonly sessionId: string
	readonly title?: string
}): string {
	const title = session.title?.trim()
	return title ? title : generateSessionName(session.sessionId)
}

/** A live session of this machine, as a host reports it. `conversationId` never goes on the wire. */
export interface LocalSession extends RosterSession {
	readonly conversationId?: string
	/** The terminal is in a mode that skips permission prompts; every message to it is held. Never on the wire. */
	readonly bypass?: boolean
}

export type MachineStatus = 'self' | 'online' | 'offline'

export interface RosterMachineView {
	readonly machineId: string
	readonly name: string
	readonly status: MachineStatus
	/** Epoch ms of the last answer; absent for this machine. */
	readonly seenAt?: number
	readonly role?: string
	/**
	 * True when this machine is another home of the same person on this computer: it joined, or let this one
	 * in, by proving the computer secret, and the secret still reads. A live fact, not part of any signed record.
	 */
	readonly sameComputer?: boolean
	readonly sessions: readonly RosterSession[]
}

export interface RosterView {
	readonly machines: readonly RosterMachineView[]
}

/** The name to show for a machine: its own name, plus six hex of its id when another machine has the same name. */
export function machineLabel(view: RosterView, machine: RosterMachineView): string {
	const same = view.machines.filter((m) => m.name === machine.name).length > 1
	return same ? `${machine.name} (${machine.machineId.slice(0, 6)})` : machine.name
}

/** The name to show for a session: its name, plus `[ref]` only when two sessions in the roster share it. */
export function sessionLabel(
	view: RosterView,
	machine: RosterMachineView,
	session: RosterSession,
): string {
	let count = 0
	for (const m of view.machines) for (const s of m.sessions) if (s.name === session.name) count++
	const sameMachine = machine.sessions.filter((s) => s.name === session.name).length > 1
	return count > 1 && (sameMachine || view.machines.length > 1)
		? `${session.name} [${session.ref}]`
		: session.name
}

export type TargetResolution =
	| { readonly ok: true; readonly machine: RosterMachineView; readonly session: RosterSession }
	| {
			readonly ok: false
			readonly reason: 'none' | 'ambiguous'
			readonly candidates: readonly string[]
	  }

/**
 * Resolve what a person typed. Accepts `machine/session`, a session name, or a
 * `[ref]` / bare ref. Offline machines are not targets.
 */
export function resolveSessionTarget(view: RosterView, text: string): TargetResolution {
	const wanted = text.trim()
	const slash = wanted.indexOf('/')
	const machinePart = slash >= 0 ? wanted.slice(0, slash).trim().toLowerCase() : undefined
	const sessionPart = (slash >= 0 ? wanted.slice(slash + 1) : wanted).trim()
	const bracket = /^(.*?)\s*\[([0-9a-f]{6})\]$/.exec(sessionPart)
	const wantedName = (bracket ? (bracket[1] as string) : sessionPart).trim().toLowerCase()
	const wantedRef = bracket
		? (bracket[2] as string)
		: /^[0-9a-f]{6}$/.test(sessionPart)
			? sessionPart
			: undefined
	const hits: { machine: RosterMachineView; session: RosterSession }[] = []
	for (const machine of view.machines) {
		if (machine.status === 'offline') continue
		if (machinePart !== undefined && machine.name.toLowerCase() !== machinePart) continue
		for (const session of machine.sessions) {
			const nameOk = wantedName.length > 0 && session.name.toLowerCase() === wantedName
			const refOk = wantedRef !== undefined && session.ref === wantedRef
			if (bracket ? refOk && (wantedName.length === 0 || nameOk) : nameOk || refOk)
				hits.push({ machine, session })
		}
	}
	const unique = [
		...new Map(hits.map((h) => [`${h.machine.machineId}/${h.session.ref}`, h])).values(),
	]
	if (unique.length === 1) return { ok: true, ...(unique[0] as (typeof unique)[number]) }
	return {
		ok: false,
		reason: unique.length === 0 ? 'none' : 'ambiguous',
		candidates: unique.map((h) => `${h.machine.name}/${h.session.name} [${h.session.ref}]`),
	}
}

/** The most a member's last roster is believed once it stops answering. */
export const ROSTER_CACHE_MS = 24 * 60 * 60 * 1000

/** Apply the offline rule: a member that did not answer keeps its cached sessions for 24 hours, shown offline. */
export function offlineSessions(
	sessions: readonly RosterSession[],
	seenAt: number,
	now: number,
): readonly RosterSession[] {
	return now - seenAt > ROSTER_CACHE_MS ? [] : sessions
}
