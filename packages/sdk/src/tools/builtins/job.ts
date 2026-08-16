import { z } from 'zod'

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
			'read: output since `from_offset`. list: every background job this run started, with status. kill: stop a job and everything it forked.',
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
		'Reads, lists and stops background jobs started by bash with run_in_background. Poll a job with action "read", passing the previous call\'s next_offset to see only new output.',
	inputSchema,
	category: 'shell',
	permissions: ['shell_execute'],
	// `read` and `list` observe; `kill` stops work. The tool as a whole is not
	// read-only, and claiming otherwise would let a read-only permission
	// preset hand the model a way to terminate a running process.
	readOnly: false,
	destructive: (input: JobInput) => input.action === 'kill',
	concurrencySafe: true,

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
			return {
				success: true,
				output: all.map((job) => `${job.id}  ${job.status.padEnd(8)}  ${job.command}`).join('\n'),
				data: { jobs: all },
			}
		}

		if (!input.id) {
			return {
				success: false,
				output: '',
				error: `action "${input.action}" needs an id. Use action "list" to see the jobs this run has started.`,
			}
		}

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
			const status =
				read.status === 'running'
					? 'still running'
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
				},
			}
		} catch (err) {
			// An id from another run reads as unknown here, because the
			// owner-bound view refuses it. That is the intended answer: a run
			// should not be able to confirm another run's job exists.
			return {
				success: false,
				output: '',
				error: err instanceof Error ? err.message : String(err),
			}
		}
	},
})
