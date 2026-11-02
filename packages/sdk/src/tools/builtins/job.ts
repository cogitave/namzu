import { z } from 'zod'

import { invalidBackgroundJobIdInput } from '../../runtime/jobs/job-id.js'
import {
	formatLivenessAge,
	formatLivenessLine,
	judgeLiveness,
} from '../../runtime/jobs/liveness.js'
import { defineTool } from '../defineTool.js'

/**
 * Read, list and stop the work `bash run_in_background` started.
 *
 * The half that was missing. The previous schema told the model to "start it
 * in the background and poll" and there was nothing to poll with: no job id,
 * no way to read output, no cleanup. That sentence was removed rather than
 * honoured, because a suggestion with no mechanism behind it is worse than
 * silence — the model follows it and gets a lie back.
 *
 * One tool with an `action` rather than three, because these are three views
 * of one object and a model choosing between `read_job` / `list_jobs` /
 * `kill_job` has three chances to pick the wrong name for the same idea.
 */

const inputSchema = z.object({
	action: z
		.enum(['read', 'list', 'kill'])
		.describe(
			'read: output since `from_offset`. list: every background job this turn started, each running one with whether it is progressing, waiting or stalled, how long since its last output, and its last output line. kill: stop a job and everything it forked.',
		),
	id: z
		.string()
		.optional()
		.describe(
			'The job id, as returned by bash with run_in_background. Required for read and kill.',
		),
	from_offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe(
			'Byte offset to read from; pass back the `next_offset` of your previous read to get only what is new. Omit to read from the start of what is retained.',
		),
})

type JobInput = z.infer<typeof inputSchema>

export const JobTool = defineTool({
	name: 'job',
	description:
		'Reads, lists and stops background jobs started by bash with run_in_background, and monitors started by monitor (whose stderr, which is not an event, is read here). To find out whether a job finished, use wait_for_job: it blocks until the job ends (or goes quiet, or runs long) and returns the output in one call, while repeated "read" calls spend turns checking. Use "read" to see output while a job keeps running, or to pick up after a wait_for_job call gave up, passing the previous call\'s next_offset to see only new output.',
	inputSchema,
	category: 'shell',
	permissions: ['shell_execute'],
	// The static permission describes the full capability. The prepared action
	// determines whether this call only observes its owner-bound registry.
	readOnly: (input: JobInput) => input?.action === 'read' || input?.action === 'list',
	destructive: (input: JobInput) => input?.action === 'kill',
	concurrencySafe: true,

	presentCall(input) {
		const label =
			input.action === 'list'
				? 'List background jobs'
				: `${input.action === 'kill' ? 'Stop background job' : 'Read background output'} · ${input.id ?? '(missing id)'}`
		return { kind: 'generic', presentation: 'activity', label }
	},

	async execute(input, context) {
		if (!context.backgroundJobs) {
			return {
				success: false,
				output: '',
				error:
					'This host provides no background job registry, so there are no background jobs to report on.',
			}
		}
		const jobs = context.backgroundJobs

		if (input.action === 'list') {
			const all = jobs.list()
			if (all.length === 0) return { success: true, output: 'No background jobs.' }
			const now = Date.now()
			const lines = all.map((job) => {
				const label = job.kind === 'monitor' ? (job.description ?? job.command) : job.command
				if (job.startedAt === undefined) {
					return `${job.id}  ${job.status.padEnd(8)}  ${job.kind === 'monitor' ? `monitor · ${label}` : label}`
				}
				const liveness = judgeLiveness(
					{
						kind: job.kind === 'monitor' ? 'monitor' : 'job',
						id: job.id,
						label,
						...(job.lastOutputLine !== undefined ? { where: job.lastOutputLine } : {}),
						startedAt: job.startedAt,
						...(job.lastOutputAt !== undefined ? { lastProgressAt: job.lastOutputAt } : {}),
						alive: job.status === 'running' && (jobs.isAlive ? jobs.isAlive(job.id) : true),
						finished: job.status !== 'running',
					},
					now,
				)
				// An ended job keeps its status word, which carries the exit.
				return job.status === 'running'
					? formatLivenessLine(liveness)
					: `${job.id}  ${job.status.padEnd(8)}  ${label}`
			})
			return {
				success: true,
				output: lines.join('\n'),
				data: { jobs: all },
			}
		}

		if (!input.id) {
			return {
				success: false,
				output: '',
				error: `action "${input.action}" needs an id. Use action "list" to see the jobs this turn has started.`,
			}
		}

		const badId = invalidBackgroundJobIdInput(input.id)
		if (badId) return { success: false, output: '', error: badId }

		try {
			if (input.action === 'kill') {
				const killed = await jobs.kill(input.id)
				return {
					success: true,
					output: `Job ${killed.id} is ${killed.status}.`,
					data: { jobId: killed.id, status: killed.status },
				}
			}

			const read = jobs.read(input.id, {
				...(input.from_offset === undefined ? {} : { fromOffset: input.from_offset }),
			})
			// The dropped count is stated, never absorbed. A job whose middle
			// vanished quietly reads as a complete result that happens to be
			// short, and the model concludes the build passed.
			const notice =
				read.droppedBytes > 0
					? `[${read.droppedBytes} bytes were dropped before this point — the job produced output faster than the retention cap holds]\n`
					: ''
			const lastOutputAt = read.status === 'running' ? jobs.get(input.id)?.lastOutputAt : undefined
			const status =
				read.status === 'running'
					? `still running${
							lastOutputAt === undefined
								? '; no output yet'
								: `; last output ${formatLivenessAge((Date.now() - lastOutputAt) / 1000)} ago`
						}`
					: read.error !== undefined
						? `failed to start: ${read.error}`
						: `${read.status}${read.exitCode === undefined ? '' : ` with code ${read.exitCode}`}`

			return {
				success: true,
				output: `${notice}${read.chunk || '(no new output)'}\n\n[job ${input.id} is ${status}; next_offset ${read.nextOffset}]`,
				data: {
					jobId: input.id,
					status: read.status,
					nextOffset: read.nextOffset,
					droppedBytes: read.droppedBytes,
					...(read.exitCode === undefined ? {} : { exitCode: read.exitCode }),
					...(read.error === undefined ? {} : { error: read.error }),
				},
			}
		} catch (err) {
			// An id from another turn reads as unknown here, because the
			// owner-bound view refuses it. That is the intended answer: a turn
			// should not be able to confirm another turn's job exists.
			return {
				success: false,
				output: '',
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},
})
