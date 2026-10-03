import type {
	ComputerUseAction,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
	PalComputerControl,
	PalComputerInput,
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
	readonly geometry: DisplayGeometry
	readonly stop: (signal?: AbortSignal) => Promise<void>
	readonly detachedWorkerPath?: string
}

export function localComputerClients(options: LocalComputerClientOptions): {
	sandbox: Sandbox
	computerUseHost: ComputerUseHost
	operatorControl: PalComputerControl
} {
	let active = true
	let busy = 0
	let mode: PalComputerControl['mode'] = 'pal'
	let uncertain = false
	let screenEpoch = 0
	let needsFreshScreen = false
	let stopping: Promise<void> | undefined
	const detached = new Set<OwnedDetachedProcess>()
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
	const worker = new HttpWorkerClient(options.executionUrl, options.token)
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
			const result = (await response.json()) as { ok?: boolean; content?: string }
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
			if (readOptions?.offset !== undefined || readOptions?.length !== undefined)
				throw new Error('The Pal file worker does not support ranged reads')
			const result = await request('/read-file', { path, encoding: 'base64' }, readOptions?.signal)
			if (result.ok !== true || typeof result.content !== 'string')
				throw new Error('The Pal file worker did not return a file')
			return Buffer.from(result.content, 'base64')
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
		action: ComputerUseAction,
		operator: boolean,
	): Promise<ComputerUseResult> => {
		assertActive()
		const mutation = action.type !== 'screenshot' && action.type !== 'cursor_position'
		const epoch = screenEpoch
		if (mutation) {
			assertCertain()
			if (operator) {
				if (mode !== 'operator')
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
	const transfer = (from: 'pal' | 'operator', to: 'pal' | 'operator') => {
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
		screenEpoch += 1
		needsFreshScreen = to === 'pal'
		mode = to
	}
	const operatorControl: PalComputerControl = {
		get mode() {
			return mode
		},
		async takeOver() {
			transfer('pal', 'operator')
		},
		async returnControl() {
			transfer('operator', 'pal')
		},
		executeInput(input: PalComputerInput) {
			if (
				!['mouse_move', 'mouse_click', 'mouse_drag', 'scroll', 'type_text', 'key'].includes(
					input.type,
				)
			)
				throw new Error('Only desktop input is supported for operator control')
			return executeDesktop(input, true)
		},
	}
	return { sandbox, computerUseHost, operatorControl }
}
