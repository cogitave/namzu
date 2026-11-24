/**
 * The rows a team leaves in the lead's conversation, as data: a teammate's mail folded into one
 * dim line, an idle teammate, a shutdown, a plan waiting for the person, a task handed over. Each
 * row has its words as plain `content` and as `spans`, so a teammate's name is drawn in its own
 * colour where the screen can and read as plain text everywhere else. Nothing here draws or reads
 * the screen; `App.tsx` writes the rows.
 */

import type { SubagentMailLabel } from '../integrations/subagents/activity.js'
import { fallbackTeamColor } from '../integrations/teams/colors.js'
import type { TeamMailEvent } from '../integrations/teams/view.js'
import type { DisplaySpan } from './markdown-wrap.js'
import { tokenColor } from './theme.js'
import type { ToolRow } from './tool-end-rows.js'
import { EXPAND_HINT } from './truncation.js'

const MUTED = tokenColor('text.muted')
/** The lead goes by this name in a team's mail. */
const LEAD = 'lead'

/** The colour of a name: the roster's, else a fixed one by hash so the same name always looks the same. */
export type ColorOf = (name: string) => string | undefined

export function colorFor(colorOf: ColorOf | undefined, name: string): string {
	return colorOf?.(name) ?? fallbackTeamColor(name)
}

/** `@name`, bold in the teammate's colour. */
export function nameSpan(name: string, color: string, muted = false): DisplaySpan {
	return { text: `@${name}`, tone: color, bold: true, ...(muted ? { muted: true } : {}) }
}

function plain(spans: readonly DisplaySpan[]): string {
	return spans.map((span) => span.text).join('')
}

function lines(text: string): string[] {
	return text.split(/\r?\n/u).map((line) => line.trimEnd())
}

