import { z } from 'zod'

import type { HandBack, HandBackKind } from '../../types/session/hand-back.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

/** The name the model calls. */
export const HAND_BACK_TOOL_NAME = 'hand_back_task'

/** Each of the three sentences is cut to this many characters when it is kept. */
export const HAND_BACK_MAX_CHARS = 800

/** What the model is told when the setting is on. One place, added to the static prompt. */
export const HAND_BACK_GUIDANCE = `## Handing a task back
If the task cannot be done as specified, call \`${HAND_BACK_TOOL_NAME}\` instead of forcing a result: it ends the turn and tells a person what blocks you, what you tried and what they must decide or provide. Never weaken, skip, delete or special-case a check to make it pass; if the request and its checks cannot both hold, hand it back. Hand back only what you could not finish.`

/**
 * What the tool answers when the hand-back was accepted. A saved conversation
 * holds this receipt beside the call, so a reader can tell an accepted call
 * (the turn ended there) from one that was refused.
 */
export const HAND_BACK_RECEIPT = 'Handed back to a person.'

/** The id of the prompt contribution that carries {@link HAND_BACK_GUIDANCE}. */
export const HAND_BACK_GUIDANCE_CONTRIBUTION_ID = 'namzu.hand-back'

const text = z.string().trim().min(1)

export const HandBackInputSchema = z.object({
	kind: z
		.enum(['conflict', 'missing', 'decision'])
		.describe(
			'conflict: request and checks disagree. missing: something needed is missing or not allowed. decision: the person must decide.',
		),
	blocker: text.describe('What blocks you.'),
	tried: text.describe('What you tried.'),
	needed: text.describe('What a person has to decide or provide.'),
})

/** Control, invisible-format and bidirectional code points: none of them is text a person reads. */
const UNSHOWN: readonly (readonly [number, number])[] = [
	[0x0000, 0x001f],
	[0x007f, 0x009f],
	[0x00ad, 0x00ad],
	[0x061c, 0x061c],
	[0x180e, 0x180e],
	[0x200b, 0x200f],
	[0x2028, 0x202e],
	[0x2060, 0x206f],
	[0xfeff, 0xfeff],
	[0xfff9, 0xfffb],
]

/** Whitespace-like controls become a space; every other unshown code point is dropped. */
const cleaned = (value: string): string => {
	let out = ''
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0
		if (code === 0x09 || code === 0x0a || code === 0x0d) out += ' '
		else if (!UNSHOWN.some(([lo, hi]) => code >= lo && code <= hi)) out += ch
	}
	return out
}

const clip = (value: string): string => {
	const flat = cleaned(value).replace(/\s+/g, ' ').trim()
	return flat.length > HAND_BACK_MAX_CHARS ? `${flat.slice(0, HAND_BACK_MAX_CHARS - 1)}…` : flat
}

/**
 * The hand-back a tool call's input holds, or `undefined` when it is not one.
 * Never throws; text is stripped of control and bidirectional characters, whitespace-folded and clipped.
 */
export function parseHandBack(input: unknown): HandBack | undefined {
	let value = input
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return undefined
		}
	}
	const parsed = HandBackInputSchema.safeParse(value)
	if (!parsed.success) return undefined
	const { kind, blocker, tried, needed } = parsed.data
	return { kind, blocker: clip(blocker), tried: clip(tried), needed: clip(needed) }
}

const KIND_SENTENCE: Record<HandBackKind, string> = {
	conflict: 'the request conflicts with itself or with its checks',
	missing: 'something needed is missing or not allowed',
	decision: 'a decision is needed that belongs to a person',
}

/** The kernel's own sentence for a kind; the model's words are never part of it. */
export function handBackKindSentence(kind: HandBackKind): string {
	return KIND_SENTENCE[kind] ?? KIND_SENTENCE.decision
}

/** The closing line in the kernel's words: `The model handed the task back: <kind>.` */
export function describeHandBack(handBack: HandBack): string {
	return `The model handed the task back to a person: ${handBackKindSentence(handBack.kind)}.`
}

/**
 * The model's three sentences, labelled as the model's, one per line. The
 * labels are the kernel's; every value after a label is the model's own text.
 */
export function handBackModelLines(handBack: HandBack): readonly string[] {
	return [
		`The model says it is blocked by: ${handBack.blocker}`,
		`It tried: ${handBack.tried}`,
		`It needs a person to: ${handBack.needed}`,
	]
}

/** The one-line reason a goal or a scheduled run records. */
export function handBackReason(handBack: HandBack): string {
	return `${describeHandBack(handBack).replace(/\.$/, '')}. The model said: ${handBack.blocker}`
}

/** What a refused sibling call is told in the step that handed the task back. */
export const HAND_BACK_SIBLING_REFUSAL = `Not run: this step handed the task back to a person with ${HAND_BACK_TOOL_NAME}, and the turn ends there.`

/** The tool. Offered only when `TurnConfig.handBack` is on. */
export function buildHandBackTool(): ToolDefinition {
	return defineTool({
		name: HAND_BACK_TOOL_NAME,
		description:
			'Hand the task back to a person when it cannot be done as specified. Ends the turn: nothing else runs after it.',
		inputSchema: HandBackInputSchema,
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: false,
		async execute(input) {
			const handBack = parseHandBack(input)
			if (!handBack)
				throw new TypeError(
					'The hand-back needs a kind, a blocker, what was tried and what is needed.',
				)
			return {
				success: true,
				output: `${HAND_BACK_RECEIPT} The turn ends now; nothing more will run and no further answer is needed.`,
				data: handBack,
			}
		},
	})
}
