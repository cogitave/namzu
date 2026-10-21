import { z } from 'zod'

import {
	MONITOR_TIMEOUT_DEFAULT_MS,
	MONITOR_TIMEOUT_MAX_MS,
	MONITOR_TIMEOUT_MIN_MS,
	formatMonitorDuration,
} from '../../runtime/jobs/monitor-stream.js'
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
 */

const inputSchema = z.object({
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
		.describe(
			'The shell command to watch. Each line it prints to stdout becomes an event. It runs until it ends or the timeout; it must not need stdin.',
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
	'Starts a command and tells you about each line it prints to stdout, as it prints it, while you keep working. Lines that arrive within 200 ms come together as one event. Use it to watch a log, a test or deploy run, a status endpoint — anything where you must react to something happening INSIDE a long-running command. For ONE notification when something finishes, do not use this: run bash with run_in_background and wait_for_job. Every stage of a pipe must flush per line or events arrive late or never (grep --line-buffered, awk with fflush(), sed -u; `head` cannot). Make the filter match failure as well as success (crash, Traceback, Error, FAILED, Killed…): silence from a monitor is not success. Poll a remote API no faster than every 30 seconds. stderr is not an event; read it with job. A monitor that prints too much is stopped, so filter at the source. It expires after the timeout (default 5 minutes, at most 30) and you get one notice; start it again if you still need it. Stop one early with job {"action":"kill","id":"<id>"}.'

export const MonitorTool = defineTool({
	name: MONITOR_TOOL_NAME,
	description: MONITOR_DESCRIPTION,
	inputSchema,
	category: 'shell',
	// Bash's, because it IS a shell command: the gate reads the line, splits
	// chains, and applies the operator's rules to each part.
	commandArgument: 'command',
	commandDialect: bashToolDialect,
	permissions: ['shell_execute'],
	readOnly: false,
	destructive: (input: MonitorInput) => isDangerousCommand(input.command),
	// Starting a monitor registers a job against the owner's cap and its id
	// is then named in later calls; two at once could race the cap, as they
	// can for a background `bash`.
	concurrencySafe: false,

	presentCall(input) {
		if (typeof input.command !== 'string') return undefined
		return {
			kind: 'generic',
			label: `Monitor · ${typeof input.description === 'string' ? input.description : input.command}`,
			facts: { kind: 'command', command: input.command, background: true },
		}
	},

	async execute(input, context) {
		if (isDangerousCommand(input.command)) {
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
		// Same rule as background bash: the executor withholds the registry from
		// a sandbox that cannot start a detached process, and this check is for
		// the direct caller who hands both.
		if (context.sandbox && context.sandbox.spawnDetached === undefined) {
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
		if (!jobs.startMonitor) {
			return {
				success: false,
				output: '',
				error:
					'This host cannot deliver monitor events, so no watch was started. Use bash with run_in_background and wait_for_job to be told when a command finishes.',
			}
		}

		try {
			const { job, timeoutMs } = jobs.startMonitor({
				command: input.command,
				description: input.description,
				timeoutMs: input.timeout_ms,
				workingDirectory: context.workingDirectory,
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
			return {
				success: true,
				output: `Monitor started (job ${job.id}, expires in ${formatMonitorDuration(timeoutMs)} unless the command ends first; you get one notice at expiry — start it again if you still need the watch). Each line the command prints to stdout reaches you as an event while you keep working; do not poll or sleep. Stop it with job {"action":"kill","id":"${job.id}"}. An event may arrive while you are waiting for the user — it is not their reply.`,
				data: { jobId: job.id, monitor: true, timeoutMs },
				facts: { kind: 'command', command: input.command, background: true },
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

/**
 * The tool, for a host that opts in.
 *
 * Not in `getBuiltinTools()`: a watch needs a host that delivers events and
 * wakes on them, and offering a tool that starts a job nobody will hear from
 * is worse than not offering it. A function rather than a constant so a host
 * can decide per turn, and so it reads like `getCodeAnalysisTools`, beside
 * which a host mounts it deferred.
 */
export function getMonitorTools(): (typeof MonitorTool)[] {
	return [MonitorTool]
}
