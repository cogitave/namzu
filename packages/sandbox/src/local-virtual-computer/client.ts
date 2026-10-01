import type {
	ComputerUseAction,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
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
} {
	let active = true
	let busy = 0
	let stopping: Promise<void> | undefined
	const detached = new Set<OwnedDetachedProcess>()
	const assertActive = () => {
		if (!active) throw new Error('This Pal computer lease has ended')
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
	const headers = { 'content-type': 'application/json', ...workerAuthorization(options.token) }
	const worker = new HttpWorkerClient(options.executionUrl, options.token)
	const request = async (route: string, body: unknown, signal?: AbortSignal) => {
		assertActive()
		const response = await fetch(`${options.executionUrl}${route}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		})
		if (!response.ok)
			throw new Error(`The Pal file worker refused the operation (${response.status})`)
		return (await response.json()) as { ok?: boolean; content?: string }
	}
	const sandbox: Sandbox = {
		id: generateSandboxId(),
		environment: 'linux-namespace',
		rootDir: '/home/namzu/workspace',
		get status() {
			return !active ? 'destroyed' : busy > 0 ? 'busy' : 'ready'
		},
		spawnDetached(command, args, spawnOptions) {
			assertActive()
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
			assertActive()
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
			const entries = []
			for await (const entry of walkFilesViaExec((...args) => sandbox.exec(...args), rootPath, {
				maxEntries: 100_000,
			}))
				entries.push(entry)
			return entries
		},
		walkFiles(rootPath, walkOptions) {
			return walkFilesViaExec((...args) => sandbox.exec(...args), rootPath, walkOptions)
		},
		destroy: stop,
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
		async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
			assertActive()
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
				if (action.type !== 'screenshot' && action.type !== 'cursor_position') {
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
			if (result.outcome === 'unknown')
				throw Object.assign(new Error('The Pal desktop action has an unknown outcome'), {
					code: 'computer_use_outcome_unknown',
					action: action.type,
					outcome: 'unknown',
					retrySafety: 'unsafe',
				})
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
		},
	}
	return { sandbox, computerUseHost }
}
