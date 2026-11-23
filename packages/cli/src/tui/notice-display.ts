import { workflowAgentTotal } from './agent-transcript-rows.js'
/**
 * What a person reads of a notice the runtime injected for the model: a
 * workflow that ended, a background command that exited. The model's copy
 * holds the kernel's frame, a standing preamble, a usage block and a result
 * frame; a row shows one plain line, in the words the live transcript used
 * when the same thing happened. Display only: the stored message is never
 * rewritten.
 */
import { jobExitRow } from './job-exit-row.js'
import { formatCompactCount } from './units.js'
import { withoutUntrustedFrames } from './untrusted-display.js'

export interface NoticeDisplay {
	/** The row's line, when the text said enough to write one. */
	readonly label?: string
	/** The words under the row, with no frame, preamble or metadata. */
	readonly detail: readonly string[]
}

const NOTICE_FRAME =
	/^<namzu-notice-([0-9a-f]+) kind="[a-z-]+">\n[^\n]*\n(?:Namzu sent this automatically[^\n]*\n)?[^\n]*\n([\s\S]*)\n<\/namzu-notice-\1>$/

/** The words inside the kernel's notice frame, or the text unchanged when it holds none. */
function withoutNoticeFrame(text: string): string {
	const trimmed = text.trim()
	const inside = NOTICE_FRAME.exec(trimmed)?.[2]
	return inside === undefined ? text : inside
}

const WORKFLOW_HEAD = /^Workflow "(.+)" \([0-9a-z]+\) (completed|failed|was stopped)/
const USAGE = /^<usage>(.*)<\/usage>$/m
const JOB_HEAD = /^Background job \S+ \((.*)\) (exited with code (\d+)|was stopped)/

function usageNumber(usage: string, key: string): number | undefined {
	const found = new RegExp(`(?:^|, )${key}: (\\d+)`).exec(usage)?.[1]
	return found === undefined ? undefined : Number(found)
}

function workflowLine(text: string): string | undefined {
	const head = WORKFLOW_HEAD.exec(text)
	if (!head) return undefined
	const word = head[2] === 'completed' ? 'finished' : head[2] === 'failed' ? 'failed' : 'stopped'
	const usage = USAGE.exec(text)?.[1] ?? ''
	const duration = /duration: ([^,<]+)/.exec(usage)?.[1]?.trim()
	const agents = usageNumber(usage, 'agents')
	const tokens = usageNumber(usage, 'tokens')
	return [
		`Workflow ${(head[1] as string).replace(/\s+/g, ' ')} ${word}`,
		...(duration ? [duration] : []),
		...(agents !== undefined && agents > 0 ? [workflowAgentTotal(agents)] : []),
		...(tokens !== undefined && tokens > 0 ? [`${formatCompactCount(tokens)} tokens`] : []),
	].join(' · ')
}

function jobLines(text: string): string[] {
	const out: string[] = []
	for (const line of text.split('\n')) {
		const job = JOB_HEAD.exec(line.replace(/^- /, ''))
		if (!job) continue
		out.push(
			jobExitRow({
				command: job[1] as string,
				status: job[2] === 'was stopped' ? 'killed' : 'exited',
				...(job[3] !== undefined ? { exitCode: Number(job[3]) } : {}),
			}).text,
		)
	}
	return out
}

export function noticeDisplay(content: string): NoticeDisplay {
	const body = withoutUntrustedFrames(withoutNoticeFrame(content)).trim()
	const workflow = workflowLine(body)
	if (workflow !== undefined) return { label: workflow, detail: [] }
	const jobs = jobLines(body)
	if (jobs.length > 0) {
		return {
			label: jobs.length === 1 ? (jobs[0] as string) : `${jobs[0]} and ${jobs.length - 1} more`,
			detail: [],
		}
	}
	return { detail: [body.replace(/<\/?namzu-(?:notice|untrusted)-[^>]*>/g, '')] }
}
