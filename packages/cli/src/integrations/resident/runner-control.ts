import { timingSafeEqual } from 'node:crypto'
import { type Socket, createConnection, createServer } from 'node:net'

const MAX_MESSAGE_BYTES = 4_096
const MAX_OPEN_SOCKETS = 16
const DEFAULT_TIMEOUT_MS = 1_500
const PHASES = ['starting', 'idle', 'working', 'stopping'] as const

export type RunnerControlPhase = (typeof PHASES)[number]
export type RunnerControlAction = 'status' | 'stop'

export interface RunnerControlStatus {
	readonly pid: number
	readonly phase: RunnerControlPhase
	/** Callback entries admitted by this runner, independent of final settlement. */
	readonly stepsStarted: number
}

export interface RunnerControlServerOptions {
	readonly instanceId: string
	readonly token: string
	readonly getStatus: () => RunnerControlStatus
	/** Signal owned work once. A response acknowledges this request, not drainage. */
	readonly onStop: () => void
}

export interface RunnerControlServer {
	readonly port: number
	/** Refuse new clients and destroy remaining sockets before resolving. */
	close(): Promise<void>
}

export interface RunnerControlRecord {
	readonly instanceId: string
	readonly token: string
	readonly port: number | null
	readonly pid: number | null
}

export type RunnerControlResult =
	| ({
			readonly kind: 'responsive'
			readonly instanceId: string
			readonly stopRequested: boolean
	  } & RunnerControlStatus)
	| {
			readonly kind: 'unresponsive'
			/** No observation here establishes that the process is dead. */
			readonly reason: string
	  }

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value)
	return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function validIdentity(instanceId: string, token: string): boolean {
	return (
		instanceId.length > 0 && instanceId.length <= 256 && token.length > 0 && token.length <= 512
	)
}

function validStatus(value: Record<string, unknown>): boolean {
	return (
		typeof value.pid === 'number' &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		typeof value.phase === 'string' &&
		(PHASES as readonly string[]).includes(value.phase) &&
		typeof value.stepsStarted === 'number' &&
		Number.isSafeInteger(value.stepsStarted) &&
		value.stepsStarted >= 0
	)
}

/**
 * One private, local control endpoint. Authentication is bound to an immutable
 * runner instance, never to a PID alone. No request runs tools or shell commands.
 */
export async function createRunnerControlServer(
	options: RunnerControlServerOptions,
): Promise<RunnerControlServer> {
	if (!validIdentity(options.instanceId, options.token))
		throw new Error('Runner control requires a bounded instance identity and secret token.')
	const expectedToken = Buffer.from(options.token)
	const sockets = new Set<Socket>()
	let stopRequested = false
	let stopFailed = false
	let closing = false
	let closePromise: Promise<void> | undefined
	const requestStop = (): void => {
		if (stopRequested) return
		stopRequested = true
		try {
			options.onStop()
		} catch (error) {
			stopFailed = true
			throw error
		}
	}
	const server = createServer((socket) => {
		socket.on('error', () => {})
		if (closing || sockets.size >= MAX_OPEN_SOCKETS) {
			socket.destroy()
			return
		}
		sockets.add(socket)
		socket.once('close', () => sockets.delete(socket))
		// A total deadline, rather than an inactivity timeout a slow sender can reset.
		const deadline = setTimeout(() => socket.destroy(), DEFAULT_TIMEOUT_MS)
		socket.once('close', () => clearTimeout(deadline))
		let buffered = Buffer.alloc(0)
		let handled = false
		socket.on('data', (chunk: Buffer) => {
			if (handled || buffered.length + chunk.length > MAX_MESSAGE_BYTES) {
				socket.destroy()
				return
			}
			buffered = Buffer.concat([buffered, chunk])
			const newline = buffered.indexOf(10)
			if (newline < 0) return
			handled = true
			if (newline !== buffered.length - 1) {
				socket.destroy()
				return
			}
			try {
				const request: unknown = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
				if (
					!object(request) ||
					!exactKeys(request, ['version', 'instanceId', 'token', 'action']) ||
					request.version !== 1 ||
					request.instanceId !== options.instanceId ||
					typeof request.token !== 'string' ||
					(request.action !== 'status' && request.action !== 'stop')
				) {
					socket.destroy()
					return
				}
				const token = Buffer.from(request.token)
				if (token.length !== expectedToken.length || !timingSafeEqual(token, expectedToken)) {
					socket.destroy()
					return
				}
				if (request.action === 'stop') requestStop()
				if (stopFailed) throw new Error('Runner stop callback failed.')
				const state = options.getStatus()
				if (!object(state) || !validStatus(state)) throw new Error('Invalid runner state.')
				socket.end(
					`${JSON.stringify({
						version: 1,
						instanceId: options.instanceId,
						pid: state.pid,
						phase: stopRequested ? 'stopping' : state.phase,
						stepsStarted: state.stepsStarted,
						stopRequested,
					})}\n`,
				)
			} catch {
				// Request bytes and the secret never enter logs or error responses.
				socket.destroy()
			}
		})
	})
	const close = (): Promise<void> => {
		if (closePromise) return closePromise
		closing = true
		closePromise = new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
					reject(error)
				else resolve()
			})
			for (const socket of sockets) socket.destroy()
		})
		return closePromise
	}
	await new Promise<void>((resolve, reject) => {
		const failed = (error: Error): void => reject(error)
		server.once('error', failed)
		server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
			server.removeListener('error', failed)
			resolve()
		})
	})
	// Losing the installed control endpoint stops admission through the same
	// callback; it does not leave an uncontrolled runner claiming to be healthy.
	server.on('error', () => {
		try {
			requestStop()
		} catch {
			/* The owner is already being stopped. */
		}
		void close().catch(() => {})
	})
	const address = server.address()
	if (address === null || typeof address === 'string') {
		await close()
		throw new Error('Runner control did not acquire a loopback port.')
	}
	return { port: address.port, close }
}