function firstLine(text: string, max = 100): string {
	const first = lines(text.trim()).find((line) => line.trim() !== '') ?? ''
	const one = first.replace(/\s+/gu, ' ').trim()
	return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// ─── mail ────────────────────────────────────────────────────────────────

export interface MailItem {
	readonly summary?: string
	readonly body: string
}

/**
 * Mail from one teammate as one dim line: `› Message from @one`, or `› 3 messages from @one`. The
 * words behind it open with Ctrl+O: for each message `@ one ❯ summary` and its body indented two.
 */
export function mailRow(from: string, color: string, items: readonly MailItem[]): ToolRow {
	const head: DisplaySpan = {
		text: items.length === 1 ? 'Message from ' : `${items.length} messages from `,
		muted: true,
	}
	const spans: DisplaySpan[] = [head, nameSpan(from, color, true)]
	const detail: string[] = []
	items.forEach((item, index) => {
		if (index > 0) detail.push('')
		detail.push(item.summary ? `@ ${from} ❯ ${item.summary}` : `@ ${from}`)
		for (const line of lines(item.body.trim())) detail.push(line === '' ? '' : `  ${line}`)
	})
	return {
		role: 'tool',
		content: plain(spans),
		spans,
		glyph: '›',
		glyphColor: MUTED,
		contentColor: MUTED,
		detail,
		meta: EXPAND_HINT,
		activity: 'agent-result',
	}
}

// ─── idle ────────────────────────────────────────────────────────────────

export type IdleReason = 'available' | 'interrupted' | 'failed'

export interface IdleNote {
	readonly reason: IdleReason
	readonly result?: string
}

/** What an idle record says: why the teammate stopped, and what it answered. */
export function parseIdle(text: string): IdleNote {
	try {
		const value = JSON.parse(text) as { idleReason?: unknown; result?: unknown }
		const reason: IdleReason =
			value.idleReason === 'failed' || value.idleReason === 'interrupted'
				? value.idleReason
				: 'available'
		return {
			reason,
			...(typeof value.result === 'string' && value.result.trim() !== ''
				? { result: value.result }
				: {}),
		}
	} catch {
		return { reason: 'available' }
	}
}

const IDLE_WORD: Record<IdleReason, string> = {
	available: 'finished',
	interrupted: 'was interrupted',
	failed: 'failed',
}

function idleToken(reason: IdleReason): string {
	return tokenColor(
		reason === 'failed' ? 'status.error' : reason === 'interrupted' ? 'status.warn' : 'status.ok',
	)
}

/**
 * A teammate that went idle: `● Teammate @one finished` (or `was interrupted`, `failed`), the glyph
 * and words in the colour of the reason, the name in its own. Under it, dim, the first line of what it
 * answered; Ctrl+O opens the whole answer, with the task it was on.
 */
export function idleRows(
	name: string,
	color: string,
	note: IdleNote,
	taskNumber?: number,
): readonly ToolRow[] {
	const tone = idleToken(note.reason)
	const spans: DisplaySpan[] = [
		{ text: 'Teammate ', tone },
		nameSpan(name, color),
		{ text: ` ${IDLE_WORD[note.reason]}`, tone },
	]
	const rows: ToolRow[] = [
		{ role: 'tool', content: plain(spans), spans, glyph: '●', glyphColor: tone },
	]
	if (note.result === undefined) return rows
	const first = firstLine(note.result)
	const all = lines(note.result.trim())
	const more = all.length > 1 || first.endsWith('…') || taskNumber !== undefined
	const detail = [...(taskNumber !== undefined ? [`(task #${taskNumber})`] : []), ...all]
	rows.push({
		role: 'tool',
		content: first,
		spans: [{ text: first, muted: true }],
		glyph: '⎿',
		glyphColor: MUTED,
		contentColor: MUTED,
		...(more ? { detail, meta: EXPAND_HINT, activity: 'agent-result' as const } : {}),
	})
	return rows
}

// ─── shutdown ────────────────────────────────────────────────────────────

/** A teammate that approved a shutdown and left, or several that did together. */
export function shutDownRow(
	members: readonly { readonly name: string; readonly color: string }[],
): ToolRow {
	const spans: DisplaySpan[] =
		members.length === 1
			? [
					{ text: 'Teammate ', muted: true },
					nameSpan(
						(members[0] as { name: string }).name,
						(members[0] as { color: string }).color,
						true,
					),
					{ text: ' shut down', muted: true },
				]
			: [{ text: `${members.length} teammates shut down`, muted: true }]
	return {
		role: 'tool',
		content: plain(spans),
		spans,
		glyph: '●',
		glyphColor: MUTED,
		contentColor: MUTED,
	}
}

/** A teammate that would not stop: who, why, and that it can be asked again. */
export function shutdownRefusedRows(
	name: string,
	color: string,
	reason: string | undefined,
): readonly ToolRow[] {
	const head: DisplaySpan[] = [{ text: 'Shutdown refused by ' }, nameSpan(name, color)]
	const rows: ToolRow[] = [
		{ role: 'tool', content: plain(head), spans: head, glyph: '●', glyphColor: MUTED },
	]
	const why = reason?.trim()
	if (why) rows.push(dimResult(`Reason: ${firstLine(why, 200)}`))
	rows.push(dimResult('Still working. Ask again later.'))
	return rows
}

function dimResult(text: string): ToolRow {
	return {
		role: 'tool',
		content: text,
		spans: [{ text, muted: true }],
		glyph: '⎿',
		glyphColor: MUTED,
		contentColor: MUTED,
	}
}

// ─── plans ───────────────────────────────────────────────────────────────

/** A plan a teammate sent for the person to approve. The plan opens with Ctrl+O. */
export function planRequestRow(name: string, color: string, plan: string | undefined): ToolRow {
	const spans: DisplaySpan[] = [{ text: 'Plan approval request from ' }, nameSpan(name, color)]
	const body = plan?.trim()
	return {
		role: 'tool',
		content: plain(spans),
		spans,
		glyph: '●',
		glyphColor: tokenColor('accent.tool'),
		...(body ? { detail: lines(body), meta: EXPAND_HINT, activity: 'agent-result' as const } : {}),
	}
}

/** The person's answer to a plan: approved or rejected, any feedback, and what the teammate does next. */
export function planAnswerRows(
	name: string,
	color: string,
	allow: boolean,
	feedback: string | undefined,
): readonly ToolRow[] {
	const tone = tokenColor(allow ? 'status.ok' : 'status.error')
	const head: DisplaySpan[] = [
		{ text: 'Plan from ', tone },
		nameSpan(name, color),
		{ text: allow ? ' approved' : ' rejected', tone },
	]
	const rows: ToolRow[] = [
		{ role: 'tool', content: plain(head), spans: head, glyph: allow ? '✓' : '✗', glyphColor: tone },
	]
	const note = feedback?.trim()
	if (note) rows.push(dimResult(`Feedback: ${firstLine(note, 200)}`))
	rows.push(dimResult(allow ? `@${name} can now proceed.` : `@${name} will revise the plan.`))
	return rows
}

// ─── what the lead sent ──────────────────────────────────────────────────

/**
 * What the lead sent a teammate, as one row: `→ Sent to @one`, `→ Task assigned to @one · subject`,
 * `→ Asked @one to stop`. A message written by another teammate is not the lead's to read, so it
 * has no row (undefined). The words of a message or a reason open with Ctrl+O; a task shows its
 * subject and never the instruction text.
 */
export function sentRow(
	mail: SubagentMailLabel | undefined,
	to: string,
	color: string,
	body: string,
): ToolRow | undefined {
	if (mail !== undefined && mail.from !== LEAD) return undefined
	const kind = mail?.kind ?? 'message'
	const who = nameSpan(to, color)
	let spans: DisplaySpan[]
	if (kind === 'task') {
		const subject = firstLine(body, 120)
		spans = [
			{ text: 'Task assigned to ' },
			who,
			...(subject ? [{ text: ' · ' }, { text: subject, bold: true }] : []),
		]
		return { role: 'tool', content: plain(spans), spans, glyph: '→' }
	}
	spans =
		kind === 'stop' ? [{ text: 'Asked ' }, who, { text: ' to stop' }] : [{ text: 'Sent to ' }, who]
	const text = body.trim()
	return {
		role: 'tool',
		content: plain(spans),
		spans,
		glyph: '→',
		...(text ? { detail: lines(text), meta: EXPAND_HINT, activity: 'agent-result' as const } : {}),
	}
}

// ─── tasks ───────────────────────────────────────────────────────────────

/** A task a teammate completed: dim `✓ @one completed task #2 (subject)`. */
export function taskCompletedRow(
	owner: string | undefined,
	color: string,
	number: number,
	subject: string,
): ToolRow {
	const spans: DisplaySpan[] = [
		...(owner
			? [nameSpan(owner, color, true), { text: ' completed', muted: true }]
			: [{ text: 'Completed', muted: true }]),
		{ text: ` task #${number}`, muted: true },
		{ text: ` (${firstLine(subject, 80)})`, muted: true },
	]
	return {
		role: 'tool',
		content: plain(spans),
		spans,
		glyph: '✓',
		glyphColor: tokenColor('status.ok'),
		contentColor: MUTED,
	}
}

/** The tasks that became completed since the last look: ids to status, then the new list. */
export function newlyCompleted<T extends { id: string; status: string }>(
	before: ReadonlyMap<string, string> | undefined,
	tasks: readonly T[],
): readonly T[] {
	if (before === undefined) return []
	return tasks.filter((task) => task.status === 'completed' && before.get(task.id) !== 'completed')
}

// ─── the batch ───────────────────────────────────────────────────────────

type Entry =
	| { readonly type: 'mail'; readonly from: string; readonly item: MailItem }
	| { readonly type: 'shutdown'; readonly name: string }
	| { readonly type: 'rows'; readonly rows: readonly ToolRow[] }

/**
 * The lead's rows for the team's mail, folded as they arrive: messages in a row from one teammate
 * are one line, teammates that shut down in a row are one line, everything else is a row of its own.
 * Mail between two teammates, and mail the person has no part in, writes nothing.
 */
export class TeamRowBatcher {
	private entries: Entry[] = []

	constructor(private readonly colorOf?: ColorOf) {}

	/** Take one piece of the team's mail. True when it will leave a row. */
	add(event: TeamMailEvent, taskNumber?: (name: string) => number | undefined): boolean {
		if (event.kind === 'message') {
			if (event.to !== LEAD || event.from === LEAD) return false
			this.entries.push({
				type: 'mail',
				from: event.from,
				item: { ...(event.summary ? { summary: event.summary } : {}), body: event.text },
			})
			return true
		}
		if (event.to === LEAD && event.kind === 'idle') {
			this.entries.push({
				type: 'rows',
				rows: idleRows(
					event.from,
					colorFor(this.colorOf, event.from),
					parseIdle(event.text),
					taskNumber?.(event.from),
				),
			})
			return true
		}
		if (event.to === LEAD && event.kind === 'shutdown_response') {
			const answer = readJson(event.text)
			if (answer.approve === true) this.entries.push({ type: 'shutdown', name: event.from })
			else
				this.entries.push({
					type: 'rows',
					rows: shutdownRefusedRows(
						event.from,
						colorFor(this.colorOf, event.from),
						typeof answer.reason === 'string' ? answer.reason : undefined,
					),
				})
			return true
		}
		if (event.to === LEAD && event.kind === 'plan_request') {
			const plan = readJson(event.text).plan
			this.entries.push({
				type: 'rows',
				rows: [
					planRequestRow(
						event.from,
						colorFor(this.colorOf, event.from),
						typeof plan === 'string' ? plan : undefined,
					),
				],
			})
			return true
		}
		if (event.from === LEAD && event.kind === 'plan_response') {
			const answer = readJson(event.text)
			this.entries.push({
				type: 'rows',
				rows: planAnswerRows(
					event.to,
					colorFor(this.colorOf, event.to),
					answer.allow === true,
					typeof answer.feedback === 'string' ? answer.feedback : undefined,
				),
			})
			return true
		}
		return false
	}

	get pending(): boolean {
		return this.entries.length > 0
	}

	/** The rows for everything taken since the last flush, in order. */
	flush(): readonly ToolRow[] {
		const entries = this.entries
		this.entries = []
		const rows: ToolRow[] = []
		let i = 0
		while (i < entries.length) {
			const entry = entries[i] as Entry
			if (entry.type === 'rows') {
				rows.push(...entry.rows)
				i += 1
				continue
			}
			let j = i
			if (entry.type === 'mail') {
				const items: MailItem[] = []
				while (j < entries.length) {
					const next = entries[j] as Entry
					if (next.type !== 'mail' || next.from !== entry.from) break
					items.push(next.item)
					j += 1
				}
				rows.push(mailRow(entry.from, colorFor(this.colorOf, entry.from), items))
			} else {
				const members: { name: string; color: string }[] = []
				while (j < entries.length && (entries[j] as Entry).type === 'shutdown') {
					const name = (entries[j] as { name: string }).name
					members.push({ name, color: colorFor(this.colorOf, name) })
					j += 1
				}
				rows.push(shutDownRow(members))
			}
			i = j
		}
		return rows
	}
}

function readJson(text: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text) as unknown
		return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}
