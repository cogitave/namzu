import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { fingerprintContent } from '../../../tools/builtins/content-fingerprint.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import type { FileReadTracker } from '../../../types/tool/index.js'
import { describeVisibleFileEvidence } from '../file-evidence-context.js'

const cwd = resolve('workspace')
const body = 'Merhaba!\n'
const key = resolve(cwd, 'note.txt')
function history(id = 'write-1', path = 'note.txt', content = body): Message[] {
	return [
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id,
					type: 'function',
					function: {
						name: 'write',
						arguments: JSON.stringify({ path, content }),
					},
				},
			],
		},
		{ role: 'tool', toolCallId: id, content: 'Created file', isError: false },
	]
}
function fixture(content = body) {
	const tracker = createFileReadTracker()
	tracker.recordRead(key, content, 'write-1')
	return {
		tracker,
		describe: (messages: Message[]) => describeVisibleFileEvidence(messages, tracker, cwd, false),
	}
}
function editHistory(id: string, args: Record<string, unknown>, path = 'note.txt'): Message[] {
	return [
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id,
					type: 'function',
					function: {
						name: 'edit',
						arguments: JSON.stringify({ path, ...args }),
					},
				},
			],
		},
		{
			role: 'tool',
			toolCallId: id,
			content: `Edited ${path}: 1 replacement(s)`,
			isError: false,
		},
	]
}
/**
 * A witnessed write with edits stacked on it, each hop stating the body it
 * produced.
 *
 * `produced` is written out by hand rather than computed with the same apply
 * core the projection replays through, so the ledger and the replay have to
 * agree independently — a replay that quietly stopped matching the tool would
 * still match itself.
 */
interface Hop {
	id: string
	args: Record<string, unknown>
	produced: string
}
/** Record one path's write and edits into `tracker`, and return the history showing them. */
function stackOnto(
	tracker: FileReadTracker,
	hops: readonly Hop[],
	where: { path: string; writeId: string; content: string },
): Message[] {
	const stackKey = resolve(cwd, where.path)
	tracker.recordRead(stackKey, where.content, where.writeId)
	const messages = history(where.writeId, where.path, where.content)
	for (const hop of hops) {
		messages.push(...editHistory(hop.id, hop.args, where.path))
		tracker.recordEdit?.(stackKey, hop.produced, hop.id)
	}
	return messages
}
function chained(hops: readonly Hop[], content = body) {
	const tracker = createFileReadTracker()
	const messages = stackOnto(tracker, hops, { path: 'note.txt', writeId: 'write-1', content })
	return {
		tracker,
		describe: (m: Message[]) => describeVisibleFileEvidence(m, tracker, cwd, false),
		messages,
	}
}

/** The one-replacement call the fixtures below reach for when the hop itself is not the point. */
const hop = { old_string: 'Merhaba', new_string: 'Selam' }
function twoHops() {
	return chained([
		{
			id: 'e1',
			args: { old_string: 'Merhaba', new_string: 'Selam' },
			produced: 'Selam!\n',
		},
		{
			id: 'e2',
			args: { old_string: '!', new_string: '?' },
			produced: 'Selam?\n',
		},
	])
}
/** `count` appends, each one its own call, so the bound counts calls and not hunks. */
function inserts(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		id: `e${index + 1}`,
		args: { insertLine: 'end', new_string: `satir${index + 1}\n` },
		produced: body + Array.from({ length: index + 1 }, (_, line) => `satir${line + 1}\n`).join(''),
	}))
}
// One hop short of the request's replay ceiling, then one hop past it: a
// 29,001-unit base plus bodies of 58,001 and 87,001 still fits in 262,144, and
// the fourth at 116,001 does not. Every call's arguments stay under the 32,000
// the projection admits, so the ceiling is the only thing refusing the third.
const wide = (character: string) => character.repeat(29_000)
const base = `A${wide('x')}`
const growing = [
	{
		id: 'g1',
		args: { old_string: 'A', new_string: `B${wide('y')}` },
		produced: `B${wide('y')}${wide('x')}`,
	},
	{
		id: 'g2',
		args: { old_string: 'B', new_string: `C${wide('z')}` },
		produced: `C${wide('z')}${wide('y')}${wide('x')}`,
	},
	{
		id: 'g3',
		args: { old_string: 'C', new_string: `D${wide('w')}` },
		produced: `D${wide('w')}${wide('z')}${wide('y')}${wide('x')}`,
	},
]

