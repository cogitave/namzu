import { randomUUID } from 'node:crypto'
import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DesktopDiagnosticsView } from '../shared/protocol.js'

const LIMIT = 512 * 1024
const EVENTS = {
	started: 'Desktop host started',
	startup_failed: 'Desktop host startup failed',
	unhandled_error: 'Desktop host reported an unhandled error',
	shutdown_failed: 'Desktop host shutdown failed',
	ipc_failed: 'Desktop operation failed',
	cli_started: 'Desktop CLI connection started',
	cli_stderr: 'Desktop CLI wrote diagnostic output',
	cli_notice: 'Desktop CLI reported an unavailable capability',
	cli_request_failed: 'Desktop CLI request failed',
	cli_turn_failed: 'Desktop CLI turn failed',
	cli_transport_failed: 'Desktop CLI transport failed',
	cli_closed: 'Desktop CLI connection closed',
	renderer_failed: 'Desktop renderer reported an error',
	renderer_load_failed: 'Desktop renderer could not load',
	renderer_process_gone: 'Desktop renderer process ended',
	project_restore_failed: 'Desktop project restoration failed',
	rate_limited: 'Desktop diagnostics were rate limited',
} as const
export type DesktopDiagnosticEvent = keyof typeof EVENTS
export type DesktopDiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error'
export interface DesktopDiagnosticContext {
	severity?: DesktopDiagnosticSeverity
	error?: unknown
	operation?: string
	connection?: string
	request?: number
	bytes?: number
	exitCode?: number | null
	rpcCode?: number
	engine?: 'default-docker' | 'docker' | 'podman' | 'invalid'
	platform?: 'win32' | 'linux' | 'darwin' | 'other'
	line?: number
	column?: number
	reason?:
		| 'type-error'
		| 'reference-error'
		| 'unhandled-rejection'
		| 'process-ended'
		| 'turn-failed'
}
export interface DesktopDiagnosticSink {
	record(event: DesktopDiagnosticEvent, context?: DesktopDiagnosticContext): void
}
const OS_CODES = new Set([
	'ENOENT',
	'EACCES',
	'EPERM',
	'EPIPE',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'ENOSPC',
	'EIO',
	'ENOTDIR',
	'EISDIR',
	'ERR_INVALID_ARG_TYPE',
	'ERR_MODULE_NOT_FOUND',
])
const OPERATIONS = new Set([
	'windowChrome',
	'setWindowAppearance',
	'popupWindowMenu',
	'diagnostics',
	'openLogs',
	'projects',
	'pals',
	'palProviders',
	'palModels',
	'createPal',
	'updatePal',
	'openPal',
	'palComputer',
	'startPalComputer',
	'stopPalComputer',
	'palScreen',
	'openProject',
	'reconnectProject',
	'trustProject',
	'conversations',
	'newConversation',
	'openConversation',
	'providers',
	'models',
	'modelSettings',
	'plugins',
	'setPluginEnabled',
	'selectProvider',
	'pickAttachments',
	'addAttachments',
	'attachments',
	'removeAttachment',
	'moveAttachments',
	'send',
	'draft',
	'saveDraft',
	'draftSettings',
	'saveDraftSettings',
	'cancel',
	'takeQueued',
	'removeQueued',
	'approve',
	'jobs',
	'readJob',
	'stopJob',
	'initialize',
	'session/new',
	'session/load',
	'session/prompt',
	'session/cancel',
	'namzu/project/status',
	'namzu/project/trust',
	'namzu/conversations/list',
	'namzu/conversations/history',
	'namzu/providers/status',
	'namzu/providers/models',
	'namzu/providers/settings',
	'namzu/providers/select',
	'namzu/plugins/list',
	'namzu/plugins/set_enabled',
	'namzu/jobs/list',
	'namzu/jobs/read',
	'namzu/jobs/stop',
	'namzu/pals/list',
	'namzu/pals/get',
	'namzu/pals/create',
	'namzu/pals/update',
	'namzu/pals/conversations/list',
	'namzu/pals/conversations/claim',
	'namzu/pals/computer/status',
	'namzu/pals/computer/start',
	'namzu/pals/computer/stop',
	'namzu/pals/computer/screen',
])

