import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { repairToolMessageHistory } from '../../../compaction/dangling.js'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { fingerprintContent } from '../../../tools/builtins/content-fingerprint.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { renderNumberedRead } from '../../../tools/builtins/read-render.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { describeVisibleFileEvidence } from '../file-evidence-context.js'
import {
	MAX_REPLAYED_UNITS,
	lexicalFileKeys,
	replayObservationLedger,
} from '../file-evidence-replay.js'
import { seedObservationLedger } from '../file-evidence-seed.js'
import { drainQuery } from '../index.js'
import { skippedToolResultText } from '../plugin-hooks.js'

/**
 * The ledger is process state, and a resumed conversation used to get an empty
 * one: the model re-read files it had written in full before the session
 * closed. These cover what a replay may and may not conclude from history
 * alone — and especially the three places it has to conclude nothing, because
 * the cost of a wrong conclusion is the runtime telling the model a file holds
 * a body it does not.
 */

const cwd = resolve('workspace')
let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

const body = 'alpha\nbeta\n'
const key = resolve(cwd, 'note.txt')

function call(id: string, name: string, args: Record<string, unknown>): Message {
	return {
		role: 'assistant',
		content: null,
		toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
	}
}
function receipt(id: string, content = 'ok', isError = false): ToolMessage {
	return { role: 'tool', toolCallId: id, content, isError }
}
function wrote(id = 'w1', content = body, path = 'note.txt'): Message[] {
	return [call(id, 'write', { path, content }), receipt(id, `Created ${path}`)]
}
function edited(id: string, args: Record<string, unknown>, path = 'note.txt'): Message[] {
	return [call(id, 'edit', { path, ...args }), receipt(id, `Edited ${path}: 1 replacement(s)`)]
}
/** A `read` receipt carrying exactly what the tool would have rendered for `content`. */
function readOf(
	id: string,
	content: string,
	window: Record<string, unknown> = {},
	path = 'note.txt',
): Message[] {
	return [
		call(id, 'read', { path, ...window }),
		receipt(id, renderNumberedRead(content, window).output),
	]
}

function rebuild(messages: Message[]) {
	const tracker = createFileReadTracker()
	// The lexical keys the PROJECTION reads under, so these cases are about
	// what a walk concludes rather than about where it writes. Where the seed
	// writes is its own question, and has its own describe block below.
	const report = replayObservationLedger(messages, tracker, lexicalFileKeys(cwd, false))
	return {
		tracker,
		report,
		evidence: () => describeVisibleFileEvidence(messages, tracker, cwd, false),
	}
}

