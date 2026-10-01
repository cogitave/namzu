import { z } from 'zod'

import { readPositiveIntEnv } from '../../utils/env.js'
import { defineTool } from '../defineTool.js'
import { describeJobWaitTimeout, waitForJobWithBounds } from './wait-for-job-bounds.js'

/**
 * Block until a background job ends, instead of reading it in a loop.
 *
 * `job`'s own tool used to say, in as many words, "poll a job with action
 * read" — and a model that took the instruction literally paid for it: one
 * recorded run launched a single background job, then spent six `job read`
 * calls, three `job list` calls and an improvised `sleep 30` waiting on it,
 * burning more tokens on the wait than the work it was waiting for cost.
 * `wait_for_task` already solved this for delegated agent work by blocking
 * inside ONE tool call instead of asking the model to check back; this is
 * the same fix for shell jobs, built the same way — see
 * `wait-for-job-bounds.ts` and its task-surface counterpart.
 */

const DEFAULT_TIMEOUT_MS = readPositiveIntEnv('NAMZU_JOB_WAIT_TIMEOUT_MS', 5 * 60 * 1000)
const DEFAULT_IDLE_TIMEOUT_MS = readPositiveIntEnv('NAMZU_JOB_WAIT_IDLE_MS', 2 * 60 * 1000)

/**
 * The longest either bound will accept from the model.
 *
 * Same number `wait_for_task` uses for a delegated agent, and the same
 * reasoning applies: a generic stopwatch is the wrong instrument for a job
 * that is making progress, so this is "how long is too long" rather than a
 * guess at any one job's real duration, and a request past it is REFUSED by
 * the schema rather than silently clamped — see `bash`'s own `timeout` field
 * for the same trade.
 */
const MAX_WAIT_MS = readPositiveIntEnv('NAMZU_JOB_WAIT_MAX_MS', 60 * 60 * 1000)

const inputSchema = z
	.object({
		id: z.string().describe('The job id, as returned by bash with run_in_background.'),
		output_contains: z
			.string()
			.min(1)
			.max(4096)
			.refine(
				(value) =>
					Buffer.byteLength(value) <= 4096 && Buffer.from(value).toString('utf8') === value,
				'Use a non-empty UTF-8 literal of at most 4096 bytes.',
			)
			.optional()
			.describe(
				'Wait for this exact literal in output rather than for exit. This observes a marker; it does not prove service health or keep the turn open until the job exits.',
			),
		output_stream: z
			.enum(['stdout', 'stderr', 'either'])
			.optional()
			.describe(
				'Pipe to inspect with output_contains. Default either; stdout and stderr are never joined for a match.',
			),
		from_offset: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe('Resume after a previous wait: pass its next_offset to receive only new output.'),
		timeout_ms: z
			.number()
			.int()
			.positive()
			.max(MAX_WAIT_MS)
			.optional()
			.describe(
				`Give up after this long even if the job keeps producing output, in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}, maximum: ${MAX_WAIT_MS}. The job is never stopped by this running out.`,
			),
		idle_timeout_ms: z
			.number()
			.int()
			.positive()
			.max(MAX_WAIT_MS)
			.optional()
			.describe(
				`Give up if the job produces no new output for this long, in milliseconds. Default: ${DEFAULT_IDLE_TIMEOUT_MS}. Resets on every new byte of output, so a job that is still working is not cut off; only real silence ends the wait early.`,
			),
	})
	.superRefine((input, ctx) => {
		if (input.output_stream !== undefined && input.output_contains === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['output_stream'],
				message: 'output_stream requires output_contains.',
			})
		}
	})

type WaitForJobInput = z.infer<typeof inputSchema>

