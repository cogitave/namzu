import { type BackgroundJob, describeMonitorEnd } from '@namzu/sdk'
import { tokenColor } from './theme.js'

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

/**
 * The command, shortened for a person: a leading `cd <folder> &&` (the shell
 * line the model prefixes to stay in the project) is dropped, since the row says
 * nothing the folder does not.
 */
function commandLabel(whole: string): string {
	const stripped = whole.trim().replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/u, '')
	const command = stripped.length > 0 ? stripped : whole
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

/** What a background command is called to the person: its label when it has one, else its shortened command. */
export function jobLabel(job: { readonly command: string; readonly description?: string }): string {
	const named = job.description?.replace(/\s+/gu, ' ').trim()
	return named ? named : commandLabel(job.command)
}

export function jobExitRow(job: {
	readonly command: string
	readonly description?: string
	readonly status: 'exited' | 'killed'
	readonly exitCode?: number
	readonly signal?: string
	readonly runtimeMs?: number
}): JobExitRow {
	const label = `Background command "${jobLabel(job)}"`
	const meta = job.runtimeMs === undefined ? {} : { meta: runtime(job.runtimeMs) }
	if (job.status === 'killed') {
		return { text: `${label} was stopped`, color: tokenColor('status.warn'), ...meta }
	}
	if (job.exitCode === 0) {
		return {
			text: `${label} finished (exit code 0)`,
			color: tokenColor('status.ok'),
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
		color: tokenColor('status.error'),
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
			color: tokenColor('status.warn'),
			...meta,
		}
	}
	if (job.stopReason === 'too_much_output') {
		return {
			text: `Monitor "${label}" stopped: it printed too much`,
			color: tokenColor('status.warn'),
			...meta,
		}
	}
	const color =
		end.status === 'completed'
			? tokenColor('status.ok')
			: end.status === 'failed'
				? tokenColor('status.error')
				: tokenColor('status.warn')
	return { text: end.summary, color, ...meta }
}