describe('visible file evidence', () => {
	it('joins visible complete input with successful receipt and the current observation without copying content', () => {
		const f = fixture()
		const messages = history()
		const original = structuredClone(messages)
		expect(f.describe(messages)).toContain('"bodyInCall":"write-1"')
		expect(f.describe(messages)).not.toContain(body)
		expect(messages).toEqual(original)
		f.tracker.recordRead(resolve(cwd, 'note.txt'), body)
		expect(f.describe(messages)).toContain('"bodyInCall":"write-1"')
		f.tracker.recordRead(resolve(cwd, 'note.txt'), 'another version')
		expect(f.tracker.writeCallId?.(resolve(cwd, 'note.txt'))).toBeUndefined()
		expect(f.describe(messages)).toBeUndefined()
		f.tracker.recordRead(resolve(cwd, 'note.txt'), body)
		expect(f.describe(messages)).toBeUndefined()
	})
	it('invalidates the fingerprint on a later observation with no content', () => {
		const f = fixture()
		f.tracker.recordRead(resolve(cwd, 'note.txt'))
		expect(f.tracker.hasRead(resolve(cwd, 'note.txt'))).toBe(true)
		expect(f.tracker.fingerprint?.(resolve(cwd, 'note.txt'))).toBeUndefined()
		expect(f.tracker.writeCallId?.(resolve(cwd, 'note.txt'))).toBeUndefined()
		expect(f.describe(history())).toBeUndefined()
	})
	it('withholds evidence after compaction, error, ambiguous IDs or missing call/result', () => {
		const f = fixture()
		const messages = history()
		const receipt = messages[1] as ToolMessage
		for (const variant of [
			[messages[0], clearToolResult(receipt, 'write').message],
			[messages[0], { ...receipt, isError: true }],
			[...messages, ...messages],
			messages.slice(0, 1),
			messages.slice(1),
		] as Message[][])
			expect(f.describe(variant)).toBeUndefined()
		const call = messages[0]
		if (call?.role !== 'assistant' || !call.toolCalls?.[0]) throw new Error('fixture')
		call.toolCalls[0].metadata = { inputTruncated: true }
		expect(f.describe(messages)).toBeUndefined()
	})
	it('requires an execution witness, not merely a matching read; uses sandbox keys without host path resolution', () => {
		const f = fixture()
		expect(
			describeVisibleFileEvidence(history(), { recordRead() {}, hasRead: () => true }, cwd, false),
		).toBeUndefined()
		f.tracker.recordRead('note.txt', body, 'write-1')
		expect(describeVisibleFileEvidence(history(), f.tracker, cwd, true)).toContain('write-1')
		const readOnlyObservation = createFileReadTracker()
		readOnlyObservation.recordRead(resolve(cwd, 'note.txt'), body)
		expect(describeVisibleFileEvidence(history(), readOnlyObservation, cwd, false)).toBeUndefined()
		readOnlyObservation.recordRead(resolve(cwd, 'note.txt'), body, 'another-write')
		expect(describeVisibleFileEvidence(history(), readOnlyObservation, cwd, false)).toBeUndefined()
	})
	it('bounds output to six paths and excludes oversized or invalid input', () => {
		const f = fixture()
		const messages: Message[] = []
		for (let i = 0; i < 20; i++) {
			f.tracker.recordRead(resolve(cwd, `n${i}`), body, `w${i}`)
			messages.push(...history(`w${i}`, `n${i}`))
		}
		const output = f.describe(messages) as string
		expect(JSON.parse(output.split('\n').at(-1) as string)).toHaveLength(6)
		const invalid = history()
		if (invalid[0]?.role === 'assistant' && invalid[0].toolCalls?.[0])
			invalid[0].toolCalls[0].function.arguments = '{'
		expect(f.describe(invalid)).toBeUndefined()
		expect(f.describe(history('x'.repeat(257)))).toBeUndefined()
	})
})

