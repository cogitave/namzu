import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { type Server, type Socket, connect, createServer } from 'node:net'
import { join } from 'node:path'
import { type RosterView, startedBySession } from '@namzu/sdk'
import type { NetworkControl } from './types.js'

/**
 * How the terminal that runs the Namzu network service is reached by the others on this machine and by
 * `namzu peers`. A Unix socket (a named pipe on Windows) inside the user's private peer runtime directory,
 * with a token kept in `<home>/network/control.json` (0600): a process of another account can neither
 * reach the socket nor read the token. One request line, one reply line, each in JSON.
 *
 * This is local control only. It carries no message text from another machine and is never reachable from
 * the network: the service's own listener speaks `namzu-net/1`, this one speaks to the person.
 */

const MAX_REQUEST_BYTES = 64 * 1024
const MAX_REPLY_BYTES = 2 * 1024 * 1024
const DEADLINE_MS = 20_000
const INFO_FILE = 'control.json'

export interface ControlInfo {
	readonly address: string
	readonly token: string
	readonly pid: number
}

export class ControlError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message)
	}
}

export function readControlInfo(dir: string): ControlInfo | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, INFO_FILE), 'utf8')) as Partial<ControlInfo>
		if (
			typeof parsed.address === 'string' &&
			typeof parsed.token === 'string' &&
			Number.isInteger(parsed.pid)
		)
			return parsed as ControlInfo
	} catch {
		// not running
	}
	return undefined
}

export function writeControlInfo(dir: string, info: ControlInfo): void {
	const temp = join(dir, `${INFO_FILE}.${process.pid}.tmp`)
	writeFileSync(temp, `${JSON.stringify(info)}\n`, { mode: 0o600 })
	renameSync(temp, join(dir, INFO_FILE))
}

export function removeControlInfo(dir: string, pid: number): void {
	if (readControlInfo(dir)?.pid !== pid) return
	try {
		unlinkSync(join(dir, INFO_FILE))
	} catch {
		// already gone
	}
}

export function newControlToken(): string {
	return randomBytes(32).toString('hex')
}

/** `op` names a method of {@link NetworkControl}; `args` are its arguments. */
type Dispatch = (op: string, args: readonly unknown[]) => Promise<unknown>

export interface ControlServer {
	close(): Promise<void>
}

/** Who is asking, as the caller says it; the server judges it. */
export interface ControlCaller {
	readonly pid?: number
	/** The caller's environment carries the marker of a process a session started. */
	readonly underSession?: boolean
}

/** The requests that decide for the person: admit, remove, let held mail in. */
export const PERSON_ONLY_OPS: readonly string[] = [
	'allow',
	'allowHeld',
	'remove',
	'untrust',
	'renameNetwork',
]

export async function startControlServer(options: {
	readonly path: string
	readonly token: string
	readonly dispatch: Dispatch
	/** A reason to refuse `op` for this caller, or undefined to go on. */
	readonly guard?: (op: string, caller: ControlCaller) => string | undefined
}): Promise<ControlServer> {
	const expected = Buffer.from(options.token)
	const isPipe = options.path.startsWith('\\\\')
	if (!isPipe) {
		try {
			// The caller holds the leader lock, so a socket left here belongs to a leader that is gone.
			if (lstatSync(options.path).isSocket()) unlinkSync(options.path)
		} catch {
			// nothing there
		}
	}
	const sockets = new Set<Socket>()
	const server: Server = createServer((socket) => {
		socket.on('error', () => {})
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		const deadline = setTimeout(() => socket.destroy(), DEADLINE_MS)
		deadline.unref?.()
		socket.once('close', () => clearTimeout(deadline))
		let buffered = Buffer.alloc(0)
		let handled = false
		socket.on('data', (chunk) => {
			if (handled) return
			buffered = Buffer.concat([buffered, chunk])
			if (buffered.length > MAX_REQUEST_BYTES) {
				socket.destroy()
				return
			}
			const end = buffered.indexOf(0x0a)
			if (end < 0) return
			handled = true
			void answer(buffered.subarray(0, end).toString('utf8'))
		})
		const reply = (value: unknown) => {
			const line = `${JSON.stringify(value)}\n`
			socket.end(
				Buffer.byteLength(line) > MAX_REPLY_BYTES ? '{"ok":false,"error":"too large"}\n' : line,
			)
		}
		const answer = async (text: string) => {
			let request: { token?: unknown; op?: unknown; args?: unknown; caller?: unknown }
			try {
				request = JSON.parse(text)
			} catch {
				socket.destroy()
				return
			}
			const presented = Buffer.from(typeof request.token === 'string' ? request.token : '')
			if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
				socket.destroy()
				return
			}
			if (typeof request.op !== 'string' || !Array.isArray(request.args)) {
				reply({ ok: false, error: 'Bad request.' })
				return
			}
			const caller = (
				typeof request.caller === 'object' && request.caller !== null ? request.caller : {}
			) as { pid?: unknown; underSession?: unknown }
			const refusal = options.guard?.(request.op, {
				...(Number.isInteger(caller.pid) ? { pid: caller.pid as number } : {}),
				underSession: caller.underSession === true,
			})
			if (refusal) {
				reply({ ok: false, error: refusal, code: 'person-only' })
				return
			}
			try {
				reply({ ok: true, result: (await options.dispatch(request.op, request.args)) ?? null })
			} catch (error) {
				reply({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					...(error instanceof Error && 'code' in error && typeof error.code === 'string'
						? { code: error.code }
						: {}),
				})
			}
		}
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(options.path, () => {
			server.off('error', reject)
			resolve()
		})
	})
	if (!isPipe) {
		try {
			chmodSync(options.path, 0o600)
		} catch {
			// The directory is private already.
		}
	}
	return {
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
				if (!isPipe) {
					try {
						unlinkSync(options.path)
					} catch {
						// gone already
					}
				}
			}),
	}
}