/** An authenticated response proves responsiveness; absence never proves death. */
export function queryRunner(
	record: RunnerControlRecord,
	action: RunnerControlAction,
	options: { readonly timeoutMs?: number } = {},
): Promise<RunnerControlResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
		throw new Error('Runner control timeout must be a whole number from 1 to 60000 milliseconds.')
	if (
		!validIdentity(record.instanceId, record.token) ||
		!Number.isSafeInteger(record.port) ||
		(record.port ?? 0) < 1 ||
		(record.port ?? 0) > 65_535 ||
		!Number.isSafeInteger(record.pid) ||
		(record.pid ?? 0) < 1 ||
		(action !== 'status' && action !== 'stop')
	)
		return Promise.resolve({
			kind: 'unresponsive',
			reason: 'Runner control endpoint is unavailable.',
		})
	return new Promise<RunnerControlResult>((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port: record.port as number })
		let settled = false
		let buffered = Buffer.alloc(0)
		const finish = (result: RunnerControlResult): void => {
			if (settled) return
			settled = true
			clearTimeout(deadline)
			socket.destroy()
			resolve(result)
		}
		const unresponsive = (reason: string): void => finish({ kind: 'unresponsive', reason })
		const deadline = setTimeout(() => unresponsive('Runner control response timed out.'), timeoutMs)
		socket.once('error', () => unresponsive('Runner control connection failed.'))
		socket.once('close', () => unresponsive('Runner control closed without a valid response.'))
		socket.once('connect', () => {
			socket.write(
				`${JSON.stringify({ version: 1, instanceId: record.instanceId, token: record.token, action })}\n`,
			)
		})
		socket.on('data', (chunk: Buffer) => {
			if (buffered.length + chunk.length > MAX_MESSAGE_BYTES) {
				unresponsive('Runner control response exceeded its size limit.')
				return
			}
			buffered = Buffer.concat([buffered, chunk])
			const newline = buffered.indexOf(10)
			if (newline < 0) return
			try {
				const response: unknown = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
				if (
					newline !== buffered.length - 1 ||
					!object(response) ||
					!exactKeys(response, [
						'version',
						'instanceId',
						'pid',
						'phase',
						'stepsStarted',
						'stopRequested',
					]) ||
					response.version !== 1 ||
					response.instanceId !== record.instanceId ||
					response.pid !== record.pid ||
					!validStatus(response) ||
					typeof response.stopRequested !== 'boolean' ||
					(response.stopRequested && response.phase !== 'stopping') ||
					(action === 'stop' && !response.stopRequested)
				)
					throw new Error('Invalid response.')
				finish({
					kind: 'responsive',
					instanceId: record.instanceId,
					pid: response.pid as number,
					phase: response.phase as RunnerControlPhase,
					stepsStarted: response.stepsStarted as number,
					stopRequested: response.stopRequested,
				})
			} catch {
				unresponsive('Runner control returned an invalid response.')
			}
		})
	})
}