/** Arbitrary errors can contain prompts, headers and paths. Only fixed reasons survive. */
export function desktopFailure(error: unknown): { reason: string; code?: string; type: string } {
	try {
		const message = (
			error instanceof Error ? error.message : typeof error === 'string' ? error : ''
		).slice(0, 4096)
		const code =
			error &&
			typeof error === 'object' &&
			'code' in error &&
			typeof error.code === 'string' &&
			OS_CODES.has(error.code)
				? error.code
				: undefined
		const type =
			error instanceof TypeError
				? 'TypeError'
				: error instanceof SyntaxError
					? 'SyntaxError'
					: error instanceof ReferenceError
						? 'ReferenceError'
						: error instanceof Error
							? 'Error'
							: 'Unknown'
		let reason = 'unclassified'
		if (/local Docker engine.*required|local Docker.*required/i.test(message))
			reason = 'docker-engine-or-image-required'
		else if (/local Podman machine.*required/i.test(message))
			reason = 'podman-engine-or-image-required'
		else if (/Podman machine.*stopped or unavailable|machine pipe is unavailable/i.test(message))
			reason = 'podman-machine-stopped'
		else if (
			/remote engines are refused|local.*machine.*identity|registered.*machine/i.test(message)
		)
			reason = 'local-engine-identity-refused'
		else if (/provider.*not configured/i.test(message)) reason = 'provider-not-configured'
		else if (
			/catalogue.*could not be loaded|catalogue.*unavailable|catalogue.*failed/i.test(message)
		)
			reason = 'model-catalogue-unavailable'
		else if (/credential|unauthorized|authentication|invalid api key|\b401\b/i.test(message))
			reason = 'authentication-failed'
		else if (/did not answer|timeout|timed out/i.test(message)) reason = 'request-timeout'
		else if (
			/invalid (?:Namzu )?protocol (?:response|frame)|oversized (?:Namzu )?protocol frame|malformed (?:JSON|protocol)|JSON (?:parse|parsing) (?:error|failed)|parsing JSON (?:failed|error)|(?:not valid|invalid) JSON|(?:Unexpected token|Unexpected end|Expected property name|Expected .*delimiter).*JSON/i.test(
				message,
			)
		)
			reason = 'protocol-invalid'
		else if (/Update Namzu.*version/i.test(message)) reason = 'cli-version-incompatible'
		else if (/not connected|connection.*closed/i.test(message)) reason = 'cli-disconnected'
		else if (/computer.*already in use/i.test(message)) reason = 'computer-in-use'
		else if (/cleanup|could not stop|could not be stopped|recovery.*required/i.test(message))
			reason = 'cleanup-unconfirmed'
		else if (/Pal.*paused/i.test(message)) reason = 'pal-paused'
		else if (/lease has ended|desktop is not responding|computer.*did not.*start/i.test(message))
			reason = 'computer-unavailable'
		else if (
			/cannot control Namzu|another project|different owner|not trusted|Trust this folder/i.test(
				message,
			)
		)
			reason = 'ownership-or-trust-refused'
		else if (code) reason = 'os-error'
		return { reason, ...(code ? { code } : {}), type }
	} catch {
		return { reason: 'unclassified', type: 'Unknown' }
	}
}