export const WaitForJobTool = defineTool({
	name: 'wait_for_job',
	description:
		'Wait for an owned background job to exit, or set output_contains to observe an exact output marker while it stays running. Use one wait instead of polling job read. Output markers do not prove service health or completion and never express intent to wait until exit. A bounded wait returns output and next_offset without stopping the job; pass that cursor as from_offset to exclude earlier output.',
	inputSchema,
	category: 'shell',
	permissions: ['shell_execute'],
	// Waiting is watching, not acting: this tool only ever reads a job's
	// output and status through the same registry `job read` uses, and has
	// no branch that touches a job's lifetime. `wait_for_task` is `readOnly:
	// true` for the identical reason, and unlike `job` there is no second
	// action here that would make this a function of input.
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	// A tool whose whole purpose is to wait must not be cut off for waiting.
	// A margin over MAX_WAIT_MS so the tool's own bound — which reports a
	// clean timeout result — always fires before the executor's harsher
	// "abandoned" one would.
	timeoutMs: MAX_WAIT_MS + 30_000,

	presentCall(input) {
		return {
			kind: 'generic',
			presentation: 'activity',
			label: `${input.output_contains === undefined ? 'Wait for background job' : 'Wait for job output'} · ${input.id ?? '(missing id)'}`,
		}
	},

	async execute(input: WaitForJobInput, context) {
		if (!context.backgroundJobs) {
			return {
				success: false,
				output: '',
				error: 'This host provides no background job registry, so there is no job to wait for.',
			}
		}
		const jobs = context.backgroundJobs

		try {
			jobs.get(input.id)
		} catch (err) {
			return {
				success: false,
				output: '',
				error: err instanceof Error ? err.message : String(err),
			}
		}

		if (input.output_stream !== undefined && input.output_contains === undefined) {
			return { success: false, output: '', error: 'output_stream requires output_contains.' }
		}
		if (input.output_contains !== undefined) {
			if (!jobs.waitForOutput) {
				return {
					success: false,
					output: '',
					error:
						'This host cannot observe output readiness. It must implement backgroundJobs.waitForOutput; no exit wait was started.',
				}
			}
			try {
				const outcome = await jobs.waitForOutput(input.id, {
					literal: input.output_contains,
					stream: input.output_stream ?? 'either',
					timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
					idleTimeoutMs: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
					...(input.from_offset === undefined ? {} : { fromOffset: input.from_offset }),
					signal: context.abortSignal,
				})
				const notices = [
					...(outcome.droppedBytes > 0
						? [`[${outcome.droppedBytes} bytes unavailable before the retained output]`]
						: []),
					...(outcome.unsearchedBytes > 0
						? [
								`[${outcome.unsearchedBytes} retained bytes could not be searched because the channel history cap discarded them]`,
							]
						: []),
					...(outcome.omittedOutputBytes > 0
						? [`[${outcome.omittedOutputBytes} earlier bytes omitted from this bounded result]`]
						: []),
				]
				const status =
					outcome.exitCode === undefined
						? outcome.status
						: `${outcome.status} with code ${outcome.exitCode}`
				const reason =
					outcome.kind === 'matched'
						? `Output marker observed on ${outcome.matchedStream}. This is output evidence, not a health check or completion claim.`
						: outcome.kind === 'exited'
							? 'Job exited before the marker was observed.'
							: outcome.kind === 'stopped'
								? 'Job stop was requested before the marker was observed; shutdown may still be completing.'
								: outcome.kind === 'aborted'
									? 'Output observation was cancelled; this wait did not stop the job.'
									: `Output marker was not observed before the ${outcome.cause} timeout (${outcome.elapsedMs} ms); this wait did not stop the job.`
				return {
					success: outcome.kind !== 'aborted',
					output: `${reason}\n\n${notices.length > 0 ? `${notices.join('\n')}\n` : ''}${outcome.output || '(no new output)'}\n\n[job ${input.id} is ${status}; next_offset ${outcome.nextOffset}]`,
					data: {
						jobId: input.id,
						outcome: outcome.kind,
						status: outcome.status,
						nextOffset: outcome.nextOffset,
						droppedBytes: outcome.droppedBytes,
						unsearchedBytes: outcome.unsearchedBytes,
						omittedOutputBytes: outcome.omittedOutputBytes,
						...(outcome.kind === 'matched' ? { matchedStream: outcome.matchedStream } : {}),
						...(outcome.kind === 'timeout' ? { timedOut: outcome.cause } : {}),
						...(outcome.kind === 'aborted' ? { abandoned: true } : {}),
						...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
					},
				}
			} catch (err) {
				return {
					success: false,
					output: '',
					error: err instanceof Error ? err.message : String(err),
				}
			}
		}

		if (!jobs.waitForExit) {
			return {
				success: false,
				output: '',
				error:
					'This host\'s background job registry cannot wait for a job to exit. Use job with action "read" instead.',
			}
		}

		// The wait IS the intent, so it is recorded before the bounds are: a
		// call that gives up at `timeout_ms` with the job still running is the
		// case the kernel's hold exists to back up, and one that started the
		// wait and then ended its turn is the same case a beat later. Nothing
		// infers this from the job's existence — a dev server the model never
		// waited on never holds a turn open. See `runtime/jobs/awaited-jobs.ts`.
		jobs.markAwaited?.(input.id)

		let outcome: Awaited<ReturnType<typeof waitForJobWithBounds>>
		try {
			outcome = await waitForJobWithBounds(jobs, input.id, {
				wallMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
				idleMs: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
				...(input.from_offset === undefined ? {} : { fromOffset: input.from_offset }),
				signal: context.abortSignal,
			})
		} catch {
			// The signal fired before either bound did — Stop, or the turn's
			// own deadline. The job is untouched: ending a WAIT is not
			// ending the WORK. The executor has already raced this same
			// signal against the whole call and reports the cancellation
			// itself; this only keeps that rejection from reaching the
			// model as an unlabelled tool failure.
			return {
				success: false,
				output: `This wait for job ${input.id} was abandoned before it finished; it is still running and was not stopped. Call wait_for_job again, or job read with from_offset, to pick up where this left off.`,
				data: { jobId: input.id, abandoned: true },
			}
		}

		const notices = [
			...(outcome.droppedBytes > 0
				? [`[${outcome.droppedBytes} bytes were dropped by the job's output retention cap]`]
				: []),
			...(outcome.omittedOutputBytes > 0
				? [`[${outcome.omittedOutputBytes} earlier bytes omitted from this bounded wait result]`]
				: []),
		]
		const observed = `${notices.length > 0 ? `${notices.join('\n')}\n` : ''}${outcome.output || '(no new output)'}`

		if (outcome.kind === 'timeout') {
			return {
				// The wait observed a bound, not a failed command. A tool error
				// would also be promoted as a durable failure by the turn's memory.
				success: true,
				output: `${describeJobWaitTimeout(input.id, outcome)}\n\n${observed}\n\n[next_offset ${outcome.nextOffset}]`,
				data: {
					jobId: input.id,
					timedOut: outcome.cause,
					nextOffset: outcome.nextOffset,
					droppedBytes: outcome.droppedBytes,
					omittedOutputBytes: outcome.omittedOutputBytes,
				},
			}
		}

		const status =
			outcome.exitCode === undefined
				? outcome.status
				: `${outcome.status} with code ${outcome.exitCode}`

		return {
			success: true,
			output: `${observed}\n\n[job ${input.id} is ${status}; next_offset ${outcome.nextOffset}]`,
			data: {
				jobId: input.id,
				status: outcome.status,
				nextOffset: outcome.nextOffset,
				droppedBytes: outcome.droppedBytes,
				omittedOutputBytes: outcome.omittedOutputBytes,
				...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
			},
		}
	},
})
