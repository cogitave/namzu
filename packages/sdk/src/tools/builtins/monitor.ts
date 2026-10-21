import { z } from 'zod'

import {
	MONITOR_TIMEOUT_DEFAULT_MS,
	MONITOR_TIMEOUT_MAX_MS,
	MONITOR_TIMEOUT_MIN_MS,
	formatMonitorDuration,
} from '../../runtime/jobs/monitor-stream.js'
import {
	WEBSOCKET_PROTOCOLS_MAX,
	WebSocketRefusedError,
	type WebSocketVetOptions,
	vetWebSocketTarget,
	webSocketHostname,
	webSocketProtocolsProblem,
	webSocketSandboxRefusal,
	webSocketUrlProblem,
} from '../../runtime/jobs/websocket-source.js'
import type { MonitorWebSocketTarget } from '../../types/tool/index.js'
import {
	bashToolDialect,
	hostCommandShell,
	isWindowsBash,
	rewriteWindowsNullRedirect,
} from '../command-shell.js'
import { defineTool } from '../defineTool.js'
import {
	DISABLE_BACKGROUND_TASKS_ENV,
	backgroundTasksDisabled,
	isDangerousCommand,
} from './bash.js'
import { clip } from './classifier-input.js'

/**
 * Watch a command's output while the model keeps working.
 *
 * `bash run_in_background` plus `wait_for_job` answers "tell me when this
 * finishes", and nothing answered "tell me when something happens in it": a
 * log line, a failed check, a changed status. The only alternative was a
 * polling loop, which spends a full context resend per look and is silent
 * between looks. This tool starts the command as a job the registry owns and
 * turns each line it prints on stdout into an event the model reads on its
 * next tool result (or wakes it, when it has stopped) — see
 * `runtime/jobs/monitor-stream.ts` for how lines become batches and why a
 * source that prints too much is stopped.
 *
 * It is a different tool from `bash`, and not a flag on it, for the same
 * reason `wait_for_job` is: the model chooses by intent. The permission story
 * is bash's, line for line — a monitor runs a shell command — so the rules
 * read the command the way they read `bash`'s, and it is never read-only. It
 * has no way out of the sandbox: a watch that outlives one approved call must
 * not run outside the boundary that call was approved under.
 *
 * A source can also be a WebSocket (`ws`), for services that push their events
 * and offer no command that prints them. That one is a different thing to
 * approve: it is not a shell line, it opens a connection FROM THE HOST to an
 * address the model chose, and it does so outside any sandbox. So it is read
 * by no command rule, it is always reviewed, a sandbox that blocks the network
 * refuses it, and the address is checked and pinned (see
 * `runtime/jobs/websocket-source.ts`). Untrusted frames reach the model the way
 * a command's lines do: through the monitor event path, in its untrusted frame.
 */

