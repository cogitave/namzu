/**
 * The one line a person reads for the two calls that only ask about work:
 * `agent_task_list` and `wait_for_task`. The model gets a JSON body and a
 * framed agent answer; neither is shown. The agent's own answer is drawn by
 * the agent rows, and a finished call here says how it came out.
 *
 * A host holds only the text the model got, so both read it, defensively: a
 * body that does not parse says the generic thing rather than failing.
 */

const TERMINAL_STATES: ReadonlySet<string> = new Set([
	'completed',
	'failed',
	'canceled',
	'cancelled',
	'rejected',
])

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`
}

/** `Checking agents` while the call runs; the input has nothing a person reads. */
export const AGENT_LIST_CALL_LABEL = 'Checking agents'

/** `Waiting for background work` while the call runs; a host names the agent when it knows it. */
export const WAIT_CALL_LABEL = 'Waiting for background work'

/** What a finished `agent_task_list` call found, from its JSON body. */
export function agentListLabel(output: string): string {
	let body: unknown
	try {
		body = JSON.parse(output)
	} catch {
		return 'Checked agents'
	}
	if (!body || typeof body !== 'object') return 'Checked agents'
	const fields = body as {
		tasks?: unknown
		agents?: unknown
		workflows?: unknown
	}
	if (Array.isArray(fields.agents)) {
		return fields.agents.length === 0
			? 'No saved agents'
			: `${plural(fields.agents.length, 'saved agent')}`
	}
	const tasks = Array.isArray(fields.tasks) ? fields.tasks : []
	const running = tasks.filter(
		(task) =>
			task &&
			typeof task === 'object' &&
			typeof (task as { state?: unknown }).state === 'string' &&
			!TERMINAL_STATES.has((task as { state: string }).state),
	).length
	const runs = Array.isArray(fields.workflows)
		? fields.workflows.filter(
				(run) =>
					run && typeof run === 'object' && (run as { status?: unknown }).status === 'running',
			).length
		: 0
	const parts: string[] = []
	if (running > 0) parts.push(`${plural(running, 'agent')} running`)
	if (runs > 0) parts.push(`${plural(runs, 'workflow')} running`)
	if (parts.length > 0) return parts.join(' · ')
	const finished = tasks.length
	return finished > 0 ? `${plural(finished, 'agent')}, all finished` : 'Nothing running'
}

/** How a finished `wait_for_task` call came out, from the text the model got. */
export function waitResultLabel(output: string): string {
	if (/is a workflow run, not a task/.test(output)) return 'Workflow run: nothing to wait for'
	const status = /^status: (\S+)/m.exec(output)?.[1]
	if (status !== undefined) {
		if (status === 'completed') return 'Finished'
		const word = status.replace(/[_-]+/g, ' ')
		return word.charAt(0).toUpperCase() + word.slice(1)
	}
	if (/went quiet|still running|queued for an available slot/.test(output)) return 'Still running'
	return 'Waited'
}
