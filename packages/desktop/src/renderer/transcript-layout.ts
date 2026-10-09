import type { ThreadState, TimelineEntry } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import type { ActionKind, ToolTranscriptState } from './tool-transcript-presentation.js'

export interface TranscriptSegment {
	user: TimelineEntry[]
	activity: TimelineEntry[]
	answer: TimelineEntry[]
}
export interface TranscriptTurn extends TranscriptSegment {
	turn: number
	/** A later user input starts a new visible segment in the same execution turn. */
	segments: TranscriptSegment[]
}

export function toolGroupLabel(
	tools: ThreadState['tools'][string][],
	active: boolean,
	states?: ToolTranscriptState[],
): string {
	if (tools.length && tools.every((tool) => tool.title === 'search_conversation')) {
		if (
			states?.some(
				(state) =>
					state === 'failed' ||
					state === 'cancelled' ||
					state === 'interrupted' ||
					state === 'skipped',
			)
		)
			return 'Some earlier-message checks did not finish'
		if (states?.some((state) => state === 'waiting')) return 'Waiting to check earlier messages'
		if (active) return 'Checking earlier messages'
		return 'Checked earlier messages'
	}
	const commands = tools.some(
		(tool) =>
			(tool.view.kind === 'terminal' && tool.view.command?.trim()) ||
			(tool.callView?.kind === 'terminal' && tool.callView.command?.trim()),
	)
	const edits = tools.some((tool) => tool.view.kind === 'diff' && tool.view.path?.trim())
	const names = [edits ? 'File changes' : '', commands ? 'Commands' : ''].filter(Boolean).join(', ')
	if (states?.some((state) => !['running', 'completed'].includes(state))) {
		const counts = new Map<ToolTranscriptState, number>()
		for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1)
		const summary = [...counts].map(
			([state, count]) =>
				`${counts.size > 1 ? `${count} ` : ''}${state === 'waiting' ? 'waiting for approval' : state}`,
		)
		return `${names || 'Actions'} · ${summary.join(', ')}`
	}
	if (active)
		return (
			[edits ? 'Editing files' : '', commands ? 'Running commands' : '']
				.filter(Boolean)
				.join(', ') || 'Working on actions'
		)
	if (tools.every((tool) => tool.status === 'completed'))
		return (
			[edits ? 'Edited files' : '', commands ? 'Ran commands' : ''].filter(Boolean).join(', ') ||
			'Actions completed'
		)
	return `${names || 'Actions'} · ${tools.some((tool) => tool.status === 'failed') ? 'failed' : 'interrupted'}`
}

/** One action of a run, as far as its summary row needs to know. */
export interface RunAction {
	kind: ActionKind
	/** What it acted on, so two edits of one file count once. */
	subject?: string
	state: ToolTranscriptState
}

type RunCategory = ActionKind

function counted(count: number, one: string, many: (count: number) => string): string {
	return count === 1 ? one : many(count)
}

function categoryPhrase(category: RunCategory, count: number, live: boolean): string {
	const phrase: Record<
		RunCategory,
		[string, string, (count: number) => string, (count: number) => string]
	> = {
		edit: [
			'edited a file',
			'editing a file',
			(n) => `edited ${n} files`,
			(n) => `editing ${n} files`,
		],
		command: [
			'ran a command',
			'running a command',
			(n) => `ran ${n} commands`,
			(n) => `running ${n} commands`,
		],
		read: ['read a file', 'reading a file', (n) => `read ${n} files`, (n) => `reading ${n} files`],
		search: ['searched', 'searching', (n) => `searched ${n} times`, (n) => `searching ${n} times`],
		web: [
			'searched the web',
			'searching the web',
			() => 'searched the web',
			() => 'searching the web',
		],
		lookup: [
			'checked earlier messages',
			'checking earlier messages',
			() => 'checked earlier messages',
			() => 'checking earlier messages',
		],
		other: ['used a tool', 'using a tool', (n) => `used ${n} tools`, (n) => `using ${n} tools`],
	}
	const [done, doing, doneMany, doingMany] = phrase[category]
	return live ? counted(count, doing, doingMany) : counted(count, done, doneMany)
}

/**
 * The summary of a run of consecutive actions: counted, in the order each kind first appears.
 * "Edited a file, ran 2 commands"; while the run is live, "Editing a file, running 2 commands".
 */