/** One call to the leader's control socket. Rejects with a {@link ControlError} carrying its words. */
export function callControl(
	info: ControlInfo,
	op: string,
	args: readonly unknown[],
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = connect(info.address)
		const chunks: Buffer[] = []
		let size = 0
		const fail = (message: string) => {
			socket.destroy()
			reject(new ControlError(message, 'unreachable'))
		}
		const timer = setTimeout(
			() => fail('The terminal that runs the network did not answer.'),
			DEADLINE_MS,
		)
		timer.unref?.()
		socket.on('error', () => fail('The terminal that runs the network is not reachable.'))
		socket.on('connect', () => {
			socket.write(
				`${JSON.stringify({
					token: info.token,
					op,
					args,
					caller: { pid: process.pid, underSession: startedBySession(process.env) },
				})}\n`,
			)
		})
		socket.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_REPLY_BYTES) fail('The answer was too large.')
			else chunks.push(chunk)
		})
		socket.on('close', () => {
			clearTimeout(timer)
			let reply: { ok?: boolean; result?: unknown; error?: string; code?: string }
			try {
				reply = JSON.parse(Buffer.concat(chunks).toString('utf8').trim())
			} catch {
				reject(
					new ControlError('The terminal that runs the network gave no answer.', 'unreachable'),
				)
				return
			}
			if (reply.ok) resolve(reply.result)
			else reject(new ControlError(reply.error ?? 'The request failed.', reply.code))
		})
	})
}

/** The methods the control channel exposes: exactly {@link NetworkControl}, nothing else is dispatched. */
export const CONTROL_OPS = [
	'summary',
	'roster',
	'allow',
	'networks',
	'untrust',
	'renameNetwork',
	'deny',
	'remove',
	'rename',
	'setRole',
	'send',
	'add',
	'join',
	'cancelJoin',
	'allowHeld',
	'denyHeld',
	'reportDelivered',
] as const satisfies readonly (keyof NetworkControl)[]

export function controlDispatch(control: NetworkControl): Dispatch {
	return async (op, args) => {
		if (!(CONTROL_OPS as readonly string[]).includes(op)) throw new ControlError('Unknown request.')
		const method = control[op as (typeof CONTROL_OPS)[number]] as (
			...a: unknown[]
		) => Promise<unknown>
		return method.apply(control, args as unknown[])
	}
}

/** A {@link NetworkControl} that asks the leader terminal; `info` is read at each call, so a new leader is found. */
export function createControlClient(info: () => ControlInfo | undefined): NetworkControl {
	const call = <T>(op: (typeof CONTROL_OPS)[number], ...args: unknown[]): Promise<T> => {
		const current = info()
		if (!current)
			return Promise.reject(
				new ControlError(
					'No Namzu terminal is running here; the network needs one open.',
					'no-leader',
				),
			)
		return callControl(current, op, args) as Promise<T>
	}
	return {
		summary: () => call('summary'),
		roster: () => call<RosterView>('roster'),
		allow: (query, options) => (options ? call('allow', query, options) : call('allow', query)),
		networks: () => call('networks'),
		untrust: (query) => call('untrust', query),
		renameNetwork: (query, name) => call('renameNetwork', query, name),
		deny: (query) => call('deny', query),
		remove: (machine, options) => call('remove', machine, options ?? {}),
		rename: (name, machine) => call('rename', name, machine),
		setRole: (target, role) => call('setRole', target, role),
		send: (target, text, from) => call('send', target, text, from),
		add: (hostPort) => call('add', hostPort),
		join: (endpoint) => call('join', endpoint),
		cancelJoin: () => call('cancelJoin'),
		allowHeld: (id) => call('allowHeld', id),
		denyHeld: (id) => call('denyHeld', id),
		reportDelivered: (machineId, mailId, sessionRef) =>
			call('reportDelivered', machineId, mailId, sessionRef),
	}
}