/** Decode only the host logger's fixed severity; its body is classified in memory. */
export function desktopStderrDetails(
	line: string,
): Pick<DesktopDiagnosticContext, 'severity' | 'error'> {
	let severity: DesktopDiagnosticSeverity = 'warn'
	let body = line.slice(0, 16_000)
	try {
		const record = JSON.parse(body) as Record<string, unknown>
		const number = { debug: 5, info: 9, warn: 13, error: 17 }
		if (
			record &&
			typeof record === 'object' &&
			typeof record.severityText === 'string' &&
			Object.hasOwn(number, record.severityText) &&
			record.severityNumber === number[record.severityText as DesktopDiagnosticSeverity] &&
			typeof record.timestamp === 'number' &&
			typeof record.observedTimestamp === 'number' &&
			typeof record.body === 'string' &&
			record.scope &&
			typeof record.scope === 'object' &&
			record.resource &&
			typeof record.resource === 'object'
		) {
			severity = record.severityText as DesktopDiagnosticSeverity
			body = record.body.slice(0, 4096)
		}
	} catch {
		// The normal CLI pipe may use its pretty sink. Neither source IDs nor
		// serialized attributes are passed into failure classification.
		const pretty = body.match(
			/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+\[(DEBUG|INFO|WARN|ERROR)\]\s+\[[^\]]*\]\s+(.*)$/,
		)
		if (pretty) {
			severity = pretty[1].toLowerCase() as DesktopDiagnosticSeverity
			body = pretty[2].split(' {')[0]
		}
	}
	return { severity, ...(severity === 'warn' || severity === 'error' ? { error: body } : {}) }
}

