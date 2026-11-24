import { homedir } from 'node:os'
import { basename } from 'node:path'
import { type RosterView, permissionModeWord } from '@namzu/sdk'

/**
 * One list of sessions for `/peers`, `namzu peers list` and the network view: a counted header, then one
 * line per session, `[state]  ·  name  ·  where or when`, and the extras (folder, mode, role) on a second
 * indented line so the first line stays short.
 */

export interface SessionRow {
	readonly ref: string
	/** The name shown; when `named` is false it is only a folder or a generated word. */
	readonly name: string
	/** The person (or the conversation) gave this session a name of its own. */
	readonly named: boolean
	readonly folder?: string
	readonly state: string
	/** Epoch ms this session started, when this machine knows it (never on the network wire). */
	readonly startedAt?: number
	/** The machine a session runs on; undefined for this machine. */
	readonly machine?: string
	/** That machine is another Namzu home of this person on this computer. */
	readonly sameComputer?: boolean
	readonly self?: boolean
	/** The permission mode in the words a person uses (`auto`, `plan`, ...). */
	readonly mode?: string
	readonly role?: string
	readonly acceptsMessages?: boolean
}

export interface MachineRow {
	readonly name: string
	readonly self: boolean
	/** Another Namzu home of this person on this computer. */
	readonly sameComputer?: boolean
	readonly online: boolean
	/** Epoch ms the machine was last heard from, when it is offline. */
	readonly seenAt?: number
	readonly role?: string
}

export interface SessionListOptions {
	readonly now: number
	/** The width to fit; leave out to print every word (piped output). */
	readonly columns?: number
	readonly machines?: readonly MachineRow[]
	/** What an empty list says; by default every session on every machine is meant. */
	readonly emptyText?: string
	/** What the list is limited to, said in the header (for example `in this project`); leave out for every machine. */
	readonly scope?: string
}

export const UNNAMED = '(unnamed session)'
const ROLE_CUT = 60
const SEP = '  ·  '

export function cutRole(role: string, max = ROLE_CUT): string {
	const chars = Array.from(role)
	return chars.length <= max ? role : `${chars.slice(0, max - 1).join('')}…`
}

const width = (text: string) => Array.from(text).length

/** The single largest unit, as a short word: 23s, 7m, 7h, 3d. Never negative. */
export function ageWord(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** Wrap what is wider than the screen at its spaces, keeping the line's indent (plus two for the rest). */
export function fit(lines: readonly string[], columns: number): string[] {
	const limit = Math.max(20, columns)
	const out: string[] = []
	for (const line of lines) {
		if (width(line) <= limit) {
			out.push(line)
			continue
		}
		const indent = /^\s*/.exec(line)?.[0] ?? ''
		const next = `${indent}  `
		// Split keeping the exact spaces between words, so the two-space grammar of a row survives a wrap.
		const parts = line.trim().split(/(\s+)/)
		let current = indent
		for (let index = 0; index < parts.length; index += 2) {
			const word = parts[index] as string
			const gap = index === 0 ? '' : (parts[index - 1] as string)
			const joined = current.trim() === '' ? `${current}${word}` : `${current}${gap}${word}`
			if (width(joined) > limit && current.trim() !== '') {
				out.push(current)
				current = `${next}${word}`
			} else current = joined
		}
		out.push(current)
	}
	return out
}

/**
 * The order of the list: this terminal, then this machine newest first (unknown last), then the other homes
 * of this computer, then other machines, each group by machine name.
 */
export function sortSessions(rows: readonly SessionRow[]): SessionRow[] {
	const rank = (row: SessionRow) =>
		row.self ? 0 : row.machine === undefined ? 1 : row.sameComputer ? 2 : 3
	return [...rows].sort((a, b) => {
		if (rank(a) !== rank(b)) return rank(a) - rank(b)
		if (a.machine !== undefined && b.machine !== undefined && a.machine !== b.machine)
			return a.machine.localeCompare(b.machine)
		if (a.machine === undefined) {
			const x = a.startedAt ?? Number.NEGATIVE_INFINITY
			const y = b.startedAt ?? Number.NEGATIVE_INFINITY
			if (x !== y) return x > y ? -1 : 1
		}
		return a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref)
	})
}

/**
 * The sessions of a roster as rows. `startTimes` (ref to epoch ms) comes from this machine's own records:
 * the network does not carry a start time, so another machine's sessions have none.
 */
export function rowsFromRoster(
	view: RosterView,
	options: { readonly selfRef?: string; readonly startTimes?: ReadonlyMap<string, number> } = {},
): SessionRow[] {
	const rows: SessionRow[] = []
	for (const machine of view.machines) {
		const here = machine.status === 'self'
		for (const session of machine.sessions) {
			const startedAt = here ? options.startTimes?.get(session.ref) : undefined
			rows.push({
				ref: session.ref,
				name: session.name,
				named: session.name !== session.folder,
				folder: session.folder,
				state: machine.status === 'offline' ? 'offline' : session.state,
				...(startedAt !== undefined ? { startedAt } : {}),
				...(here ? {} : { machine: machine.name }),
				...(!here && machine.sameComputer ? { sameComputer: true } : {}),
				self: here && session.ref === options.selfRef,
				mode: permissionModeWord(session.mode),
				...(session.role ? { role: session.role } : {}),
				acceptsMessages: session.acceptsMessages && machine.status !== 'offline',
			})
		}
	}
	return rows
}