describe('a ledger rebuilt from a conversation it did not run', () => {
	it('restores a full write as its own witness, so the next turn need not re-read it', () => {
		const rebuilt = rebuild(wrote())
		expect(rebuilt.tracker.hasRead(key)).toBe(true)
		expect(rebuilt.tracker.fingerprint?.(key)).toBe(fingerprintContent(body))
		expect(rebuilt.tracker.writeCallId?.(key)).toBe('w1')
		expect(rebuilt.evidence()).toContain('"bodyInCall":"w1"')
		expect(rebuilt.report.pathsWitnessed).toBe(1)
	})

	it('restores the whole chain of edits stacked on that write', () => {
		const rebuilt = rebuild([
			...wrote(),
			...edited('e1', { old_string: 'alpha', new_string: 'gamma' }),
			...edited('e2', { insertLine: 'end', new_string: 'omega' }),
		])
		expect(rebuilt.tracker.editChain?.(key)).toEqual({
			rootWriteCallId: 'w1',
			editCallIds: ['e1', 'e2'],
		})
		// The body the ledger now fingerprints is the one those calls produce,
		// which is what makes the projection admit the path.
		expect(rebuilt.tracker.fingerprint?.(key)).toBe(fingerprintContent('gamma\nbeta\nomega\n'))
		expect(rebuilt.evidence()).toContain('"editsInCalls":["e1","e2"]')
	})

	it('concludes nothing from a write whose outcome the transcript never recorded', () => {
		// The process died between the call and its result. Whether the file was
		// written is exactly what nobody knows, so the path stays unknown and
		// the next overwrite is refused until something reads it.
		const rebuilt = rebuild([call('w1', 'write', { path: 'note.txt', content: body })])
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.tracker.fingerprint?.(key)).toBeUndefined()
		expect(rebuilt.evidence()).toBeUndefined()
	})

	it('concludes nothing from a write the transcript refused', () => {
		const rebuilt = rebuild([
			call('w1', 'write', { path: 'note.txt', content: body }),
			receipt('w1', 'note.txt changed on disk after you read it', true),
		])
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.evidence()).toBeUndefined()
	})

	it('withdraws a body when a later mutation of that path was never answered', () => {
		// The conversation wrote the file again and the transcript stops there:
		// the process died between the call and its result. Keeping the earlier
		// witness would have the first resumed request tell the model this file
		// holds a body the conversation itself may have overwritten — a claim
		// the transcript says outright that nobody can vouch for. So the path is
		// withdrawn, which is also what the tools' own refusals then enforce.
		const rebuilt = rebuild([
			...wrote(),
			call('w2', 'write', { path: 'note.txt', content: 'a body nobody can vouch for\n' }),
		])
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.tracker.fingerprint?.(key)).toBeUndefined()
		expect(rebuilt.tracker.writeCallId?.(key)).toBeUndefined()
		expect(rebuilt.evidence()).toBeUndefined()
		expect(rebuilt.report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 1 })
	})

	it('withdraws it just the same through the unknown-outcome result repair writes', () => {
		// A resumed run is seeded from the REPAIRED history, where that same
		// unanswered call wears the synthetic error result the kernel inserts for
		// it. The repair's own words are `Its outcome is unknown`, so a walk that
		// read it as "changed nothing" would be reading the opposite of what the
		// message says. Built through the real repair rather than a copy of it.
		const { messages } = repairToolMessageHistory([
			...wrote(),
			call('w2', 'write', { path: 'note.txt', content: 'a body nobody can vouch for\n' }),
		])
		expect(messages.at(-1)).toMatchObject({ toolCallId: 'w2', isError: true })
		const rebuilt = rebuild(messages)
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.evidence()).toBeUndefined()
	})

	it('withdraws a body the transcript itself shows a mutation refused for drift', () => {
		// The refusal is not silence: a tool read the disk and reported that this
		// file is no longer what the ledger holds it to be. Mid-session that
		// withdrew the path from the projection, and a resume that restored the
		// refused fingerprint would undo a safety observation the transcript is
		// still carrying in plain words. The other path is untouched — a refusal
		// is a statement about one file.
		const rebuilt = rebuild([
			...wrote('w1', body, 'note.txt'),
			...wrote('w2', 'other\n', 'other.txt'),
			call('e1', 'edit', { path: 'note.txt', old_string: 'alpha', new_string: 'gamma' }),
			receipt('e1', 'note.txt changed on disk since this conversation last observed it', true),
		])
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.evidence()).not.toContain('"bodyInCall":"w1"')
		expect(rebuilt.tracker.writeCallId?.(resolve(cwd, 'other.txt'))).toBe('w2')
		expect(rebuilt.report).toMatchObject({ pathsWitnessed: 1, pathsSeen: 1 })
	})

	it('enters nothing at all when compaction cleared the write receipt', () => {
		const messages = wrote()
		messages[1] = clearToolResult(messages[1] as ToolMessage, 'write').message
		const rebuilt = rebuild(messages)
		// The write happened and what it produced is no longer visible, so there
		// is no body to claim — and membership without one is not the harmless
		// half of an observation. `hasRead` IS the read-before-overwrite
		// refusal, so entering the path alone would admit a full overwrite of a
		// file that may have moved while the session was closed, with nothing to
		// compare it against. The pass counts the path and writes none of it.
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.tracker.fingerprint?.(key)).toBeUndefined()
		expect(rebuilt.tracker.writeCallId?.(key)).toBeUndefined()
		expect(rebuilt.evidence()).toBeUndefined()
		expect(rebuilt.report.pathsWitnessed).toBe(0)
		expect(rebuilt.report.pathsSeen).toBe(1)
	})

	it('withdraws a body an edit in history landed on top of but can no longer reach', () => {
		const messages = [...wrote(), ...edited('e1', { old_string: 'alpha', new_string: 'gamma' })]
		messages[3] = clearToolResult(messages[3] as ToolMessage, 'edit').message
		const rebuilt = rebuild(messages)
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.tracker.fingerprint?.(key)).toBeUndefined()
		expect(rebuilt.evidence()).toBeUndefined()
	})

	it('keeps a witness through a read that shows exactly the body it holds', () => {
		const rebuilt = rebuild([...wrote(), ...readOf('r1', body)])
		expect(rebuilt.tracker.writeCallId?.(key)).toBe('w1')
		expect(rebuilt.tracker.fingerprint?.(key)).toBe(fingerprintContent(body))
		expect(rebuilt.evidence()).toContain('"bodyInCall":"w1"')
	})

	it('charges a read for exactly the rendering it is about to build', () => {
		// The pass may never materialise more than it was allowed to. Charging
		// the RECEIPT's length was charging one number and building another, so
		// the ceiling stood over what had been built rather than over what was
		// about to be. The figure comes out of the body and the window instead —
		// the line numbers' own digits included, which is why this body runs long
		// enough to cross four widths of them.
		const long = `${Array.from({ length: 1234 }, (_, i) => `line ${i}`).join('\n')}\n`
		const rebuilt = rebuild([...wrote('w1', long), ...readOf('r1', long)])
		expect(rebuilt.tracker.fingerprint?.(key)).toBe(fingerprintContent(long))
		expect(rebuilt.report.unitsReplayed).toBe(
			long.length + renderNumberedRead(long, {}).output.length,
		)

		// A windowed read can never equal a whole body's rendering, so nothing
		// is built for it and nothing is charged beyond the write itself.
		const windowed = rebuild([...wrote('w1', long), ...readOf('r1', long, { offset: 0, limit: 5 })])
		expect(windowed.report.unitsReplayed).toBe(long.length)
	})

	it('withdraws the body when the read shows a window, or shows something else', () => {
		// A window proves the lines it shows and says nothing about the rest, and
		// the body behind the numbering is never recovered by stripping it off.
		const windowed = rebuild([...wrote(), ...readOf('r1', body, { offset: 0, limit: 1 })])
		expect(windowed.tracker.hasRead(key)).toBe(false)
		expect(windowed.tracker.fingerprint?.(key)).toBeUndefined()
		expect(windowed.evidence()).toBeUndefined()

		// The file moved under the conversation while it was open. The read saw
		// that; the replay cannot say what it saw, only that it was not this.
		const moved = rebuild([...wrote(), ...readOf('r1', 'something else\n')])
		expect(moved.tracker.hasRead(key)).toBe(false)
		expect(moved.tracker.fingerprint?.(key)).toBeUndefined()
		expect(moved.evidence()).toBeUndefined()
	})

	it('concludes nothing at all when one READ call id carries two receipts', () => {
		// A read is not a lesser observation for changing nothing. The receipt
		// that was hidden could be the one showing this file to hold something
		// other than the body in hand, so skipping the read past would keep a
		// claim that very observation withdrew — the same ambiguity a mutation
		// abandons the pass for, and it gets the same answer.
		const rebuilt = rebuild([...wrote(), ...readOf('r1', body), receipt('r1', 'or was it this')])
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 0 })
	})

	it('establishes nothing from a read of a file this conversation never wrote', () => {
		// A read on its own cannot produce a fingerprint — there is no body in
		// hand to render and compare — and asserting the path had been read
		// would lift the read-before-overwrite refusal on the strength of a
		// window that may have shown two thousand lines of fifty thousand.
		const rebuilt = rebuild(readOf('r1', body))
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 0 })
	})

	it('replays only the messages it is handed, so a fork never sees its parent', () => {
		const parent = [...wrote('w1', 'parent body\n')]
		const forked = [...wrote('w2', 'forked body\n')]
		const child = rebuild(forked)
		expect(child.tracker.writeCallId?.(key)).toBe('w2')
		expect(child.tracker.fingerprint?.(key)).toBe(fingerprintContent('forked body\n'))
		expect(child.evidence()).not.toContain('"bodyInCall":"w1"')
		expect(parent).toHaveLength(2)
	})

	it('holds bodies for the paths the projection would emit, and no more', () => {
		const messages: Message[] = []
		for (let i = 0; i < 9; i++) {
			const write = wrote(`w${i}`, `body ${i}\n`, `f${i}.txt`)
			// One path in the middle is known but unreadable. It must not take an
			// eviction that belongs to a path still holding a body, or the pass
			// would carry more bodies than the projection can ever emit.
			if (i === 4) write[1] = clearToolResult(write[1] as ToolMessage, 'write').message
			messages.push(...write)
		}
		const rebuilt = rebuild(messages)
		expect(rebuilt.report.pathsWitnessed).toBe(6)
		expect(rebuilt.report.pathsSeen).toBe(3)
		expect(rebuilt.tracker.writeCallId?.(resolve(cwd, 'f1.txt'))).toBeUndefined()
		expect(rebuilt.tracker.hasRead(resolve(cwd, 'f1.txt'))).toBe(false)
		expect(rebuilt.tracker.writeCallId?.(resolve(cwd, 'f4.txt'))).toBeUndefined()
		expect(rebuilt.tracker.writeCallId?.(resolve(cwd, 'f8.txt'))).toBe('w8')
	})

	it('stops counting a path against the eviction bound once a read withdraws it', () => {
		// Six writes is exactly what the pass may hold, and the read in the
		// middle shows f2.txt holding something other than what the walk built
		// for it — so that path is withdrawn, and a withdrawn path is not one
		// this pass is still carrying a body for. Leaving it on the held list
		// anyway had the seventh write evict f0.txt, whose body was perfectly
		// good, and the ledger came out a witness short of what the projection
		// can emit.
		const messages: Message[] = []
		for (let i = 0; i < 6; i++) messages.push(...wrote(`w${i}`, `body ${i}\n`, `f${i}.txt`))
		messages.push(...readOf('r2', 'someone else rewrote this\n', {}, 'f2.txt'))
		messages.push(...wrote('w6', 'body 6\n', 'f6.txt'))

		const rebuilt = rebuild(messages)
		expect(rebuilt.report).toMatchObject({ pathsWitnessed: 6, pathsSeen: 1 })
		// The oldest path still holding a body keeps it; the read's own path is
		// the only one the pass gives up.
		expect(rebuilt.tracker.writeCallId?.(resolve(cwd, 'f0.txt'))).toBe('w0')
		expect(rebuilt.tracker.writeCallId?.(resolve(cwd, 'f6.txt'))).toBe('w6')
		expect(rebuilt.tracker.hasRead(resolve(cwd, 'f2.txt'))).toBe(false)
	})

	it('treats a write a plugin hook skipped as a mutation it cannot replay', () => {
		// A `pre_tool_use` hook that SKIPs is the one refusal that does not
		// arrive as an error: the hook declined the call, nothing failed, so the
		// receipt is an ordinary success. Read as a write it would fingerprint a
		// body that never reached the disk, and the next edit would be refused
		// for a drift this ledger had invented. The call did not run, so the
		// file holds what it held before — which this pass cannot say either.
		const rebuilt = rebuild([
			...wrote('w1', body),
			call('w2', 'write', { path: 'note.txt', content: 'never reached the disk\n' }),
			receipt('w2', skippedToolResultText('write', 'this session is read-only')),
		])
		expect(rebuilt.tracker.hasRead(key)).toBe(false)
		expect(rebuilt.tracker.fingerprint?.(key)).toBeUndefined()
		expect(rebuilt.evidence()).toBeUndefined()
		expect(rebuilt.report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 1 })
	})

	it('leaves a body standing across a read that came back refused, or not at all', () => {
		// A read changes no file, and one that saw no body can neither confirm
		// what this pass holds nor contradict it. Withdrawal is for the read
		// that DID come back and showed something else — the case above.
		const refused = rebuild([
			...wrote(),
			call('r1', 'read', { path: 'note.txt' }),
			receipt('r1', 'note.txt: permission denied', true),
		])
		expect(refused.tracker.writeCallId?.(key)).toBe('w1')
		expect(refused.tracker.fingerprint?.(key)).toBe(fingerprintContent(body))

		const unanswered = rebuild([...wrote(), call('r1', 'read', { path: 'note.txt' })])
		expect(unanswered.tracker.writeCallId?.(key)).toBe('w1')
	})

	it('reads the path off an oversize write, and off nothing larger than that', () => {
		// Two bounds, and the distance between them is what one of them is for.
		// Past the EVIDENCE bound a write is no longer quoted back, but its path
		// is still read: it withdraws its own body and every other witness in
		// the conversation stands. Past the far larger bound on reading the
		// arguments as JSON at all there is no path either, and a mutation this
		// cannot place is one it cannot act on — so the pass establishes nothing
		// rather than carry a body that write may have replaced.
		const attributable = rebuild([
			...wrote('w1', `oversize\n${'x'.repeat(100_000)}\n`, 'big.txt'),
			...wrote('w2', body),
		])
		expect(attributable.report).toMatchObject({ pathsWitnessed: 1, pathsSeen: 1 })
		expect(attributable.tracker.writeCallId?.(key)).toBe('w2')
		expect(attributable.tracker.hasRead(resolve(cwd, 'big.txt'))).toBe(false)

		const unreadable = rebuild([
			...wrote('w1', 'x'.repeat(1024 * 1024 + 1), 'big.txt'),
			...wrote('w2', body),
		])
		expect(unreadable.report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 0 })
		expect(unreadable.tracker.hasRead(key)).toBe(false)
	})

	it('stays inside its replay ceiling over a history far larger than the caps', () => {
		// Sixty writes of thirty thousand units each, every one of them with a
		// chain of edits on top: two million units of content if the walk paid
		// for all of it. The ceiling is on the pass, not on the path, so the
		// work is bounded by the bound rather than by the transcript.
		const messages: Message[] = []
		for (let file = 0; file < 60; file++) {
			const large = `head\n${'x'.repeat(30_000)}\n`
			messages.push(...wrote(`w${file}`, large, `f${file}.txt`))
			for (let hop = 0; hop < 6; hop++) {
				messages.push(
					...edited(
						`e${file}-${hop}`,
						{ insertLine: 'end', new_string: `tail ${hop}` },
						`f${file}.txt`,
					),
				)
			}
		}
		const rebuilt = rebuild(messages)
		expect(rebuilt.report.unitsReplayed).toBeLessThanOrEqual(MAX_REPLAYED_UNITS)
		// And it really did do some work, so the bound is what stopped it.
		expect(rebuilt.report.unitsReplayed).toBeGreaterThan(0)
	})

	it('lands on the same ledger however often the same history is replayed', () => {
		// Every path a pass reconstructs starts from a full write, and a full
		// write resets the path — so a second application of the same history
		// cannot stack a chain on top of itself. The callers still seed exactly
		// once, for a different reason: a ledger that has since observed real
		// files would have those observations overwritten by older history.
		const messages = [...wrote(), ...edited('e1', { old_string: 'alpha', new_string: 'gamma' })]
		const tracker = createFileReadTracker()
		const keys = lexicalFileKeys(cwd, false)
		replayObservationLedger(messages, tracker, keys)
		const once = { chain: tracker.editChain?.(key), fingerprint: tracker.fingerprint?.(key) }
		replayObservationLedger(messages, tracker, keys)
		expect({ chain: tracker.editChain?.(key), fingerprint: tracker.fingerprint?.(key) }).toEqual(
			once,
		)
		expect(once.chain).toEqual({ rootWriteCallId: 'w1', editCallIds: ['e1'] })
	})

	it('matches the receipt a real read actually leaves in the transcript', async () => {
		// The forward-render comparison is only worth anything if the rendering
		// it produces is the one the tool produced, byte for byte, AFTER the
		// executor has turned the result into a message. A copy of the numbering
		// that was right when it was written and drifted afterwards would fail
		// open — the witness would quietly stop surviving an identical read —
		// so this runs the real tools and replays their real transcript.
		const workdir = await realpath(await mkdtemp(join(tmpdir(), 'namzu-ledger-replay-')))
		workdirs.push(workdir)
		const file = join(workdir, 'doc.md')
		const tools = new ToolRegistry()
		for (const tool of [WriteFileTool, ReadFileTool, EditTool]) tools.register(tool)
		const run = await drainQuery({
			tools,
			messages: [{ role: 'user', content: 'write doc.md, then read it back' }],
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'w', name: 'write', args: { path: file, content: body } }] },
					{ toolCalls: [{ id: 'r', name: 'read', args: { path: file } }] },
					{ text: 'done' },
				],
			}),
			agentId: 'ledger',
			agentName: 'ledger',
			workingDirectory: workdir,
			runConfig: { model: 'mock', maxIterations: 5, timeoutMs: 10_000, tokenBudget: 100_000 },
			sessionId: fixtureId.session('ledger-replay'),
			topicId: fixtureId.topic('ledger-replay'),
			projectId: fixtureId.project('ledger-replay'),
			tenantId: fixtureId.tenant('ledger-replay'),
		})

		const tracker = createFileReadTracker()
		await seedObservationLedger(run.messages, tracker, { workingDirectory: workdir })
		expect(tracker.fingerprint?.(file)).toBe(fingerprintContent(body))
		expect(tracker.writeCallId?.(file)).toBe('w')
		expect(describeVisibleFileEvidence(run.messages, tracker, workdir, false)).toContain(
			'"bodyInCall":"w"',
		)
	})
})