/** Synchronous bounded sink also survives a main-process fatal error. Never throws. */
export class DesktopDiagnostics implements DesktopDiagnosticSink {
	readonly directory: string
	readonly path: string
	readonly previousPath: string
	private available = false
	private failure?: string
	private directoryIdentity?: { dev: number; ino: number; path: string }
	private readonly instance = randomUUID()
	private windowSecond = 0
	private readonly counts = new Map<DesktopDiagnosticEvent, number>()
	constructor(
		userData: string,
		private readonly now: () => number = Date.now,
	) {
		this.directory = join(userData, 'logs')
		this.path = join(this.directory, 'desktop.ndjson')
		this.previousPath = join(this.directory, 'desktop.previous.ndjson')
		try {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 })
			const directory = lstatSync(this.directory)
			if (!directory.isDirectory() || directory.isSymbolicLink())
				throw new Error('Unsafe diagnostic directory')
			this.directoryIdentity = {
				dev: directory.dev,
				ino: directory.ino,
				path: realpathSync(this.directory),
			}
			this.validateFile(this.path)
			this.validateFile(this.previousPath)
			appendFileSync(this.path, '', { mode: 0o600 })
			chmodSync(this.directory, 0o700)
			chmodSync(this.path, 0o600)
			this.available = true
		} catch (error) {
			this.failure = desktopFailure(error).code ?? 'unavailable'
		}
	}
	private validateDirectory(): void {
		const directory = lstatSync(this.directory)
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			directory.dev !== this.directoryIdentity?.dev ||
			directory.ino !== this.directoryIdentity?.ino ||
			realpathSync(this.directory) !== this.directoryIdentity?.path
		)
			throw new Error('Diagnostic directory ownership changed')
	}
	private validateFile(path: string): number {
		try {
			const entry = lstatSync(path)
			if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe diagnostic file')
			return entry.size
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0
			throw error
		}
	}
	view(): DesktopDiagnosticsView {
		return {
			path: this.path,
			previousPath: this.previousPath,
			available: this.available,
			...(this.failure ? { notice: `Diagnostic storage is unavailable (${this.failure}).` } : {}),
		}
	}
	record(inputEvent: DesktopDiagnosticEvent, inputContext: DesktopDiagnosticContext = {}): void {
		let event = inputEvent
		let context = inputContext
		if (!this.available || !Object.hasOwn(EVENTS, event)) return
		try {
			this.validateDirectory()
			const timestamp = this.now()
			const second = Math.floor(timestamp / 1000)
			if (this.windowSecond !== second) {
				this.windowSecond = second
				this.counts.clear()
			}
			const count = (this.counts.get(event) ?? 0) + 1
			this.counts.set(event, count)
			if (count > 200) {
				if (count !== 201) return
				event = 'rate_limited'
				context = {}
			}
			const attributes: Record<string, string | number> = {}
			if (
				context.engine &&
				['default-docker', 'docker', 'podman', 'invalid'].includes(context.engine)
			)
				attributes['namzu.desktop.engine'] = context.engine
			if (context.platform && ['win32', 'linux', 'darwin', 'other'].includes(context.platform))
				attributes['os.type'] = context.platform
			if (context.operation)
				attributes['namzu.desktop.operation'] = OPERATIONS.has(context.operation)
					? context.operation
					: 'unknown'
			if (context.connection && /^[0-9a-f-]{36}$/.test(context.connection))
				attributes['namzu.desktop.connection'] = context.connection
			for (const key of ['request', 'bytes', 'exitCode', 'rpcCode', 'line', 'column'] as const) {
				const value = context[key]
				if (typeof value === 'number' && Number.isSafeInteger(value))
					attributes[`namzu.desktop.${key}`] = value
			}
			if (context.error !== undefined) {
				const failure = desktopFailure(context.error)
				attributes['namzu.desktop.failure.reason'] = failure.reason
				attributes['exception.type'] = failure.type
				if (failure.code) attributes['namzu.desktop.failure.code'] = failure.code
			}
			if (
				context.reason &&
				[
					'type-error',
					'reference-error',
					'unhandled-rejection',
					'process-ended',
					'turn-failed',
				].includes(context.reason)
			)
				attributes['namzu.desktop.failure.reason'] = context.reason
			const severity =
				context.severity && ['debug', 'info', 'warn', 'error'].includes(context.severity)
					? context.severity
					: event === 'started' || event === 'cli_started' || event === 'cli_closed'
						? 'info'
						: event === 'cli_stderr' || event === 'cli_notice' || event === 'rate_limited'
							? 'warn'
							: 'error'
			const severityNumber = { debug: 5, info: 9, warn: 13, error: 17 }[severity]
			const line = `${JSON.stringify({ timestamp, observedTimestamp: timestamp, severityNumber, severityText: severity, body: EVENTS[event], eventName: `namzu.desktop.${event}`, scope: { name: 'desktop' }, resource: { 'service.name': 'namzu-desktop', 'service.instance.id': this.instance }, attributes })}\n`
			const size = this.validateFile(this.path)
			if (this.validateFile(this.previousPath) > LIMIT)
				writeFileSync(this.previousPath, '', { mode: 0o600 })
			if (size + Buffer.byteLength(line) > LIMIT) {
				if (size > LIMIT) writeFileSync(this.path, '', { mode: 0o600 })
				renameSync(this.path, this.previousPath)
				writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 })
			}
			appendFileSync(this.path, line, { mode: 0o600 })
		} catch (error) {
			this.available = false
			this.failure = desktopFailure(error).code ?? 'unavailable'
		}
	}
}

/** Catch at the native boundary: a renderer may handle the rejection itself. */
export async function observeDesktopIpc<T>(
	sink: DesktopDiagnosticSink,
	operation: string,
	action: () => T | Promise<T>,
	request: number,
): Promise<T> {
	try {
		return await action()
	} catch (error) {
		try {
			sink.record('ipc_failed', { operation, request, error })
		} catch {
			/* Preserve the original operation failure. */
		}
		throw error
	}
}

/** React may catch a render error and only emit it to the renderer console. */
export function observeRendererConsole(
	sink: DesktopDiagnosticSink,
	details: { level: string; message: string; lineNumber: number },
): void {
	if (details.level !== 'error') return
	try {
		sink.record('renderer_failed', { error: details.message, line: details.lineNumber })
	} catch {
		/* Diagnostics must not change renderer behavior. */
	}
}
