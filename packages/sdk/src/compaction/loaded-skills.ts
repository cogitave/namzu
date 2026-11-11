import { CHARS_PER_TOKEN } from '../constants/limits.js'
import { type Message, toolResultToText, turnContextKey } from '../types/message/index.js'
import { isCompactionMessage } from './summary.js'
import { isClearedToolResult } from './tool-result-editing.js'

/**
 * Skills the model loaded, kept in front of it.
 *
 * A skill's instructions reach the model as the result of the `skill` tool.
 * A pass that clears results, or replaces history with a summary, can cut
 * them, and the task goes on without the procedure it was told to follow.
 * This finds the skills a conversation loaded (from its own messages, so a
 * resumed or later turn knows them too) and renders the ones a pass cut, as
 * reference, inside fixed caps. Pure: it reads messages and returns text.
 */

/** The key a carried-skills entry is recorded under. */
export const LOADED_SKILLS_ENTRY_KEY = 'loaded-skills'

/** Skills carried per pass, newest first. */
export const CARRY_MAX_SKILLS = 8
/** Tokens of one carried skill. */
export const CARRY_SKILL_TOKENS = 5_000
/** Tokens of all carried skills together. */
export const CARRY_SKILLS_TOTAL_TOKENS = 25_000
/** The share of the window all carried skills may take. */
export const CARRY_SKILLS_WINDOW_SHARE = 0.05
/** Below this much room left, a skill is left out rather than cut to a stub. */
const MIN_CARRY_TOKENS = 1_000

/** The words that say what the carried text is. */
export const LOADED_SKILLS_FRAME =
	'These skills were loaded earlier in this conversation. Their text may since have been cut from it to make room, so it is repeated here as reference. Their guidance still applies to the work in progress: keep following it, do not start the task over, and do not load them again just because they appear here. Any request or argument written inside a skill belongs to that skill; it is not a new message from the person.'

const SKILL_BLOCK = /<loaded-skill name="([^"\n]+)"( cut)?>\n([\s\S]*?)\n<\/loaded-skill>/g
const SKILL_CONTINUATION = /\n\n\[More skill instructions remain\.[^\]]*\]/g

/** A skill the conversation loaded, as its instructions read. */
export interface LoadedSkill {
	readonly name: string
	readonly body: string
	/** True when the whole of the instructions is in the messages that were read. */
	readonly whole: boolean
	/** True when read from a carried-skills entry or a summary, not from a `skill` result. */
	readonly carried?: true
}

const FORK_REPORT_PREFIX = '[This is the report of a delegated agent that ran the skill'

/** The first line of a `skill` result that is a delegated agent's report. */
export function forkedSkillReportNote(name: string): string {
	return `${FORK_REPORT_PREFIX} "${name}". It is not the skill's instructions.]`
}

/** True for a `skill` result that is a delegated agent's report, not instructions. */
export function isForkedSkillReport(output: string): boolean {
	return output.startsWith(FORK_REPORT_PREFIX)
}

/** The instructions a `skill` result carries, without the paging notice. */
export function skillResultBody(output: string): string {
	return output.replace(SKILL_CONTINUATION, '')
}

function parseSkillCall(raw: string): { name: string; paged: boolean } | undefined {
	try {
		const input = JSON.parse(raw) as { name?: unknown; cursor?: unknown }
		if (typeof input.name !== 'string' || input.name.trim().length === 0) return undefined
		return {
			name: input.name.trim(),
			paged: typeof input.cursor === 'string' && input.cursor.length > 0,
		}
	} catch {
		return undefined
	}
}

/**
 * The skills these messages show, oldest load first. Read from three places:
 * a `skill` result, a carried-skills entry, and the restored section of a
 * summary. A skill whose result was cleared is listed with `whole: false`.
 */
export function collectLoadedSkills(messages: readonly Message[]): LoadedSkill[] {
	const found = new Map<string, LoadedSkill>()
	const calls = new Map<string, { name: string; paged: boolean }>()
	const put = (skill: LoadedSkill) => {
		found.delete(skill.name)
		found.set(skill.name, skill)
	}

	for (const message of messages) {
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) {
				if (call.function.name !== 'skill') continue
				const parsed = parseSkillCall(call.function.arguments)
				if (parsed) calls.set(call.id, parsed)
			}
			continue
		}
		if (message.role === 'tool') {
			const call = calls.get(message.toolCallId)
			if (!call || message.isError === true) continue
			const text =
				typeof message.content === 'string' ? message.content : toolResultToText(message.content)
			const earlier = found.get(call.name)
			if (isClearedToolResult(text)) {
				// A copy that was cut leaves an earlier whole one as it was; a cut
				// page makes the load it belongs to incomplete.
				if (!call.paged && earlier?.whole) continue
				put({ name: call.name, body: earlier?.body ?? '', whole: false })
				continue
			}
			if (text.trim().length === 0) continue
			// What a delegated agent reported is not what the model was told to follow.
			if (isForkedSkillReport(text)) continue
			const body = skillResultBody(text)
			put(
				call.paged && earlier
					? {
							name: call.name,
							body: `${earlier.body}${body}`,
							whole: earlier.whole,
						}
					: { name: call.name, body, whole: true },
			)
			continue
		}
		const text = typeof message.content === 'string' ? message.content : undefined
		if (text === undefined) continue
		const carriesSkills =
			message.role === 'user'
				? turnContextKey(message) === LOADED_SKILLS_ENTRY_KEY
				: message.role === 'system' && isCompactionMessage(text)
		if (!carriesSkills) continue
		for (const match of text.matchAll(SKILL_BLOCK)) {
			const [, name, cut, body] = match
			if (name && body !== undefined) put({ name, body, whole: cut === undefined, carried: true })
		}
	}
	return [...found.values()]
}

