/** Host-side stream bridge. No command is executed on this host process. */
import { HttpWorkerClient } from '../backends/http-worker-client.js'
import { RemoteCancellationUnknownError } from '../backends/remote-execution-controller.js'

export const LOCAL_BACKGROUND_TIMEOUT_MS = 2_147_000_000

export interface DetachedWorkerConfiguration {
	readonly type: 'start'
	readonly executionUrl: string
	readonly token: string
	readonly command: string
	readonly args: string[]
	readonly cwd?: string
	readonly env?: Record<string, string>
}

const controller = new AbortController()
let started = false
let disconnected = false
let cancellation: NodeJS.Signals | undefined
let retirement: ((confirmed: boolean) => void) | undefined

function cancel(signal: NodeJS.Signals = 'SIGTERM'): void {
	cancellation ??= signal
	controller.abort(new Error('Guest background command cancelled'))
}

process.on('SIGTERM', () => cancel())
process.on('SIGINT', () => cancel('SIGINT'))
process.on('disconnect', () => {
	disconnected = true
	cancel()
	retirement?.(false)
})

async function finish(code: number, confirmed = true): Promise<never> {
	// Drain Node's own pipe buffers before reporting terminal state.
	await Promise.all([
		new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
		new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
	])
	if (confirmed && process.connected)
		await new Promise<void>((resolve) =>
			process.send?.({ type: 'terminal-confirmed' }, () => resolve()),
		)
	process.exit(code)
}

async function requireRetirement(): Promise<never> {
	let confirmed = disconnected
		? false
		: await new Promise<boolean>((resolve) => {
				retirement = resolve
				process.send?.({ type: 'retire-computer' }, (error) => {
					if (error) resolve(false)
				})
			})
	while (!confirmed && !disconnected) {
		process.stderr.write(
			'\n[Guest cancellation could not be confirmed; the computer requires operator recovery.]\n',
		)
		// Keep the bridge and ownership alive. The provider's next termination
		// attempt retries retirement, never the command or its guest signals.
		confirmed = await new Promise<boolean>((resolve) => {
			retirement = resolve
		})
	}
	return await finish(1, confirmed)
}

async function execute(config: DetachedWorkerConfiguration): Promise<void> {
	try {
		const result = await new HttpWorkerClient(config.executionUrl, config.token).exec(
			config.command,
			config.args,
			{
				timeout: LOCAL_BACKGROUND_TIMEOUT_MS,
				cwd: config.cwd,
				env: config.env,
				signal: controller.signal,
				onOutput: (chunk) =>
					(chunk.stream === 'stdout' ? process.stdout : process.stderr).write(chunk.data),
			},
		)
		if (result.stdoutTruncated || result.stderrTruncated)
			process.stderr.write(
				'\n[Guest worker output exceeded its capture cap; the omitted bytes are unavailable.]\n',
			)
		if (result.timedOut)
			process.stderr.write('\n[Guest background command reached its maximum lifetime.]\n')
		await finish(result.exitCode)
	} catch (error) {
		if (error instanceof RemoteCancellationUnknownError) {
			// Closing a host pipe cannot prove a guest tree stopped. Ask the
			// owning provider to retire the actual computer before exiting.
			await requireRetirement()
		}
		if (controller.signal.aborted) await finish(128 + (cancellation === 'SIGINT' ? 2 : 15))
		process.stderr.write('\n[Guest background command could not be completed.]\n')
		// A transport failure may happen after admission. Retire the computer
		// rather than report a host bridge failure as a guest process exit.
		await requireRetirement()
	}
}

process.on('message', (raw: unknown) => {
	if (!raw || typeof raw !== 'object' || !('type' in raw)) return
	const message = raw as {
		type: string
		signal?: NodeJS.Signals
		confirmed?: boolean
	}
	if (message.type === 'cancel') {
		cancel(message.signal)
		return
	}
	if (message.type === 'retired') {
		retirement?.(message.confirmed === true)
		return
	}
	if (message.type !== 'start' || started) return
	started = true
	void execute(raw as DetachedWorkerConfiguration)
})