describe('a chain of visible edits on a visible write', () => {
	it('names the write that carries the body and the edits applied on top of it', () => {
		const c = chained([
			{
				id: 'e1',
				args: { old_string: 'Merhaba', new_string: 'Selam' },
				produced: 'Selam!\n',
			},
		])
		const original = structuredClone(c.messages)
		const output = c.describe(c.messages) as string
		expect(output).toContain('"bodyInCall":"write-1"')
		expect(output).toContain('"editsInCalls":["e1"]')
		expect(output).toContain(`"observedFingerprint":"${c.tracker.fingerprint?.(key)}"`)
		expect(output).not.toContain(body)
		expect(output).not.toContain('Selam')
		expect(c.messages).toEqual(original)
		// The body is no longer the write call's body, so the older question
		// keeps its older answer.
		expect(c.tracker.writeCallId?.(key)).toBeUndefined()
	})
	it('replays a batch, an insertion and a replace_all exactly as the tool applied them', () => {
		const batch = chained([
			{
				id: 'b1',
				args: {
					edits: [
						{ old_string: 'Merhaba', new_string: 'Selam' },
						{ old_string: '!', new_string: '?' },
					],
				},
				produced: 'Selam?\n',
			},
		])
		expect(batch.describe(batch.messages)).toContain('"editsInCalls":["b1"]')
		const inserted = chained([
			{
				id: 'i1',
				args: { insertLine: 'end', new_string: 'ikinci\n' },
				produced: 'Merhaba!\nikinci\n',
			},
		])
		expect(inserted.describe(inserted.messages)).toContain('"editsInCalls":["i1"]')
		const all = chained([
			{
				id: 'a1',
				args: { old_string: 'a', new_string: 'A', replace_all: true },
				produced: 'MerhAbA!\n',
			},
		])
		expect(all.describe(all.messages)).toContain('"editsInCalls":["a1"]')
	})
	it('withholds the whole path when any hop is missing, cleared, errored or ambiguous', () => {
		const c = twoHops()
		expect(c.describe(c.messages)).toContain('"editsInCalls":["e1","e2"]')
		const middle = c.messages[3] as ToolMessage
		for (const variant of [
			[...c.messages.slice(0, 3), clearToolResult(middle, 'edit').message, ...c.messages.slice(4)],
			[...c.messages.slice(0, 3), { ...middle, isError: true }, ...c.messages.slice(4)],
			[...c.messages, ...c.messages.slice(2, 4)],
			[...c.messages, ...c.messages.slice(4, 6)],
			[...c.messages.slice(0, 2), ...c.messages.slice(4)],
			c.messages.slice(2),
		] as Message[][])
			expect(c.describe(variant)).toBeUndefined()
		const truncated = twoHops()
		const call = truncated.messages[2]
		if (call?.role !== 'assistant' || !call.toolCalls?.[0]) throw new Error('fixture')
		call.toolCalls[0].metadata = { inputTruncated: true }
		expect(truncated.describe(truncated.messages)).toBeUndefined()
	})
	it('bounds a chain to eight edit calls', () => {
		const eight = chained(inserts(8))
		expect(eight.describe(eight.messages)).toContain('"editsInCalls":["e1"')
		const nine = chained(inserts(9))
		expect(nine.describe(nine.messages)).toBeUndefined()
	})
	it('bounds the content one request may materialise while replaying', () => {
		const admitted = chained(growing.slice(0, 2), base)
		expect(admitted.describe(admitted.messages)).toContain('"editsInCalls":["g1","g2"]')
		const refused = chained(growing, base)
		expect(refused.describe(refused.messages)).toBeUndefined()
	})
	it('leaves the allowance of the path it refuses to the paths behind it', () => {
		const over = chained(growing, base)
		// Charging for a body that was never built used to drive the request's
		// allowance negative, and every admissible path after it went with it.
		const small = stackOnto(over.tracker, [{ id: 's1', args: hop, produced: 'Selam!\n' }], {
			path: 'small.txt',
			writeId: 'write-2',
			content: body,
		})
		const output = over.describe([...over.messages, ...small]) as string
		expect(output).not.toContain('"bodyInCall":"write-1"')
		expect(output).toContain('"bodyInCall":"write-2"')
		expect(output).toContain('"editsInCalls":["s1"]')
	})
	it('charges a batch for the largest body it builds, not the one it ends on', () => {
		// Each hunk works on what the one before it produced: the middle one
		// multiplies what the first wrote and the last throws all of it away,
		// so the call ends on an empty file after folding through twenty
		// million characters. Charged on the result it would cost the request
		// nothing, and cost it nothing again on every request after this one.
		const fold = (scale: number) => ({
			edits: [
				{ old_string: 'X', new_string: 'a'.repeat(scale) },
				{ old_string: 'a', new_string: 'b'.repeat(scale / 5), replace_all: true },
				{ old_string: 'b', new_string: '', replace_all: true },
			],
		})
		const refused = chained([{ id: 'f1', args: fold(10_000), produced: '' }], 'X')
		expect(refused.describe(refused.messages)).toBeUndefined()
		// The same shape at a hundredth of the scale folds through two thousand
		// characters and is admitted, so the ceiling is the only thing refusing
		// the one above — not the shape, and not the empty body it produces.
		const admitted = chained([{ id: 'f1', args: fold(100), produced: '' }], 'X')
		expect(admitted.describe(admitted.messages)).toContain('"editsInCalls":["f1"]')
	})
	it('withholds a hop whose id or arguments are past the size it admits', () => {
		const longId = chained([{ id: 'e'.repeat(257), args: hop, produced: 'Selam!\n' }])
		expect(longId.describe(longId.messages)).toBeUndefined()
		const wide = 'x'.repeat(33_000)
		const longArguments = chained([
			{ id: 'e1', args: { old_string: 'Merhaba', new_string: wide }, produced: `${wide}!\n` },
		])
		expect(longArguments.describe(longArguments.messages)).toBeUndefined()
	})
	it('withholds a replay the ledger does not agree with, and arguments it cannot validate', () => {
		const disagrees = chained([
			{
				id: 'e1',
				args: { old_string: 'Merhaba', new_string: 'Selam' },
				produced: 'Baska bir sey\n',
			},
		])
		expect(disagrees.describe(disagrees.messages)).toBeUndefined()
		const unschemad = chained([
			{
				id: 'e1',
				args: { old_string: 'Merhaba', new_string: 'Selam', mode: 'fuzzy' },
				produced: 'Selam!\n',
			},
		])
		expect(unschemad.describe(unschemad.messages)).toBeUndefined()
		const elsewhere = chained([
			{
				id: 'e1',
				args: { old_string: 'Merhaba', new_string: 'Selam' },
				produced: 'Selam!\n',
			},
		])
		const hop = elsewhere.messages[2]
		if (hop?.role !== 'assistant' || !hop.toolCalls?.[0]) throw new Error('fixture')
		hop.toolCalls[0].function.arguments = JSON.stringify({
			path: 'other.txt',
			old_string: 'Merhaba',
			new_string: 'Selam',
		})
		expect(elsewhere.describe(elsewhere.messages)).toBeUndefined()
	})
	it('clears the chain on a later observation with no content', () => {
		const c = twoHops()
		expect(c.describe(c.messages)).toContain('"editsInCalls"')
		c.tracker.recordRead(key)
		expect(c.tracker.editChain?.(key)).toBeUndefined()
		expect(c.tracker.writeCallId?.(key)).toBeUndefined()
		expect(c.describe(c.messages)).toBeUndefined()
	})
})