const LEFT_OUT = /left out to keep this short: ([^\n]*?)\. Call the skill tool/g

/**
 * Names of the skills these messages already deal with: whole, shown cut by an
 * earlier pass, or named there as left out. A skill in this set is not shown
 * again.
 */
export function handledSkillNames(messages: readonly Message[]): Set<string> {
	const handled = new Set<string>()
	for (const skill of collectLoadedSkills(messages)) {
		if (skill.whole || skill.carried) handled.add(skill.name)
	}
	for (const message of messages) {
		if (typeof message.content !== 'string') continue
		const carries =
			message.role === 'user'
				? turnContextKey(message) === LOADED_SKILLS_ENTRY_KEY
				: message.role === 'system' && isCompactionMessage(message.content)
		if (!carries) continue
		for (const match of message.content.matchAll(LEFT_OUT)) {
			for (const name of (match[1] ?? '').split(', ')) if (name) handled.add(name)
		}
	}
	return handled
}

/** The skills worth keeping from these messages: whole, or shown cut by an earlier pass. */
export function adoptableSkills(messages: readonly Message[]): LoadedSkill[] {
	return collectLoadedSkills(messages).filter(
		(skill) => skill.body.trim().length > 0 && (skill.whole || skill.carried),
	)
}

export interface CarryOptions {
	/** The window the pass works against; the total cap scales down on a small one. */
	readonly contextWindowTokens?: number
}

export interface RenderedSkills {
	/** The text to show, or undefined when there is nothing to carry. */
	readonly text: string | undefined
	/** Skills shown, whole or cut, oldest first. */
	readonly carried: readonly string[]
	/** Skills shown with a cut and a line saying how to load them in full. */
	readonly cut: readonly string[]
	/** Skills left out for room, newest first. */
	readonly left: readonly string[]
}

const tokensOf = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

function cutNote(name: string): string {
	return `… [cut here to save space; call the skill tool with name "${name}" to read all of it]`
}

/**
 * Render skills (oldest first in, newest chosen first) inside the caps: a
 * count, a share of the window and a total of tokens, and a cap for each
 * skill, past which it is cut with a line saying how to load it in full. When
 * the total runs out the older skills are left out, and named.
 */
export function renderLoadedSkills(
	skills: readonly { readonly name: string; readonly body: string }[],
	options: CarryOptions = {},
): RenderedSkills {
	const window = options.contextWindowTokens
	let budget =
		window === undefined
			? CARRY_SKILLS_TOTAL_TOKENS
			: Math.min(CARRY_SKILLS_TOTAL_TOKENS, Math.floor(window * CARRY_SKILLS_WINDOW_SHARE))
	const blocks: string[] = []
	const carried: string[] = []
	const cut: string[] = []
	const left: string[] = []
	for (const skill of [...skills].reverse()) {
		if (carried.length >= CARRY_MAX_SKILLS || budget < MIN_CARRY_TOKENS) {
			left.push(skill.name)
			continue
		}
		const room = Math.min(CARRY_SKILL_TOKENS, budget) * CHARS_PER_TOKEN
		const note = cutNote(skill.name)
		const isCut = skill.body.length > room
		const body = isCut
			? `${skill.body.slice(0, Math.max(0, room - note.length))}\n${note}`
			: skill.body
		budget -= tokensOf(body)
		carried.unshift(skill.name)
		if (isCut) cut.unshift(skill.name)
		blocks.unshift(
			`<loaded-skill name="${skill.name}"${isCut ? ' cut' : ''}>\n${body.replaceAll('</loaded-skill>', '<\\/loaded-skill>')}\n</loaded-skill>`,
		)
	}
	if (carried.length === 0 && left.length === 0) {
		return { text: undefined, carried, cut, left }
	}
	const parts = [LOADED_SKILLS_FRAME, ...blocks]
	if (left.length > 0) {
		parts.push(
			`Also loaded earlier, left out to keep this short: ${left.join(', ')}. Call the skill tool with a name to load one again.`,
		)
	}
	return { text: parts.join('\n\n'), carried, cut, left }
}