export function machinesFromRoster(view: RosterView): MachineRow[] {
	// This machine first, then the other homes of this computer, then the machines elsewhere.
	const rank = (machine: RosterView['machines'][number]) =>
		machine.status === 'self' ? 0 : machine.sameComputer ? 1 : 2
	return [...view.machines]
		.sort((a, b) => rank(a) - rank(b))
		.map((machine) => ({
			name: machine.name,
			self: machine.status === 'self',
			...(machine.status !== 'self' && machine.sameComputer ? { sameComputer: true } : {}),
			online: machine.status !== 'offline',
			...(machine.seenAt ? { seenAt: machine.seenAt } : {}),
			...(machine.role ? { role: machine.role } : {}),
		}))
}

function machinesSection(machines: readonly MachineRow[], now: number): string[] {
	// One online machine without a role is the plain case: nothing to add to the list above.
	if (machines.length < 2 && !machines.some((machine) => machine.role || !machine.online)) return []
	const lines = ['', `Machines (${machines.length}):`]
	for (const machine of machines) {
		const fields = [machine.online ? '[online]' : '[offline]', machine.name]
		if (machine.self) fields.push('this machine')
		else if (machine.sameComputer) fields.push('this computer')
		if (!machine.self && !machine.online && machine.seenAt)
			fields.push(`last seen ${ageWord(Math.max(0, now - machine.seenAt))} ago`)
		if (machine.role) fields.push(`role: ${cutRole(machine.role.replace(/\s+/g, ' ').trim())}`)
		lines.push(`  ${fields.join(SEP)}`)
	}
	return lines
}

/** The list, one array element per line (not yet wrapped; `formatSessionList` wraps). */
export function sessionListLines(
	rows: readonly SessionRow[],
	options: SessionListOptions,
): string[] {
	const { now, columns } = options
	const narrow = columns !== undefined && columns < 60
	const lines: string[] = []
	if (rows.length === 0) {
		lines.push(options.emptyText ?? 'No Namzu sessions are running.')
	} else {
		lines.push(`Namzu sessions${options.scope ? ` ${options.scope}` : ''} (${rows.length}):`)
		const sorted = sortSessions(rows)
		const shown = (row: SessionRow) => (row.named ? row.name : UNNAMED)
		const counts = new Map<string, number>()
		for (const row of sorted) counts.set(shown(row), (counts.get(shown(row)) ?? 0) + 1)
		for (const row of sorted) {
			const label = shown(row)
			// A ref only tells two rows with the same label apart.
			const name = (counts.get(label) ?? 0) > 1 ? `${label} [${row.ref}]` : label
			const where: string[] = []
			if (row.self) where.push('this terminal')
			if (row.machine !== undefined)
				where.push(row.sameComputer ? `${row.machine} (this computer)` : row.machine)
			else if (row.startedAt !== undefined)
				where.push(`started ${ageWord(Math.max(0, now - row.startedAt))} ago`)
			const extras: string[] = []
			if (row.folder) extras.push(`in ${row.folder}`)
			if (row.mode) extras.push(`${row.mode} mode`)
			if (row.acceptsMessages === false && row.state !== 'offline')
				extras.push('not accepting messages')
			if (narrow) {
				lines.push(`  [${row.state}]${SEP}${name}`)
				if (where.length > 0) lines.push(`      ${where.join(SEP)}`)
			} else lines.push(`  ${[`[${row.state}]`, name, ...where].join(SEP)}`)
			if (extras.length > 0) lines.push(`      ${extras.join(SEP)}`)
			if (row.role) {
				const prefix = '      role: '
				const text = row.role.replace(/\s+/g, ' ').trim()
				lines.push(
					`${prefix}${columns === undefined ? text : cutRole(text, Math.max(12, columns - width(prefix)))}`,
				)
			}
		}
		if (sorted.some((row) => !row.named)) {
			lines.push('')
			lines.push(
				`Sessions shown as ${UNNAMED} have no name of their own: /rename <name> in that terminal gives one others can message.`,
			)
		}
	}
	lines.push(...machinesSection(options.machines ?? [], now))
	return lines
}

export function formatSessionList(
	rows: readonly SessionRow[],
	options: SessionListOptions,
): string {
	const lines = sessionListLines(rows, options)
	return (options.columns === undefined ? lines : fit(lines, options.columns)).join('\n')
}

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() !== '' ? value : undefined

/**
 * Rows from what `list_sessions` reports (a live-session record's fields, or a network roster row's). A name
 * equal to the folder's own name is the default title, so it counts as no name.
 */
/** A folder as a person writes it: under home it starts with `~`, anywhere else it is the full path. */
export function tildeFolder(path: string, home: string = homedir()): string {
	if (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)))
		return `~${path.slice(home.length)}`
	return path
}

export function rowsFromLocalList(list: readonly Record<string, unknown>[]): SessionRow[] {
	return list.map((entry) => {
		const cwd = text(entry.cwd)
		const folder = text(entry.folder) ?? (cwd ? tildeFolder(cwd) : undefined)
		const own = cwd ? basename(cwd) : folder
		const name = text(entry.title) ?? text(entry.name) ?? String(entry.ref ?? '')
		const mode = text(entry.permission_mode)
		const role = text(entry.role)
		return {
			ref: String(entry.ref ?? ''),
			name,
			named: name !== own && name !== entry.ref,
			...(folder ? { folder } : {}),
			state: text(entry.state) ?? 'idle',
			...(typeof entry.started_at === 'number' ? { startedAt: entry.started_at } : {}),
			self: entry.self === true,
			...(mode ? { mode } : {}),
			...(role ? { role } : {}),
			acceptsMessages: entry.accepts_messages !== false,
		}
	})
}