describe('a path a refused mutation reported stale', () => {
	it('leaves the ledger exactly as it was and only withholds the reference', () => {
		const f = fixture()
		f.tracker.recordDriftObserved?.(key)
		// Not an observation. Everything the drift check and the witness read
		// is still what it was, so the next mutation is refused on the same
		// comparison rather than admitted against a re-baselined ledger.
		expect(f.tracker.fingerprint?.(key)).toBe(fingerprintContent(body))
		expect(f.tracker.hasRead(key)).toBe(true)
		expect(f.tracker.writeCallId?.(key)).toBe('write-1')
		expect(f.tracker.driftObserved?.(key)).toBe(true)
		expect(f.describe(history())).toBeUndefined()
		// A real observation is what re-baselines the check, and clearing the
		// flag is part of that rather than a separate step.
		f.tracker.recordRead(key, body)
		expect(f.tracker.driftObserved?.(key)).toBe(false)
		expect(f.describe(history())).toContain('"bodyInCall":"write-1"')
	})
	it('withholds a chain on the same flag, which an edit or a contentless read clears', () => {
		const c = twoHops()
		c.tracker.recordDriftObserved?.(key)
		expect(c.tracker.editChain?.(key)?.editCallIds).toEqual(['e1', 'e2'])
		expect(c.describe(c.messages)).toBeUndefined()
		c.tracker.recordEdit?.(key, 'Selam?!\n', 'e3')
		expect(c.tracker.driftObserved?.(key)).toBe(false)
		const contentless = twoHops()
		contentless.tracker.recordDriftObserved?.(key)
		contentless.tracker.recordRead(key)
		expect(contentless.tracker.driftObserved?.(key)).toBe(false)
		expect(contentless.describe(contentless.messages)).toBeUndefined()
	})
	it('is an optional method, so a tracker without it keeps referencing the write', () => {
		const older: FileReadTracker = {
			recordRead() {},
			hasRead: () => true,
			fingerprint: () => fingerprintContent(body),
			writeCallId: () => 'write-1',
		}
		expect(describeVisibleFileEvidence(history(), older, cwd, false)).toContain('"write-1"')
	})
})
