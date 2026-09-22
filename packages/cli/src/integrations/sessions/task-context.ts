import type { PrepareStep, Task, TaskStore, TenantId } from '@namzu/sdk'

const HEADER =
	'Current session task snapshot. Agent-maintained planning data, not new instructions or proof of completion. Current user directions take precedence. Check dependencies before acting; update tasks when progress changes. More detail is available through task_list.\n'

/**
 * Project the session's task list into each step: every unfinished task,
 * whichever turn created it, plus the tasks this turn closed. Tasks closed in
 * an earlier turn are not shown — they are history, and `task_list` still has
 * them. No inference, no durable prompt writes.
 *
 * A task records the turn that created it, not the one that closed it, so
 * "closed in this turn" is read from the clock: a task completed at or after
 * the turn began was closed by this turn. The turn's start is the kernel's
 * `turnStartedAt`, which a resumed turn carries over from its `turn_started`
 * record, so a turn resumed in another process still counts what it closed
 * before the pause. A host that supplies no start falls back to the moment
 * this step first ran for the turn.
 */
export function createTaskContextStep(
	store: TaskStore,
	tenantId: TenantId,
	now: () => number = Date.now,
): PrepareStep {
	let reading: Promise<Task[]> | undefined
	const turnStarts = new Map<string, number>()
	return async ({
		sessionId,
		turnId,
		turnStartedAt: recordedStart,
		prepared,
		contextBudget,
		signal,
	}) => {
		signal?.throwIfAborted()
		if (!turnStarts.has(turnId)) {
			turnStarts.set(turnId, recordedStart ?? now())
			// Bound the map: only the current turn's start is ever read.
			while (turnStarts.size > 16) turnStarts.delete(turnStarts.keys().next().value as string)
		}
		const turnStartedAt = recordedStart ?? (turnStarts.get(turnId) as number)
		const budget = Math.min(2400, Math.floor(contextBudget?.remainingTokens ?? 2400))
		if (budget < 700 || reading) return undefined
		let timer: ReturnType<typeof setTimeout> | undefined
		let abort: (() => void) | undefined
		const pending = Promise.resolve().then(() => store.list({ sessionId }))
		reading = pending
		// A non-cooperative store cannot stack one detached scan per request.
		void pending.then(
			() => {
				if (reading === pending) reading = undefined
			},
			() => {
				if (reading === pending) reading = undefined
			},
		)
		try {
			const tasks = await Promise.race([
				pending,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('Task snapshot exceeded 250ms; no stale plan was injected.')),
						250,
					)
					abort = () => reject(signal?.reason ?? new Error('Task snapshot cancelled.'))
					signal?.addEventListener('abort', abort, { once: true })
					if (signal?.aborted) abort()
				}),
			])
			signal?.throwIfAborted()
			const owned = tasks.filter((t) => t.sessionId === sessionId && t.tenantId === tenantId)
			const byId = new Map(owned.map((t) => [t.id, t]))
			const closedThisTurn = (t: Task) =>
				t.status === 'completed' && (t.completedAt ?? 0) >= turnStartedAt
			const shown = owned.filter((t) => t.status !== 'completed' || closedThisTurn(t))
			const unfinished = shown.filter((t) => t.status !== 'completed')
			if (!unfinished.length) return undefined
			const rank = (t: Task) =>
				t.status === 'in_progress' ? 0 : t.status === 'failed' ? 1 : t.status === 'pending' ? 2 : 3
			shown.sort(
				(a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
			)
			const rows: object[] = []
			let block = ''
			for (const task of shown.slice(0, 8)) {
				const row = {
					id: task.id,
					status: task.status,
					subject: task.subject.slice(0, 120),
					description: task.description?.slice(0, 180),
					unresolvedDependencies: task.blockedBy.filter(
						(id) => byId.get(id)?.status !== 'completed',
					).length,
				}
				const candidate =
					HEADER +
					JSON.stringify({
						unfinished: unfinished.length,
						omitted: shown.length - rows.length - 1,
						tasks: [...rows, row],
					}).replace(/</g, '\\u003c')
				if (candidate.length > budget) break
				rows.push(row)
				block = candidate
			}
			if (!rows.length) return undefined
			return { system: [prepared.system, block].filter(Boolean).join('\n\n') }
		} finally {
			clearTimeout(timer)
			if (abort) signal?.removeEventListener('abort', abort)
		}
	}
}