/**
 * Where a rebuilt entry is FILED, which is a different question from what it
 * says. A ledger entry identifies a file, and the built-in tools identify one
 * by canonicalizing the path through every symlink before they touch the
 * ledger — so a seed that filed its entries lexically would write into a key
 * space nothing else reads. The projection, which also looks up lexically,
 * would then match a fingerprint the seed had just handed it, while the drift
 * refusal that is meant to withdraw the claim landed on the canonical key and
 * never reached it: a claim the runtime could not take back for the life of
 * the run. So the seed resolves paths the way the tools do.
 */
describe('a rebuilt ledger is filed where the tools will look for it', () => {
	async function linkedWorkspace(): Promise<{ root: string; real: string }> {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-ledger-keys-')))
		workdirs.push(root)
		await mkdir(join(root, 'real'))
		await symlink(join(root, 'real'), join(root, 'link'), 'dir')
		return { root, real: join(root, 'real') }
	}

	function context(workingDirectory: string, tracker: ReturnType<typeof createFileReadTracker>) {
		return {
			runId: fixtureId.run('ledger-keys'),
			workingDirectory,
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			fileReadTracker: tracker,
			toolUseId: 'e-live',
		} as unknown as ToolContext
	}

	it('keys a path through its symlinks, the way write and edit key it', async () => {
		const { root, real } = await linkedWorkspace()
		const tracker = createFileReadTracker()
		await seedObservationLedger(wrote('w1', body, 'link/note.txt'), tracker, {
			workingDirectory: root,
		})
		expect(tracker.fingerprint?.(join(real, 'note.txt'))).toBe(fingerprintContent(body))
		// And nothing at the spelling the call used, which names the link rather
		// than the file.
		expect(tracker.hasRead(join(root, 'link', 'note.txt'))).toBe(false)
	})

	it('still hands a drift refusal the entry it has to withdraw', async () => {
		const { root, real } = await linkedWorkspace()
		const messages = wrote('w1', body, 'link/note.txt')
		const tracker = createFileReadTracker()
		await seedObservationLedger(messages, tracker, { workingDirectory: root })

		// The session was closed and someone else edited the file.
		await writeFile(join(real, 'note.txt'), 'alpha\nbeta\nsomeone else\n', 'utf-8')
		const refusal = await EditTool.execute(
			{ path: 'link/note.txt', old_string: 'alpha', new_string: 'gamma' },
			context(root, tracker),
		)
		expect(refusal.success).toBe(false)
		expect(refusal.error).toContain('changed on disk')
		expect(tracker.driftObserved?.(join(real, 'note.txt'))).toBe(true)
	})

	it('resolves nothing for a history that never mutated a file', async () => {
		const { root } = await linkedWorkspace()
		const tracker = createFileReadTracker()
		const report = await seedObservationLedger(readOf('r1', body, {}, 'link/note.txt'), tracker, {
			workingDirectory: root,
		})
		expect(report).toEqual({ pathsWitnessed: 0, pathsSeen: 0, unitsReplayed: 0 })
	})

	it('concludes nothing at all when one MUTATION call id carries two receipts', async () => {
		// Which of the two this write got is exactly what nobody knows, and it
		// could be the one that replaced a body claimed for another path in the
		// same walk. The pass abandons everything rather than carry one.
		const { root } = await linkedWorkspace()
		const tracker = createFileReadTracker()
		const messages = [
			...wrote('w1', 'first\n', 'real/a.txt'),
			...wrote('w2', 'second\n', 'real/b.txt'),
			receipt('w2', 'Created real/b.txt'),
		]
		const report = await seedObservationLedger(messages, tracker, { workingDirectory: root })
		// The walk had already paid for the first body when it hit the ambiguity;
		// what it establishes is nothing, which is the part that matters.
		expect(report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 0 })
		expect(tracker.hasRead(join(root, 'real', 'a.txt'))).toBe(false)
	})

	it('keeps every other witness when one mutation is too large to quote back', async () => {
		// The argument bound is on what may be BELIEVED. A write past it still
		// names the file it changed, and the pass used not to resolve that path
		// at all — so the walk reached the call holding no key for it, read that
		// as a mutation it could not attribute, and abandoned everything. One
		// thirty-kilobyte write anywhere in a conversation erased every witness
		// in it, which is the whole ledger for the shape this exists for.
		const { root, real } = await linkedWorkspace()
		const tracker = createFileReadTracker()
		const report = await seedObservationLedger(
			[
				...wrote('w1', `oversize\n${'x'.repeat(40_000)}\n`, 'real/big.txt'),
				...wrote('w2', body, 'real/small.txt'),
			],
			tracker,
			{ workingDirectory: root },
		)
		expect(report).toMatchObject({ pathsWitnessed: 1, pathsSeen: 1 })
		expect(tracker.fingerprint?.(join(real, 'small.txt'))).toBe(fingerprintContent(body))
		expect(tracker.writeCallId?.(join(real, 'small.txt'))).toBe('w2')
		// And the oversize one is absent rather than half-known: something was
		// written there and this pass cannot say what.
		expect(tracker.hasRead(join(real, 'big.txt'))).toBe(false)
	})

	it('concludes nothing at all from a mutation no path can be recovered from', async () => {
		// The provider stream cut off mid-JSON, so `function.arguments` is the
		// `{}` the runtime normalizes it to and the raw buffer sits in
		// `metadata.partialArguments` — which is what the model was SAYING, not
		// what ran: a `repairToolCall` hook may have rewritten the arguments
		// before execution, and here the path was cut in half anyway. Something
		// was written and nobody can say where, so the body claimed above it
		// could be the body that write replaced.
		const { root, real } = await linkedWorkspace()
		const tracker = createFileReadTracker()
		const messages: Message[] = [
			...wrote('w1', body, 'real/a.txt'),
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'w2',
						type: 'function',
						function: { name: 'write', arguments: '{}' },
						metadata: { inputTruncated: true, partialArguments: '{"path":"real/b.tx' },
					},
				],
			},
			receipt('w2', 'Created real/b.txt'),
		]
		const report = await seedObservationLedger(messages, tracker, { workingDirectory: root })
		expect(report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 0 })
		expect(tracker.hasRead(join(real, 'a.txt'))).toBe(false)
	})

	it('leaves a path it could not rebuild unread, so an overwrite is still refused', async () => {
		// The one claim a seed must never make. `hasRead` without a fingerprint
		// is not half an observation: it IS the read-before-overwrite refusal,
		// and the drift check it guards needs a body to compare. Granting it for
		// a path whose body could not be rebuilt would let a full overwrite of a
		// file that changed while the session was closed go through with nothing
		// checked at all — weaker than the empty ledger a resume starts from.
		const { root, real } = await linkedWorkspace()
		const file = join(real, 'note.txt')
		await writeFile(file, 'someone else rewrote this\n', 'utf-8')
		const messages = wrote('w1', body, 'real/note.txt')
		messages[1] = clearToolResult(messages[1] as ToolMessage, 'write').message
		const tracker = createFileReadTracker()
		const report = await seedObservationLedger(messages, tracker, { workingDirectory: root })
		expect(report).toMatchObject({ pathsWitnessed: 0, pathsSeen: 1 })
		expect(tracker.hasRead(file)).toBe(false)

		const refused = await WriteFileTool.execute(
			{ path: 'real/note.txt', content: 'a whole new body\n' },
			context(root, tracker),
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('already exists')
		expect(await readFile(file, 'utf-8')).toBe('someone else rewrote this\n')

		// A real read is what lifts it, exactly as it would mid-session.
		await ReadFileTool.execute({ path: 'real/note.txt' }, context(root, tracker))
		const written = await WriteFileTool.execute(
			{ path: 'real/note.txt', content: 'a whole new body\n' },
			context(root, tracker),
		)
		expect(written.success).toBe(true)
	})
})
