import type {
	ComputerUseAction,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
	PalComputerControl,
	PalComputerInput,
	PalComputerScreenStream,
	Sandbox,
	SandboxDestroyOptions,
	SandboxReadFileOptions,
} from '@namzu/sdk'
import { generateSandboxId, walkFilesViaExec } from '@namzu/sdk'
import { HttpWorkerClient, workerAuthorization } from '../backends/http-worker-client.js'
import { RemoteCancellationUnknownError } from '../backends/remote-execution-controller.js'
import { type OwnedDetachedProcess, startDetachedGuestProcess } from './detached-process.js'

export interface LocalComputerClientOptions {
	readonly executionUrl: string
	readonly desktopUrl: string
	readonly token: string
	readonly normalExitPolicy?: 'strict' | 'computer-lifetime'
	readonly geometry: DisplayGeometry
	readonly stop: (signal?: AbortSignal) => Promise<void>
	readonly detachedWorkerPath?: string
	/** Set only after the actual guest readiness response advertises RFB. */
	readonly screenStream?: boolean
	/** Set only after the owned guest advertises session-scoped held keys. */
	readonly heldKeyboard?: boolean
}

export function localComputerClients(options: LocalComputerClientOptions): {
	sandbox: Sandbox
	computerUseHost: ComputerUseHost
	operatorControl: PalComputerControl
	screenStream?: PalComputerScreenStream
} {
	let active = true
	let busy = 0
	let mode: PalComputerControl['mode'] = 'pal'
	let uncertain = false
	let screenEpoch = 0
	let needsFreshScreen = false
	let stopping: Promise<void> | undefined
	const detached = new Set<OwnedDetachedProcess>()
	const heldKeyboards = new Map<string, Set<string>>()
	const assertActive = () => {
		if (!active) throw new Error('This Pal computer lease has ended')
	}
	const assertCertain = () => {
		if (uncertain)
			throw new Error(
				'The Pal desktop input outcome is unknown. Stop this computer before retrying.',
			)
	}
	const assertPal = () => {
		assertActive()
		assertCertain()
		if (mode !== 'pal') throw new Error('The operator has control of this Pal computer')
	}
	const stop = (destroyOptions?: SandboxDestroyOptions): Promise<void> => {
		active = false
		if (stopping) return stopping
		stopping = options
			.stop(destroyOptions?.signal)
			.then(async () => {
				// Guest removal is confirmed first. These pipes may now end without
				// being mistaken for proof that a guest process was stopped.
				for (const process of detached) process.child.kill('SIGKILL')
				await Promise.all([...detached].map((process) => process.closed))
			})
			.catch((error: unknown) => {
				stopping = undefined
				throw error
			})
		return stopping
	}
	const headers = {
		'content-type': 'application/json',
		...workerAuthorization(options.token),
	}
	// A successfully completed foreground launcher may leave applications owned
	// by this exclusive computer. Detached jobs use their own strict client.
	const worker = new HttpWorkerClient(
		options.executionUrl,
		options.token,
		options.normalExitPolicy ?? 'computer-lifetime',
	)
	const request = async (route: string, body: unknown, signal?: AbortSignal) => {
		assertPal()
		busy += 1
		try {
			const response = await fetch(`${options.executionUrl}${route}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal,
			})
			if (!response.ok) {
				if (route === '/write-file' && response.status >= 500) uncertain = true
				throw Object.assign(
					new Error(`The Pal file worker refused the operation (${response.status})`),
					{ refused: true },
				)
			}
			const result = (await response.json()) as Record<string, unknown>
			if (route === '/write-file' && result.ok !== true) uncertain = true
			return result
		} catch (error) {
			if (route === '/write-file' && !(error && typeof error === 'object' && 'refused' in error))
				uncertain = true
			throw error
		} finally {
			busy -= 1
		}
	}
	let rangeLimit: number | undefined
	const requireRangeSupport = async (signal?: AbortSignal) => {
		if (rangeLimit !== undefined) return rangeLimit
		let result: Record<string, unknown>
		try {
			result = await request('/read-file', { capabilitiesOnly: true }, signal)
		} catch (error) {
			signal?.throwIfAborted()
			throw new Error(
				'This Pal computer worker did not confirm bounded file reads. Rebuild the local Pal image from the same Namzu release before inspecting artifact images.',
				{ cause: error },
			)
		}
		const capability = result.readFileRanges
		if (
			result.ok !== true ||
			!capability ||
			typeof capability !== 'object' ||
			!('version' in capability) ||
			capability.version !== 1 ||
			!('maxBytes' in capability) ||
			typeof capability.maxBytes !== 'number' ||
			!Number.isSafeInteger(capability.maxBytes) ||
			capability.maxBytes < 1 ||
			capability.maxBytes > 32 * 1024 * 1024
		)
			throw new Error('This Pal computer worker does not acknowledge bounded file reads.')
		rangeLimit = capability.maxBytes
		return rangeLimit
	}
	const sandbox: Sandbox = {
		id: generateSandboxId(),
		environment: 'linux-namespace',
		rootDir: '/home/namzu/workspace',
		get status() {
			return !active ? 'destroyed' : busy > 0 ? 'busy' : 'ready'
		},
		spawnDetached(command, args, spawnOptions) {
			assertPal()
			const process = startDetachedGuestProcess(
				{
					executionUrl: options.executionUrl,
					token: options.token,
					retire: stop,
					workerPath: options.detachedWorkerPath,
				},
				command,
				args,
				spawnOptions,
			)
			detached.add(process)
			void process.closed.then(() => detached.delete(process))
			return process
		},
		async exec(command, args, opts) {
			assertPal()
			busy += 1
			try {
				return await worker.exec(command, args, opts)
			} catch (error) {
				if (error instanceof RemoteCancellationUnknownError) {
					try {
						await stop()
						error.retirement = { accepted: true }
					} catch (retirementError) {
						error.retirement = {
							accepted: false,
							error:
								retirementError instanceof Error
									? retirementError
									: new Error('Computer retirement failed'),
						}
					}
				}
				throw error
			} finally {
				busy -= 1
			}
		},
		async writeFile(path, content) {
			const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
			const result = await request('/write-file', {
				path,
				content: bytes.toString('base64'),
				encoding: 'base64',
			})
			if (result.ok !== true) throw new Error('The Pal file worker did not confirm the write')
		},
		async readFile(path, readOptions?: SandboxReadFileOptions) {
			readOptions?.signal?.throwIfAborted()
			assertPal()
			const ranged = readOptions?.offset !== undefined || readOptions?.length !== undefined
			const offset = readOptions?.offset ?? 0
			const length = readOptions?.length
			if (
				ranged &&
				(!Number.isSafeInteger(offset) ||
					offset < 0 ||
					(length !== undefined &&
						(!Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024)))
			)
				throw new Error('Invalid or oversized Pal file read range')
			const limit = ranged ? await requireRangeSupport(readOptions?.signal) : undefined
			if (length !== undefined && limit !== undefined && length > limit)
				throw new Error('The requested file range exceeds this Pal worker’s acknowledged limit')
			const range = {
				version: 1,
				offset,
				...(length === undefined ? {} : { length }),
			}
			const result = await request(
				'/read-file',
				{ path, encoding: 'base64', ...(ranged ? { range } : {}) },
				readOptions?.signal,
			)
			if (result.ok !== true || typeof result.content !== 'string')
				throw new Error('The Pal file worker did not return a file')
			if (ranged) {
				const received = result.range
				if (
					!received ||
					typeof received !== 'object' ||
					!('version' in received) ||
					received.version !== 1 ||
					!('offset' in received) ||
					received.offset !== offset ||
					!('length' in received) ||
					received.length !== (length ?? null)
				)
					throw new Error('The Pal file worker did not confirm the requested byte range')
				const maximum = length ?? limit ?? 0
				if (result.content.length > Math.ceil(maximum / 3) * 4)
					throw new Error('The Pal file worker exceeded the requested byte range')
			}
			const bytes = Buffer.from(result.content, 'base64')
			if (
				ranged &&
				(bytes.length > (length ?? limit ?? 0) ||
					result.sizeBytes !== bytes.length ||
					bytes.toString('base64') !== result.content)
			)
				throw new Error('The Pal file worker returned invalid bounded file bytes')
			return bytes
		},
		async listFiles(rootPath) {
			assertPal()
			const entries = []
			for await (const entry of walkFilesViaExec((...args) => sandbox.exec(...args), rootPath, {
				maxEntries: 100_000,
			}))
				entries.push(entry)
			return entries
		},
		walkFiles(rootPath, walkOptions) {
			assertPal()
			return walkFilesViaExec((...args) => sandbox.exec(...args), rootPath, walkOptions)
		},
		destroy: stop,
	}
	const executeDesktop = async (
		action: ComputerUseAction | PalComputerInput,
		operator: boolean,
		transitionRelease = false,
	): Promise<ComputerUseResult> => {
		assertActive()
		const held =
			action.type === 'key_down' || action.type === 'key_up' || action.type === 'release_keys'
		if (held && (!operator || !options.heldKeyboard))
			throw new Error('This Pal computer does not support operator held keyboard input')
		const mutation = action.type !== 'screenshot' && action.type !== 'cursor_position'
		const epoch = screenEpoch
		if (mutation) {
			assertCertain()
			if (operator) {
				if (
					mode !== 'operator' &&
					!(transitionRelease && mode === 'transitioning' && action.type === 'release_keys')
				)
					throw new Error('The operator does not have control of this Pal computer')
			} else {
				assertPal()
				if (needsFreshScreen)
					throw new Error('Capture a fresh Pal desktop screenshot before sending input')
			}
		}
		busy += 1
		try {
			let response: Response
			let result: {
				type?: string
				data?: string
				point?: { x: number; y: number }
				outcome?: string
			}
			try {
				response = await fetch(`${options.desktopUrl}/action`, {
					method: 'POST',
					headers,
					body: JSON.stringify(action),
					signal: AbortSignal.timeout(30_000),
				})
				if (response.status >= 500) throw new Error('Desktop outcome was not confirmed')
				if (!response.ok)
					throw Object.assign(
						new Error(`The Pal desktop refused the action (${response.status})`),
						{ refused: true },
					)
				const raw: unknown = await response.json()
				if (!raw || typeof raw !== 'object') throw new Error('Invalid desktop confirmation')
				result = raw as typeof result
				if (
					action.type !== 'screenshot' &&
					action.type !== 'cursor_position' &&
					result.type !== 'ok' &&
					result.outcome !== 'unknown'
				)
					throw new Error('Desktop mutation was not confirmed')
			} catch (error) {
				if (error && typeof error === 'object' && 'refused' in error) throw error
				if (mutation) {
					uncertain = true
					throw Object.assign(
						new Error('The Pal desktop action may have run; do not automatically replay it'),
						{
							code: 'computer_use_outcome_unknown',
							action: action.type,
							outcome: 'unknown',
							retrySafety: 'unsafe',
						},
					)
				}
				throw new Error('The Pal desktop is not responding')
			}
			if (result.outcome === 'unknown') {
				uncertain = true
				throw Object.assign(new Error('The Pal desktop action has an unknown outcome'), {
					code: 'computer_use_outcome_unknown',
					action: action.type,
					outcome: 'unknown',
					retrySafety: 'unsafe',
				})
			}
			if (held && result.type === 'ok') {
				if (action.type === 'key_down') {
					const keys = heldKeyboards.get(action.keyboardId) ?? new Set<string>()
					keys.add(action.key)
					heldKeyboards.set(action.keyboardId, keys)
				} else if (action.type === 'key_up') {
					const keys = heldKeyboards.get(action.keyboardId)
					keys?.delete(action.key)
					if (!keys?.size) heldKeyboards.delete(action.keyboardId)
				} else if (action.type === 'release_keys') heldKeyboards.delete(action.keyboardId)
			}
			if (
				action.type === 'screenshot' &&
				result.type === 'screenshot' &&
				typeof result.data === 'string'
			) {
				const data = Buffer.from(result.data, 'base64')
				if (data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a')
					throw new Error('The Pal desktop returned an invalid PNG')
				const width = data.readUInt32BE(16)
				const height = data.readUInt32BE(20)
				if (mode === 'pal' && epoch === screenEpoch) needsFreshScreen = false
				return {
					type: 'screenshot',
					result: {
						data,
						mimeType: 'image/png',
						width,
						height,
						display: {
							id: 'pal-display',
							x: 0,
							y: 0,
							width,
							height,
							scaleFactor: 1,
							primary: true,
						},
					},
				}
			}
			if (
				action.type === 'cursor_position' &&
				result.type === 'cursor_position' &&
				result.point &&
				Number.isFinite(result.point.x) &&
				Number.isFinite(result.point.y)
			)
				return { type: 'cursor_position', point: result.point }
			if (action.type !== 'screenshot' && action.type !== 'cursor_position' && result.type === 'ok')
				return { type: 'ok' }
			throw new Error('The Pal desktop returned an invalid action result')
		} finally {
			busy -= 1
		}
	}
	const computerUseHost: ComputerUseHost = {
		id: 'pal-local-container-desktop',
		capabilities: {
			displayServer: 'x11',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
			supportedActions: [
				'screenshot',
				'cursor_position',
				'mouse_move',
				'mouse_click',
				'mouse_drag',
				'scroll',
				'type_text',
				'key',
			],
			mouseClickButtons: ['left', 'middle', 'right'],
			mouseDragButtons: ['left', 'middle', 'right'],
		},
		async getDisplayGeometry() {
			assertActive()
			return options.geometry
		},
		execute: (action) => executeDesktop(action, false),
	}
	const transfer = async (from: 'pal' | 'operator', to: 'pal' | 'operator') => {
		assertActive()
		assertCertain()
		if (mode !== from) throw new Error(`This Pal computer is not controlled by ${from}`)
		// This synchronous reservation excludes new guest work before the idle check.
		mode = 'transitioning'
		if (busy > 0 || detached.size > 0) {
			mode = from
			throw new Error(
				'Wait for all Pal computer work and background jobs to stop before changing control',
			)
		}
		try {
			if (to === 'pal')
				for (const keyboardId of heldKeyboards.keys())
					await executeDesktop({ type: 'release_keys', keyboardId }, true, true)
			screenEpoch += 1
			needsFreshScreen = to === 'pal'
			mode = to
		} catch (error) {
			mode = from
			throw error
		}
	}
	const operatorControl: PalComputerControl = {
		...(options.heldKeyboard ? { heldKeyboard: true as const } : {}),
		get mode() {
			return mode
		},
		async takeOver() {
			await transfer('pal', 'operator')
		},
		async returnControl() {
			await transfer('operator', 'pal')
		},
		executeInput(input: PalComputerInput) {
			if (
				![
					'mouse_move',
					'mouse_click',
					'mouse_drag',
					'scroll',
					'type_text',
					'key',
					'key_down',
					'key_up',
					'release_keys',
				].includes(input.type)
			)
				throw new Error('Only desktop input is supported for operator control')
			return executeDesktop(input, true)
		},
	}
	const screenStream = options.screenStream
		? (() => {
				const url = new URL('/stream', options.desktopUrl)
				if (
					url.protocol !== 'http:' ||
					url.hostname !== '127.0.0.1' ||
					url.username ||
					url.password
				)
					throw new Error('The Pal screen stream must use the owned guest loopback transport')
				url.protocol = 'ws:'
				return Object.freeze({
					protocol: 'rfb' as const,
					url: url.href,
					authorization: `Bearer ${options.token}`,
				})
			})()
		: undefined
	return { sandbox, computerUseHost, operatorControl, ...(screenStream ? { screenStream } : {}) }
}
