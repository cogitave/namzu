import { z } from 'zod'

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

function readPositiveIntEnv(key: string, fallback: number): number {
	const value = process.env[key]?.trim()
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const inputSchema = z.object({
	id: z.string().describe('The job id, as returned by bash with run_in_background.'),
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

type WaitForJobInput = z.infer<typeof inputSchema>

export const WaitForJobTool = defineTool({
	name: 'wait_for_job',
	description:
		'Block until a background job started by bash with run_in_background ends, and return its accumulated output in one call. Use this instead of calling job with action "read" in a loop: it costs one call and no waiting turns. Gives up — WITHOUT stopping the job — if it runs too long or goes quiet for too long; either outcome says so, and the job keeps running either way.',
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
			label: `Wait for background job · ${input.id ?? '(missing id)'}`,
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

		if (!jobs.waitForExit) {
			return {
				success: false,
				output: '',
				error:
					'This host\'s background job registry cannot wait for a job to exit. Use job with action "read" instead.',
			}
		}

		let outcome: Awaited<ReturnType<typeof waitForJobWithBounds>>
		try {
			outcome = await waitForJobWithBounds(jobs, input.id, {
				runMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
				idleMs: input.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
				signal: context.abortSignal,
			})
		} catch {
			// The signal fired before either bound did — Stop, or the run's
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

		if (outcome.kind === 'timeout') {
			return {
				success: false,
				output: describeJobWaitTimeout(input.id, outcome),
				data: {
					jobId: input.id,
					timedOut: outcome.cause,
					nextOffset: outcome.nextOffset,
					droppedBytes: outcome.droppedBytes,
				},
			}
		}

		// The dropped count is stated, never absorbed — same rule `job read`
		// follows, for the same reason: a job whose middle vanished quietly
		// reads as a complete result that happens to be short.
		const notice =
			outcome.droppedBytes > 0
				? `[${outcome.droppedBytes} bytes were dropped before this point — the job produced output faster than the retention cap holds]\n`
				: ''
		const status =
			outcome.exitCode === undefined
				? outcome.status
				: `${outcome.status} with code ${outcome.exitCode}`

		return {
			success: true,
			output: `${notice}${outcome.output || '(no output)'}\n\n[job ${input.id} is ${status}; next_offset ${outcome.nextOffset}]`,
			data: {
				jobId: input.id,
				status: outcome.status,
				nextOffset: outcome.nextOffset,
				droppedBytes: outcome.droppedBytes,
				...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
			},
		}
	},
})
