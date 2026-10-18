import { theme } from './theme.js'

/**
 * The transcript row for a background command that ended, in the plain words
 * of a shell: `Background command "<command>" completed (exit code 0)`. The
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
		return { text: `${label} completed (exit code 0)`, color: theme.status.ok, ...meta }
	}
	const how =
		job.exitCode !== undefined
			? `exit code ${job.exitCode}`
			: job.signal
				? `signal ${job.signal}`
				: 'an unknown exit'
	return { text: `${label} failed with ${how}`, color: theme.status.error, ...meta }
}
