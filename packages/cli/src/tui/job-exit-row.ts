import { type BackgroundJob, describeMonitorEnd } from '@namzu/sdk'
import { theme } from './theme.js'

/**
 * The transcript row for a background command that ended, in the plain words
 * of a shell: `Background command "<command>" finished (exit code 0)`. The
 * model's own notice (which carries the job id it needs) is a separate string;
 * the person never sees the id.
 */
export interface JobExitRow {
	readonly text: string
	readonly color: string
	readonly meta?: string
}

const MAX_COMMAND_CHARS = 60

function commandLabel(command: string): string {
	const firstLine = command.trim().split('\n')[0] ?? ''
	const flat = firstLine.replace(/\s+/gu, ' ')
	const clipped =
		flat.length > MAX_COMMAND_CHARS ? `${flat.slice(0, MAX_COMMAND_CHARS - 1)}…` : flat
	return command.trim().includes('\n') && !clipped.endsWith('…') ? `${clipped}…` : clipped
}

function runtime(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function jobExitRow(job: {
	readonly command: string
	readonly status: 'exited' | 'killed'
	readonly exitCode?: number
	readonly signal?: string
	readonly runtimeMs?: number
}): JobExitRow {
	const label = `Background command "${commandLabel(job.command)}"`
	const meta = job.runtimeMs === undefined ? {} : { meta: runtime(job.runtimeMs) }
	if (job.status === 'killed') {
		return { text: `${label} was stopped`, color: theme.status.warn, ...meta }
	}
	if (job.exitCode === 0) {
		return {
			text: `${label} finished (exit code 0)`,
			color: theme.status.ok,
			...meta,
		}
	}
	const how =
		job.exitCode !== undefined
			? `exit code ${job.exitCode}`
			: job.signal
				? `signal ${job.signal}`
				: 'an unknown exit'
	return {
		text: `${label} failed with ${how}`,
		color: theme.status.error,
		...meta,
	}
}

/**
 * The row for a monitor that ended, in the words the model was told: the same
 * `describeMonitorEnd` the kernel uses, so the transcript and the model never
 * disagree. A watch that ran out its time says so rather than "stopped",
 * since nobody asked for that stop.
 */
export function monitorEndRow(
	job: BackgroundJob,
	stats: { readonly stdoutChars: number },
): JobExitRow {
	const end = describeMonitorEnd(job, stats)
	const meta = job.exitedAt === undefined ? {} : { meta: runtime(job.exitedAt - job.startedAt) }
	const label = job.description ?? 'unnamed'
	if (job.stopReason === 'expired') {
		return {
			text: `Monitor "${label}" ran out of time`,
			color: theme.status.warn,
			...meta,
		}
	}
	if (job.stopReason === 'too_much_output') {
		return {
			text: `Monitor "${label}" stopped: it printed too much`,
			color: theme.status.warn,
			...meta,
		}
	}
	const color =
		end.status === 'completed'
			? theme.status.ok
			: end.status === 'failed'
				? theme.status.error
				: theme.status.warn
	return { text: end.summary, color, ...meta }
}