const webSocketInput = z.object({
	url: z
		.string()
		.superRefine((value, ctx) => {
			const problem = webSocketUrlProblem(value)
			if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
		})
		.describe(
			'The ws:// or wss:// URL to connect to. A query string is kept; credentials in it are refused.',
		),
	protocols: z
		.array(z.string())
		.max(WEBSOCKET_PROTOCOLS_MAX)
		.superRefine((value, ctx) => {
			const problem = webSocketProtocolsProblem(value)
			if (problem !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
		})
		.optional()
		.describe('Subprotocol names to offer, when the service asks for one.'),
})

const inputSchema = z
	.object({
		description: z
			.string()
			.min(1)
			.max(200)
			.describe(
				'What you are watching, in a few specific words. It is shown with every event ("Monitor event: <description>"), so make it identify this watch among several: "errors in deploy log", not "monitor".',
			),
		command: z
			.string()
			.min(1)
			// Same rewrite as `bash`, for the same reason: the rules read the line a
			// shell will run.
			.transform((command) =>
				isWindowsBash(hostCommandShell()) ? rewriteWindowsNullRedirect(command) : command,
			)
			.optional()
			.describe(
				'The shell command to watch. Each line it prints to stdout becomes an event. It runs until it ends or the timeout; it must not need stdin. Give this or ws, not both.',
			),
		ws: webSocketInput
			.optional()
			.describe(
				'Watch a WebSocket instead of a command: each line of each text frame the server sends becomes an event. Give this or command, not both.',
			),
		timeout_ms: z
			.preprocess(
				(v) => (typeof v === 'string' ? Number(v) : v),
				z
					.number()
					.int()
					.min(MONITOR_TIMEOUT_MIN_MS)
					.max(MONITOR_TIMEOUT_MAX_MS)
					.default(MONITOR_TIMEOUT_DEFAULT_MS),
			)
			.describe(
				`How long to watch, in milliseconds. Default ${MONITOR_TIMEOUT_DEFAULT_MS}. The host caps it (30 minutes by default; shorter in a single-shot run), and a larger value is lowered to that cap without an error; the result states the time actually granted.`,
			),
	})
	.refine((input) => (input.command === undefined) !== (input.ws === undefined), {
		message: 'Give exactly one of command and ws.',
	})

type MonitorInput = z.infer<typeof inputSchema>

export const MONITOR_TOOL_NAME = 'monitor'

/**
 * What a sandbox without `spawnDetached` is told. The wording of `bash`'s own
 * refusal names `run_in_background` and `timeout`, neither of which is this
 * tool's, so it is restated here; the substance is the same and so is the
 * rule: the watch is never run on the host to get around the sandbox.
 */
export const MONITOR_CANNOT_DETACH =
	'monitor is unavailable: this sandbox cannot start a detached process, and the watch will not be run on the host to get around it. Run the command in the foreground with bash, with a timeout.'

const MONITOR_DESCRIPTION =
	'Starts a command and tells you about each line it prints to stdout, as it prints it, while you keep working. Lines that arrive within 200 ms come together as one event. Use it to watch a log, a test or deploy run, a status endpoint — anything where you must react to something happening INSIDE a long-running command. For ONE notification when something finishes, do not use this: run bash with run_in_background and wait_for_job. Every stage of a pipe must flush per line or events arrive late or never (grep --line-buffered, awk with fflush(), sed -u; `head` cannot). Make the filter match failure as well as success (crash, Traceback, Error, FAILED, Killed…): silence from a monitor is not success. Poll a remote API no faster than every 30 seconds. stderr is not an event; read it with job. A monitor that prints too much is stopped, so filter at the source. It expires after the timeout (default 5 minutes, at most 30) and you get one notice; start it again if you still need it. Stop one early with job {"action":"kill","id":"<id>"}. ' +
	'To watch a service that PUSHES events (a CI or log stream, a change feed) give ws instead of command: { "url": "wss://…", "protocols": [...] }. Each line of each text frame becomes an event, binary frames are only counted, and the watch ends when the server closes the connection. Use it for a push stream, not for request and response. It connects from this machine, so private and local addresses are refused, and you are asked before it connects.'

/** What a host can tune about the WebSocket source; for tests only, see {@link WebSocketVetOptions}. */
export interface MonitorToolOptions {
	readonly webSocket?: WebSocketVetOptions
	/**
	 * How to turn web access on, in the host's own words, appended to the
	 * refusal a WebSocket call gets while it is off. The SDK cannot name a
	 * switch it does not own (a CLI config key, a desktop setting), and a
	 * refusal that only says "off" leaves the operator guessing. One short
	 * sentence; it is shown to the model and the operator as written.
	 */
	readonly webAccessHint?: string
}

/** The text that says a WebSocket watch was refused because the host has web access off. */
export const MONITOR_WEBSOCKET_WEB_OFF =
	"WebSocket monitors follow the host's web access setting, and web access is switched off here, so no connection was opened. Watch the service with a command (for example curl or websocat through monitor) if the operator allows it."

const MONITOR_WEBSOCKET_NOT_SUPPORTED =
	'This host cannot start a WebSocket monitor, so no connection was opened. Watch the service with a command through monitor if the operator allows it.'

/**
 * The tool, built once with defaults for a host and again by a test that needs
 * to reach a server on this machine. The options belong to whoever builds the
 * tool; nothing a model sends can set them.
 */
export function createMonitorTool(options: MonitorToolOptions = {}) {
	return defineTool({
		name: MONITOR_TOOL_NAME,
		description: MONITOR_DESCRIPTION,
		inputSchema,
		category: 'shell',
		// Bash's, because it IS a shell command: the gate reads the line, splits
		// chains, and applies the operator's rules to each part. A WebSocket call
		// has no `command`, so a rule written for commands has nothing to match
		// and cannot allow it; `requiresApproval` below is what asks.
		commandArgument: 'command',
		classifierInput: (input: MonitorInput) =>
			input.command !== undefined
				? `[long-running watch] ${clip(input.command, 4000)}`
				: `[long-running WebSocket watch] ${JSON.stringify(input.ws)}`,
		commandDialect: bashToolDialect,
		// `network_access` too: a WebSocket call reaches the network. The gate
		// reads a tool's `category`, not this list, to route a call, so declaring
		// it changes no decision for a command; it says what the tool may do.
		permissions: ['shell_execute', 'network_access'],
		readOnly: false,
		destructive: (input: MonitorInput) =>
			input.command !== undefined && isDangerousCommand(input.command),
		// A WebSocket call is the one input-aware seam the gate offers that no
		// allow rule or mode outranks: it connects from the host, outside any
		// sandbox, to an address the model chose. `category: 'shell'` is what the
		// sandboxed-shell preset auto-approves, and moving the whole tool to
		// `network` would start asking about commands that were never a question;
		// this asks only about the connection. It is stronger than "review where
		// the mode reviews non-read-only calls": `auto` mode and an unattended
		// turn are asked too (or refuse when nobody can be asked), which is the
		// point for a connection that leaves the boundary those modes rely on.
		requiresApproval: (input: MonitorInput) => input.ws !== undefined,
		// Starting a monitor registers a job against the owner's cap and its id
		// is then named in later calls; two at once could race the cap, as they
		// can for a background `bash`.
		concurrencySafe: false,

		presentCall(input) {
			const label = typeof input.description === 'string' ? input.description : undefined
			if (input.ws !== undefined && typeof input.ws === 'object') {
				const ws = input.ws as { url?: unknown; protocols?: unknown }
				if (typeof ws.url !== 'string') return undefined
				const protocols =
					Array.isArray(ws.protocols) && ws.protocols.length > 0
						? ` (subprotocols: ${ws.protocols.join(', ')})`
						: ''
				// What will happen, said plainly, because this is what a person
				// approves: no command line stands in for it.
				return {
					kind: 'generic',
					label: `Monitor${label ? ` · ${label}` : ''} · WebSocket ${ws.url}${protocols}`,
				}
			}
			if (typeof input.command !== 'string') return undefined
			return {
				kind: 'generic',
				label: `Monitor · ${label ?? input.command}`,
				facts: { kind: 'command', command: input.command, background: true },
			}
		},

		async execute(input, context) {
			if (input.command !== undefined && isDangerousCommand(input.command)) {
				return {
					success: false,
					output: '',
					error: `Dangerous command blocked: "${input.command}"`,
					facts: { kind: 'failure', reason: 'blocked', subject: MONITOR_TOOL_NAME },
				}
			}
			if (backgroundTasksDisabled()) {
				return {
					success: false,
					output: '',
					error: `Background jobs are switched off here (${DISABLE_BACKGROUND_TASKS_ENV}), and a monitor is one. Check in the foreground with bash instead.`,
				}
			}
			// What is checked about a connection is checked before anything that
			// speaks of commands, so a refusal names its own cause.
			let webSocket: MonitorWebSocketTarget | undefined
			if (input.ws !== undefined) {
				// The operator's switch for reaching the web at all. A host that has
				// not given this turn a web capability has not decided to let the
				// model open connections, and a WebSocket is one.
				if (context.web?.fetch === undefined) {
					return {
						success: false,
						output: '',
						error: options.webAccessHint
							? `${MONITOR_WEBSOCKET_WEB_OFF} ${options.webAccessHint}`
							: MONITOR_WEBSOCKET_WEB_OFF,
					}
				}
				const hostname = webSocketHostname(input.ws.url)
				const sandboxRefusal = webSocketSandboxRefusal(context.sandbox, hostname)
				if (sandboxRefusal !== undefined) {
					return { success: false, output: '', error: sandboxRefusal }
				}
				try {
					const addresses = await vetWebSocketTarget(input.ws.url, options.webSocket)
					webSocket = {
						url: input.ws.url,
						...(input.ws.protocols ? { protocols: input.ws.protocols } : {}),
						addresses,
					}
				} catch (err) {
					if (err instanceof WebSocketRefusedError) {
						return { success: false, output: '', error: err.message }
					}
					throw err
				}
			} else if (context.sandbox && context.sandbox.spawnDetached === undefined) {
				// Same rule as background bash: the executor withholds the registry
				// from a sandbox that cannot start a detached process, and this check
				// is for the direct caller who hands both.
				return { success: false, output: '', error: MONITOR_CANNOT_DETACH }
			}
			const jobs = context.backgroundJobs
			if (!jobs) {
				return {
					success: false,
					output: '',
					error:
						'monitor was requested, but this host provides no background job registry. Run the command in the foreground with bash, with a timeout.',
				}
			}
			if (webSocket !== undefined && !jobs.startWebSocketMonitor) {
				return {
					success: false,
					output: '',
					error: MONITOR_WEBSOCKET_NOT_SUPPORTED,
				}
			}
			if (webSocket === undefined && !jobs.startMonitor) {
				return {
					success: false,
					output: '',
					error:
						'This host cannot deliver monitor events, so no watch was started. Use bash with run_in_background and wait_for_job to be told when a command finishes.',
				}
			}

			try {
				const common = {
					description: input.description,
					timeoutMs: input.timeout_ms,
					workingDirectory: context.workingDirectory,
				}
				const { job, timeoutMs } =
					webSocket !== undefined
						? (jobs.startWebSocketMonitor as NonNullable<typeof jobs.startWebSocketMonitor>)({
								...common,
								webSocket,
							})
						: (jobs.startMonitor as NonNullable<typeof jobs.startMonitor>)({
								...common,
								command: input.command as string,
							})
				// `startMonitor` returns before the process exists, and a spawn that
				// fails reports a tick later; wait for that one event so "started" is
				// never said of a watch that could not start.
				const startup = await jobs.awaitStarted?.(job.id)
				if (startup?.error !== undefined) {
					return {
						success: false,
						output: '',
						error: `${startup.error} (monitor ${job.id} did not run).`,
						data: { jobId: job.id, monitor: true, startFailed: true },
					}
				}
				if (webSocket !== undefined) {
					return {
						success: true,
						output: `WebSocket monitor started (job ${job.id}, expires in ${formatMonitorDuration(timeoutMs)} unless the server closes the connection first; you get one notice at expiry — start it again if you still need the watch). Each line of each text frame the server sends reaches you as an event while you keep working; binary frames are only counted. The connection opens in the background: if it fails you are told in an event. Do not poll or sleep. Stop it with job {"action":"kill","id":"${job.id}"}. An event may arrive while you are waiting for the user — it is not their reply.`,
						data: { jobId: job.id, monitor: true, timeoutMs, transport: 'websocket' },
					}
				}
				return {
					success: true,
					output: `Monitor started (job ${job.id}, expires in ${formatMonitorDuration(timeoutMs)} unless the command ends first; you get one notice at expiry — start it again if you still need the watch). Each line the command prints to stdout reaches you as an event while you keep working; do not poll or sleep. Stop it with job {"action":"kill","id":"${job.id}"}. An event may arrive while you are waiting for the user — it is not their reply.`,
					data: { jobId: job.id, monitor: true, timeoutMs },
					facts: { kind: 'command', command: input.command as string, background: true },
				}
			} catch (err) {
				// The per-owner cap, most likely; naming the limit is actionable.
				return {
					success: false,
					output: '',
					error: err instanceof Error ? err.message : String(err),
				}
			}
		},
	})
}

export const MonitorTool = createMonitorTool()

/**
 * The tool, for a host that opts in.
 *
 * Not in `getBuiltinTools()`: a watch needs a host that delivers events and
 * wakes on them, and offering a tool that starts a job nobody will hear from
 * is worse than not offering it. A function rather than a constant so a host
 * can decide per turn, and so it reads like `getCodeAnalysisTools`, beside
 * which a host mounts it deferred. Called with no options it returns the
 * shared {@link MonitorTool}.
 */
export function getMonitorTools(options?: MonitorToolOptions): (typeof MonitorTool)[] {
	return [options === undefined ? MonitorTool : createMonitorTool(options)]
}