export function actionRunLabel(actions: RunAction[], live: boolean): string {
	const subjects = new Map<RunCategory, Set<string>>()
	const counts = new Map<RunCategory, number>()
	let declined = 0
	for (const action of actions) {
		// A declined action did not happen, so it is not counted as an edit or a command.
		if (action.state === 'declined') {
			declined += 1
			continue
		}
		const category = action.kind
		// Files are counted once each; the other kinds count every action.
		if ((category === 'edit' || category === 'read') && action.subject) {
			const seen = subjects.get(category) ?? new Set<string>()
			seen.add(action.subject)
			subjects.set(category, seen)
			counts.set(category, seen.size)
		} else counts.set(category, (counts.get(category) ?? 0) + 1)
	}
	const phrases = [...counts].map(([category, count]) => categoryPhrase(category, count, live))
	// A folded run must not read as all done when some of it failed.
	if (declined) phrases.push(declined === 1 ? 'declined an action' : `declined ${declined} actions`)
	const failed = actions.filter((action) => action.state === 'failed').length
	if (failed) phrases.push(`${failed} failed`)
	const text = phrases.join(', ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A finished run this long or shorter stays open; a longer one folds to its summary row. */
export const openRunLimit = 5

/** Whether a run is open before the person chooses: while it works, or while it is short. */
export function runDefaultOpen(live: boolean, actions: number): boolean {
	return live || actions <= openRunLimit
}

/** Which kind names the icon of a run's summary row: an edit wins, else the most common kind. */
export function actionRunKind(actions: RunAction[]): ActionKind {
	if (actions.some((action) => action.kind === 'edit')) return 'edit'
	const counts = new Map<ActionKind, number>()
	for (const action of actions) counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1)
	let best: ActionKind = 'other'
	let most = 0
	// Map keeps first-appearance order, so a tie goes to the earlier kind.
	for (const [kind, count] of counts)
		if (count > most) {
			best = kind
			most = count
		}
	return best
}

/** Entries of one turn split at narration: each run of consecutive actions, and each other entry alone. */
export function splitActivity(
	entries: TimelineEntry[],
): ({ run: TimelineEntry[] } | { entry: TimelineEntry })[] {
	const parts: ({ run: TimelineEntry[] } | { entry: TimelineEntry })[] = []
	for (const entry of entries) {
		const last = parts.at(-1)
		if (entry.kind !== 'tool') parts.push({ entry })
		else if (last && 'run' in last) last.run.push(entry)
		else parts.push({ run: [entry] })
	}
	return parts
}

/** Group activity only when the admitted events actually distinguish it. */
export function transcriptTurns(thread: ThreadState): TranscriptTurn[] {
	const groups = new Map<number, TimelineEntry[]>()
	for (const entry of thread.timeline) {
		const entries = groups.get(entry.turn) ?? []
		entries.push(entry)
		groups.set(entry.turn, entries)
	}
	return [...groups].map(([turn, entries]) => {
		const segments: TranscriptSegment[] = []
		let user: TimelineEntry[] = []
		let work: TimelineEntry[] = []
		const append = () => {
			if (!user.length && !work.length) return
			const hasActivity = work.some(
				(entry) => entry.kind !== 'message' || thread.messages[entry.index]?.phase === 'commentary',
			)
			if (!hasActivity) {
				segments.push({ user, activity: [], answer: work })
			} else {
				// An answer is a suffix: never move it across a later thought/tool event.
				let split = work.length
				while (split > 0) {
					const entry = work[split - 1]
					if (entry?.kind !== 'message') break
					const message = thread.messages[entry.index]
					if (!message || message.role !== 'assistant' || message.phase === 'commentary') break
					split -= 1
				}
				segments.push({ user, activity: work.slice(0, split), answer: work.slice(split) })
			}
			user = []
			work = []
		}
		for (const entry of entries) {
			if (entry.kind === 'message' && thread.messages[entry.index]?.role === 'user') {
				if (work.length) append()
				user.push(entry)
				continue
			}
			if (entry.kind === 'tool') {
				if (thread.tools[entry.id]) work.push(entry)
				continue
			}
			if (entry.kind === 'reasoning') {
				if (thread.reasoning[entry.id]?.text.trim()) work.push(entry)
				continue
			}
			const message = thread.messages[entry.index]
			if (message?.text.trim() || message?.attachments?.length) work.push(entry)
		}
		append()
		return {
			turn,
			segments,
			user: segments.flatMap((segment) => segment.user),
			activity: segments.flatMap((segment) => segment.activity),
			answer: segments.flatMap((segment) => segment.answer),
		}
	})
}

export function elapsedLabel(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000))
	const hours = Math.floor(seconds / 3600)
	const minutes = Math.floor((seconds % 3600) / 60)
	const remainder = seconds % 60
	return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`
}

export function transcriptOutcome(
	reason?: string,
): 'completed' | 'paused' | 'stopped' | 'incomplete' | 'unknown' {
	if (!reason) return 'unknown'
	if (reason === 'end_turn' || reason === 'stop_condition') return 'completed'
	if (reason === 'paused' || reason === 'pause_turn') return 'paused'
	if (reason === 'cancelled' || reason === 'canceled' || reason === 'aborted') return 'stopped'
	return 'incomplete'
}

/**
 * The notice under a finished turn. A turn stopped while an action waited for an answer says that
 * action did not happen, so nobody wonders whether the command ran.
 */
export function turnNotice(thread: ThreadState, closedWhileRunning = false): string | undefined {
	const reason = thread.turns[thread.turn]?.reason ?? thread.stopReason
	const notice = terminalNotice(reason)
	if (!notice || transcriptOutcome(reason) !== 'stopped') return notice
	// The window closed under a running reply: that, not the person, is why it stopped.
	if (closedWhileRunning) return 'Stopped because Namzu was closed.'
	const waited = thread.unanswered?.turn === thread.turn ? thread.unanswered.calls : []
	const kinds = new Set(
		waited.map((call) => {
			const name = call.name.toLowerCase()
			if (['bash', 'shell', 'run_command', 'exec'].includes(name)) return 'command'
			if (['edit', 'write', 'multiedit', 'delete', 'delete_file'].includes(name)) return 'change'
			return 'action'
		}),
	)
	if (kinds.size === 0) return notice
	const only = kinds.size === 1 ? [...kinds][0] : undefined
	if (waited.length > 1)
		return `${notice} ${only ? `The ${only}s` : 'The actions'} waiting for your answer were not run.`
	if (only === 'change') return `${notice} The change waiting for your answer was not made.`
	return `${notice} The ${only ?? 'action'} waiting for your answer was not run.`
}

export function terminalNotice(reason?: string): string | undefined {
	const outcome = transcriptOutcome(reason)
	if (outcome === 'unknown' || outcome === 'completed') return undefined
	if (outcome === 'paused') return 'Paused.'
	if (outcome === 'stopped') return 'Stopped.'
	if (reason === 'max_turns' || reason === 'max_iterations')
		return 'The configured turn limit was reached.'
	if (reason === 'token_budget' || reason === 'max_tokens')
		return 'The configured token budget was reached.'
	if (reason === 'cost_limit') return 'The configured cost limit was reached.'
	if (reason === 'cost_unmeasurable')
		return 'Stopped because the configured cost budget could not be measured.'
	if (reason === 'timeout') return 'This turn timed out.'
	if (reason === 'step_refused') return 'Stopped by the configured execution policy.'
	if (reason === 'refused') return 'The action was declined.'
	if (reason === 'answer_rejected') return 'The response did not pass the configured review.'
	if (reason === 'plan_rejected') return 'The plan did not pass the configured review.'
	if (
		reason === 'guardrail_blocked' ||
		reason === 'input_guardrail' ||
		reason === 'output_guardrail'
	)
		return 'This turn was blocked by a configured guardrail.'
	if (reason === 'structured_output_failed')
		return 'The response did not match the required format.'
	return 'This turn could not finish.'
}

/**
 * How long a finished turn took, from what was actually recorded: host start and end, the
 * durable runtime duration, or the host start and the last time seen in the turn. Never guessed.
 */
export function turnDurationMs(thread: ThreadState, turn: number): number | undefined {
	const timing = thread.turns[turn]
	if (timing?.startedAt !== undefined && timing.endedAt !== undefined)
		return Math.max(0, timing.endedAt - timing.startedAt)
	const recorded = timing?.recordedDurationMs
	if (recorded !== undefined && Number.isFinite(recorded) && recorded >= 0) return recorded
	if (timing?.startedAt === undefined) return undefined
	let last: number | undefined
	for (const entry of thread.timeline) {
		if (entry.turn !== turn) continue
		const time =
			entry.kind === 'message'
				? thread.messages[entry.index]?.time
				: entry.kind === 'tool'
					? (thread.tools[entry.id]?.endedTime ?? thread.tools[entry.id]?.startedTime)
					: (thread.reasoning[entry.id]?.endedTime ?? thread.reasoning[entry.id]?.startedTime)
		if (time && Number.isFinite(time.at) && (last === undefined || time.at > last)) last = time.at
	}
	return last !== undefined && last >= timing.startedAt ? last - timing.startedAt : undefined
}

const SEPARATOR_GAP_MS = 6 * 60 * 60 * 1000

/**
 * Which known times get a date separator before them: the first one, a new calendar day, or a
 * gap of more than six hours. Unknown times (undefined) never produce one and never move the
 * reference point. The result is parallel to the input.
 */
export function dateSeparatorFlags(times: readonly (number | undefined)[]): boolean[] {
	let previous: number | undefined
	return times.map((at) => {
		if (at === undefined || !Number.isFinite(at)) return false
		const show =
			previous === undefined || !sameLocalDay(previous, at) || at - previous > SEPARATOR_GAP_MS
		previous = at
		return show
	})
}

function sameLocalDay(a: number, b: number): boolean {
	const x = new Date(a)
	const y = new Date(b)
	return (
		x.getFullYear() === y.getFullYear() &&
		x.getMonth() === y.getMonth() &&
		x.getDate() === y.getDate()
	)
}

export function dateSeparatorLabel(at: number, locale?: string | string[]): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(at))
}

/**
 * Whether a Worked block is open: the person's saved choice always wins; without one it is open
 * while the reply is being written and folds to its "Worked for" line when the reply ends.
 */
export function workBlockOpen(saved: boolean | undefined, live: boolean): boolean {
	return saved ?? live
}

export type ReplyClock =
	| { at: 'answer'; entry: TimelineEntry; time: NonNullable<ChatMessage['time']> }
	| { at: 'turn'; time: NonNullable<ChatMessage['time']> }

function knownTime(time: ChatMessage['time']): time is NonNullable<ChatMessage['time']> {
	return !!time && Number.isFinite(time.at) && time.at >= 0
}

/**
 * The one clock a reply shows, at its bottom: the last answer message's time, or, when the reply
 * ends without answer text (stopped, failed, only actions), the time its work ended. Nothing while
 * the reply is still being written, and nothing when no time was ever recorded.
 */
export function replyClock(
	thread: ThreadState,
	group: Pick<TranscriptTurn, 'turn' | 'segments' | 'activity'>,
	live: boolean,
): ReplyClock | undefined {
	if (live) return undefined
	// A steering message ends the earlier segment; only the reply's last segment closes it.
	const answer = group.segments.at(-1)?.answer ?? []
	for (let index = answer.length - 1; index >= 0; index--) {
		const entry = answer[index]
		const message = entry?.kind === 'message' ? thread.messages[entry.index] : undefined
		if (!entry || !message || message.role !== 'assistant') continue
		if (!message.text.trim() && !message.attachments?.length) continue
		if (knownTime(message.time)) return { at: 'answer', entry, time: message.time }
		break
	}
	const timing = thread.turns[group.turn]
	if (knownTime(timing?.endedTime)) return { at: 'turn', time: timing.endedTime }
	if (timing?.endedAt !== undefined && knownTime({ at: timing.endedAt, source: 'host' }))
		return { at: 'turn', time: { at: timing.endedAt, source: 'host' } }
	let last: NonNullable<ChatMessage['time']> | undefined
	for (const entry of group.activity) {
		const time =
			entry.kind === 'message'
				? thread.messages[entry.index]?.time
				: entry.kind === 'tool'
					? (thread.tools[entry.id]?.endedTime ?? thread.tools[entry.id]?.startedTime)
					: (thread.reasoning[entry.id]?.endedTime ?? thread.reasoning[entry.id]?.startedTime)
		if (knownTime(time) && (!last || time.at > last.at)) last = time
	}
	return last ? { at: 'turn', time: last } : undefined
}
