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
import { type BoxRow, boxText } from './box-rows.js'
import { type DisplaySpan, inlineDisplaySpans } from './markdown-wrap.js'
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
	const chars = [...one]
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one
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
	/** What the teammate last told the lead in this turn. */
	readonly lastMessage?: string
}

/** What an idle record says: why the teammate stopped, and what it answered. */
export function parseIdle(text: string): IdleNote {
	try {
		const value = JSON.parse(text) as {
			idleReason?: unknown
			result?: unknown
			lastMessage?: unknown
		}
		const reason: IdleReason =
			value.idleReason === 'failed' || value.idleReason === 'interrupted'
				? value.idleReason
				: 'available'
		return {
			reason,
			...(typeof value.result === 'string' && value.result.trim() !== ''
				? { result: value.result }
				: {}),
			...(typeof value.lastMessage === 'string' && value.lastMessage.trim() !== ''
				? { lastMessage: value.lastMessage }
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
	if (note.result === undefined) {
		if (note.lastMessage === undefined) return rows
		rows.push(dimResult(`Last message: ${firstLine(note.lastMessage)}`))
		return rows
	}
	const first = firstLine(note.result)
	const all = lines(note.result.trim())
	const said = note.lastMessage !== undefined
	const more = all.length > 1 || first.endsWith('…') || taskNumber !== undefined || said
	const detail = [
		...(taskNumber !== undefined ? [`(task #${taskNumber})`] : []),
		...(said ? [`Last message: ${note.lastMessage}`] : []),
		// The row itself already shows the first line, unless it was cut short.
		...(first === all[0] ? all.slice(1) : all),
	]
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

/** A teammate that would not stop: a neutral box with its reason, and that it can be asked again. */
export function shutdownRefusedBox(name: string, reason: string | undefined): BoxRow {
	const why = reason?.trim()
	return {
		tone: MUTED,
		title: [{ text: 'Shutdown refused by ' }, { text: `@${name}` }],
		...(why ? { body: [[{ text: `Reason: ${firstLine(why, 400)}` }]] } : {}),
		notes: [[{ text: 'Still working. Ask again later.' }]],
	}
}

/** The request to stop a teammate, as the teammate reads it: a warning box with the lead's reason. */
export function shutdownRequestBox(from: string, reason: string | undefined): BoxRow {
	const why = reason?.trim()
	return {
		tone: tokenColor('status.warn'),
		title: [{ text: 'Shutdown request from ' }, { text: from === LEAD ? 'lead' : `@${from}` }],
		...(why ? { body: [[{ text: `Reason: ${firstLine(why, 400)}` }]] } : {}),
	}
}

/** A task handed to a teammate, as the teammate reads it: its number, who gave it, the subject and what it asks. */
export function taskAssignedBox(
	number: number | undefined,
	by: string,
	subject: string,
	description?: string,
): BoxRow {
	const extra = description?.trim()
	return {
		tone: tokenColor('accent.system'),
		title: [
			{ text: `Task${number !== undefined ? ` #${number}` : ''} assigned by ` },
			{ text: by === LEAD ? 'lead' : `@${by}` },
		],
		body: [[{ text: firstLine(subject, 200), bold: true }]],
		...(extra ? { notes: lines(extra).map((line) => [{ text: line }]) } : {}),
	}
}

/** A box as a transcript row: the words as plain text for copy, the box for the screen that draws it. */
export function boxRow(box: BoxRow): ToolRow {
	return { role: 'tool', content: boxText(box), box }
}

/** Plan text as lines of spans: inline marks drawn, a heading bold, list marks and indentation kept. */
function planLines(plan: string): (readonly DisplaySpan[])[] {
	return lines(plan.trim()).map((line) => {
		if (line.trim() === '') return []
		const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line)
		if (heading) return [{ text: heading[1] as string, bold: true }]
		const indent = /^\s*/u.exec(line)?.[0] ?? ''
		return [
			...(indent ? [{ text: indent }] : []),
			...inlineDisplaySpans(line.slice(indent.length), false),
		]
	})
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

/** A plan a teammate sent for the person to approve: a box in the plan colour with the plan inside. */
export function planRequestBox(name: string, plan: string | undefined, planFile?: string): BoxRow {
	const body = plan?.trim()
	const file = planFile?.trim()
	return {
		tone: tokenColor('accent.plan'),
		title: [{ text: 'Plan approval request from ' }, { text: `@${name}` }],
		...(body ? { body: planLines(body) } : {}),
		...(file ? { notes: [[{ text: `Plan file: ${file}` }]] } : {}),
	}
}

const SAID_PREFIX = 'The user declined this and said: '
const GENERIC_DECLINE_PREFIX = 'The user declined this.'

/** What a person wrote in a refusal. The stock text sent to the model when they wrote nothing is not theirs, so it is dropped. */
function personsWords(feedback: string | undefined): string | undefined {
	const text = feedback?.trim()
	if (!text) return undefined
	if (text.startsWith(SAID_PREFIX)) return text.slice(SAID_PREFIX.length).trim() || undefined
	if (text.startsWith(GENERIC_DECLINE_PREFIX)) return undefined
	return text
}

/** The answer to a plan: a green box when it is approved, a red one with what to change when it is not. */
export function planAnswerBox(name: string, allow: boolean, feedback: string | undefined): BoxRow {
	const note = personsWords(feedback)
	return {
		tone: tokenColor(allow ? 'status.ok' : 'status.error'),
		// The lead's transcript: the plan is the teammate's, the answer is the person's.
		title: [
			{ text: `${allow ? '✓' : '✗'} Plan from ` },
			{ text: `@${name}` },
			{ text: ` ${allow ? 'approved' : 'rejected'}` },
		],
		...(note ? { body: [[{ text: `Feedback: ${firstLine(note, 400)}` }]] } : {}),
		...(allow ? {} : { notes: [[{ text: 'Revise the plan and send it again for approval.' }]] }),
	}
}

// ─── what a waiting teammate shows ───────────────────────────────────────

/**
 * A teammate's own screen while its call waits for the lead's person: a warning box naming the tool
 * and what it would do, and that the request has gone to the lead.
 */
export function waitingForLeadBox(ask: {
	readonly tool: string
	readonly action?: string
}): BoxRow {
	const label = (text: string): DisplaySpan => ({ text: `${text.padEnd(7)}`, muted: true })
	return {
		tone: tokenColor('status.warn'),
		title: [{ text: 'Waiting for team lead approval' }],
		body: [
			...(ask.tool ? [[label('Tool'), { text: ask.tool }]] : []),
			...(ask.action ? [[label('Action'), { text: ask.action }]] : []),
		],
		notes: [[{ text: 'The request was sent to the team lead.' }]],
	}
}

/** A teammate's screen after it sent a plan: the plan went to the lead's person and it waits. */
export function planSubmittedBox(planFile?: string): BoxRow {
	const file = planFile?.trim()
	return {
		tone: tokenColor('accent.plan'),
		title: [{ text: 'Plan submitted for team lead approval' }],
		notes: [
			...(file ? [[{ text: `Plan file: ${file}` }]] : []),
			[{ text: 'Waiting for team lead approval…' }],
		],
	}
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
					rows: [
						boxRow(
							shutdownRefusedBox(
								event.from,
								typeof answer.reason === 'string' ? answer.reason : undefined,
							),
						),
					],
				})
			return true
		}
		if (event.to === LEAD && event.kind === 'plan_request') {
			const plan = readJson(event.text).plan
			const file = readJson(event.text).planFile
			this.entries.push({
				type: 'rows',
				rows: [
					boxRow(
						planRequestBox(
							event.from,
							typeof plan === 'string' ? plan : undefined,
							typeof file === 'string' ? file : undefined,
						),
					),
				],
			})
			return true
		}
		if (event.from === LEAD && event.kind === 'plan_response') {
			const answer = readJson(event.text)
			this.entries.push({
				type: 'rows',
				rows: [
					boxRow(
						planAnswerBox(
							event.to,
							answer.allow === true,
							typeof answer.feedback === 'string' ? answer.feedback : undefined,
						),
					),
				],
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
