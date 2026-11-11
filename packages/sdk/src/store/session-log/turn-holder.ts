import { createHash } from 'node:crypto'
import { readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'

/**
 * The name a turn writes into its writer lease: `namzu:<pid>:<turnId>@<place>`.
 *
 * A process id is valid only where it was issued. The place says where: a short token for the
 * machine's host name and, on Linux, the process-id namespace and the machine's own identity. A reader may take a dead process
 * id as proof that the holder is gone only when its own place is the same. A holder written
 * before the place existed ends at the turn id and carries no place.
 */

/** The lengths and shape of the place token: the first 12 hex characters of a SHA-256. */
const PLACE_LENGTH = 12
const PLACE_TAIL = new RegExp(`@([0-9a-f]{${PLACE_LENGTH}})$`)
const HOLDER = /^namzu:([0-9]+):([\s\S]+)$/

/** What a place is made from; a seam so a test can say two places apart. */
export interface PlaceSource {
	readonly hostName: string
	/** The target of `/proc/self/ns/pid`, or undefined where it cannot be read. */
	readonly pidNamespace?: string | undefined
	/** The machine's own identity (`/etc/machine-id`), or undefined where it cannot be read. */
	readonly machineId?: string | undefined
}

/** The token for a host name and an optional process-id namespace identity. */
export function placeOf(source: PlaceSource): string {
	let material = `host:${source.hostName}`
	if (source.pidNamespace) material += `\npidns:${source.pidNamespace}`
	if (source.machineId) material += `\nmachine:${source.machineId}`
	return createHash('sha256').update(material).digest('hex').slice(0, PLACE_LENGTH)
}

function readPidNamespace(): string | undefined {
	try {
		return readlinkSync('/proc/self/ns/pid')
	} catch {
		return undefined
	}
}

function readMachineId(): string | undefined {
	for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
		try {
			const id = readFileSync(path, 'utf8').trim()
			if (id !== '') return id
		} catch {
			// try the next, or go without
		}
	}
	return undefined
}

let cachedPlace: string | undefined

/** Where this process's process id is valid. Computed once per process. */
export function currentPlace(): string {
	cachedPlace ??= placeOf({
		hostName: hostname(),
		pidNamespace: readPidNamespace(),
		machineId: readMachineId(),
	})
	return cachedPlace
}

/** A turn's holder name. `tail` is the turn id (or, for a whole-session operation, the session id). */
export function turnHolder(tail: string, options: { pid?: number; place?: string } = {}): string {
	return `namzu:${options.pid ?? process.pid}:${tail}@${options.place ?? currentPlace()}`
}

export interface ParsedTurnHolder {
	readonly pid: number
	readonly turnId: string
	/** Absent for a holder written before the place existed. */
	readonly place?: string
}

/** Read a holder name; `null` when it is not a turn-shaped holder (another writer's name). */
export function parseTurnHolder(holder: string): ParsedTurnHolder | null {
	const match = HOLDER.exec(holder)
	if (!match) return null
	const pid = Number(match[1])
	if (!Number.isSafeInteger(pid)) return null
	let turnId = match[2] as string
	let place: string | undefined
	const tail = PLACE_TAIL.exec(turnId)
	if (tail) {
		place = tail[1]
		turnId = turnId.slice(0, turnId.length - tail[0].length)
	}
	if (turnId === '') return null
	return place === undefined ? { pid, turnId } : { pid, turnId, place }
}
