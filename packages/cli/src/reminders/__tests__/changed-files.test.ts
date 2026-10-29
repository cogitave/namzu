import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFileReadTracker } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	CHANGED_FILES_TOTAL_MAX_CHARS,
	CHANGED_FILE_MAX_CHARS,
	changedFileReminders,
	changedSnippet,
} from '../changed-files.js'
import { reminderKindOf } from '../frame.js'

let dir: string
let clock: number

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'namzu-changed-files-'))
	clock = 1_700_000_000
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

/** Write a file with a modification time that is never shared with an earlier write. */
async function put(name: string, body: string): Promise<string> {
	const path = join(dir, name)
	await mkdir(join(dir, '.'), { recursive: true })
	await writeFile(path, body)
	clock += 10
	await utimes(path, clock, clock)
	return path
}

const numbered = (n: number, tag = 'line') =>
	Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n')

describe('the changed-on-disk reminder', () => {
	it('says nothing for a file that is as the model read it', async () => {
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'one\ntwo\n')
		tracker.recordFullRead?.(path, 'one\ntwo\n', 'call-1', 'x')
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
	})

	it('shows the changed lines with eight lines of context and their new line numbers', async () => {
		const tracker = createFileReadTracker()
		const before = numbered(40)
		const path = await put('a.txt', before)
		tracker.recordFullRead?.(path, before, 'call-1', 'x')
		await put('a.txt', before.replace('line 20', 'line twenty'))
		const [text, ...rest] = await changedFileReminders({ tracker, cwd: dir })
		expect(rest).toEqual([])
		expect(text).toContain('a.txt changed on disk since you last read it')
		expect(text).toContain('do not put the old text back')
		expect(text).toContain('20\tline twenty')
		expect(text).toContain('12\tline 12')
		expect(text).toContain('28\tline 28')
		expect(text).not.toContain('11\tline 11')
		expect(text).not.toContain('29\tline 29')
		expect(text).not.toContain('line 20\n')
		expect(text).not.toContain(dir)
	})

	it('tells a change once without treating a diff as a full read', async () => {
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'one\n')
		tracker.recordFullRead?.(path, 'one\n', 'call-1', 'x')
		await put('a.txt', 'two\n')
		expect(await changedFileReminders({ tracker, cwd: dir })).toHaveLength(1)
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
		expect(tracker.fullBody?.(path)).toBe('one\n')
		expect(tracker.driftObserved?.(path)).toBe(true)
		expect(tracker.readWitness?.(path)?.callId).toBe('call-1')
		// A second change is a second notice.
		await put('a.txt', 'three\n')
		const [again] = await changedFileReminders({ tracker, cwd: dir })
		expect(again).toContain('three')
	})

	it('frames each notice as a reminder of its own kind', async () => {
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'one\n')
		tracker.recordFullRead?.(path, 'one\n', 'call-1', 'x')
		await put('a.txt', 'two\n')
		const [text] = await changedFileReminders({ tracker, cwd: dir })
		expect(text?.startsWith('<system-reminder kind="changed-file">')).toBe(true)
		expect(
			reminderKindOf({
				role: 'user',
				content: text ?? '',
				source: { type: 'runtime-context', kind: 'reminder' },
			} as never),
		).toBe('changed-file')
	})

	it('ignores a file the model read only a window of', async () => {
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'one\ntwo\n')
		tracker.recordFullRead?.(path, 'one\ntwo\n', 'call-1', 'x')
		tracker.recordRead(path, 'one\ntwo\n')
		await put('a.txt', 'changed\n')
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
	})

	it("knows the model's own write and edit and does not report them back", async () => {
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'one\n')
		tracker.recordRead(path, 'new body\n', 'write-1')
		await put('a.txt', 'new body\n')
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
		tracker.recordEdit?.(path, 'edited\n', 'edit-1')
		await put('a.txt', 'edited\n')
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
		await put('a.txt', 'edited by hand\n')
		expect(await changedFileReminders({ tracker, cwd: dir })).toHaveLength(1)
	})

	it('does not report a file that was touched but not changed, nor one that is gone', async () => {
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'same\n')
		tracker.recordFullRead?.(path, 'same\n', 'call-1', 'x')
		await put('a.txt', 'same\n')
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
		await rm(path)
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
	})

	it('names the change but withholds the text of a secrets file', async () => {
		const tracker = createFileReadTracker()
		const path = await put('.env', 'TOKEN=old\n')
		tracker.recordFullRead?.(path, 'TOKEN=old\n', 'call-1', 'x')
		await put('.env', 'TOKEN=new-secret\n')
		const [text] = await changedFileReminders({ tracker, cwd: dir })
		expect(text).toContain('.env changed on disk')
		expect(text).toContain('read the file if you need its current content')
		expect(text).not.toContain('new-secret')
		expect(tracker.fullBody?.(path)).toBe('TOKEN=old\n')
		expect(tracker.driftObserved?.(path)).toBe(true)
	})

	it('cuts one file at the size cap on a line break and says how much was left out', async () => {
		const tracker = createFileReadTracker()
		const before = numbered(2000, 'before')
		const path = await put('big.txt', before)
		tracker.recordFullRead?.(path, before, 'call-1', 'x')
		await put('big.txt', numbered(2000, 'after'))
		const [text] = await changedFileReminders({ tracker, cwd: dir })
		expect(text).toContain('more lines not shown; read the file for the rest')
		expect(changedSnippet(before, numbered(2000, 'after')).length).toBeLessThanOrEqual(
			CHANGED_FILE_MAX_CHARS,
		)
		expect(tracker.fullBody?.(path)).toBe(before)
		expect(tracker.driftObserved?.(path)).toBe(true)
	})

	it('stops showing text once the files of one request have used the total cap', async () => {
		const tracker = createFileReadTracker()
		const names = ['a', 'b', 'c', 'd'].map((n) => `${n}.txt`)
		const before = numbered(2000, 'before')
		for (const name of names) {
			tracker.recordFullRead?.(await put(name, before), before, name, 'x')
		}
		for (const name of names) await put(name, numbered(2000, 'after'))
		const texts = await changedFileReminders({ tracker, cwd: dir })
		expect(texts.length).toBeGreaterThan(0)
		expect(texts.join('\n').length).toBeLessThanOrEqual(CHANGED_FILES_TOTAL_MAX_CHARS)
		const shown = texts.filter((t) => t.includes('The changed parts'))
		expect(shown.length).toBeLessThan(4)
		expect(shown.length).toBeGreaterThan(0)
		const snippets = shown.map(
			(text) =>
				text
					.split('The changed parts, with line numbers:\n')[1]
					?.split('\n</system-reminder>')[0] ?? '',
		)
		expect(snippets.reduce((total, text) => total + text.length, 0)).toBeLessThanOrEqual(
			CHANGED_FILES_TOTAL_MAX_CHARS,
		)
		for (const name of names) {
			expect(tracker.fullBody?.(join(dir, name))).toBe(before)
			expect(tracker.driftObserved?.(join(dir, name))).toBe(true)
		}
		const next = await changedFileReminders({ tracker, cwd: dir })
		expect(next.join('\n').length).toBeLessThanOrEqual(CHANGED_FILES_TOTAL_MAX_CHARS)
		for (const name of names) {
			expect(
				[...texts, ...next].filter((text) => text.includes(`${name} changed on disk`)),
			).toHaveLength(1)
		}
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
	})

	it('bounds names and frames even when every changed body is withheld', async () => {
		const tracker = createFileReadTracker()
		const names = Array.from({ length: 80 }, (_, i) => `${i}-${'x'.repeat(180)}.key`)
		for (const name of names) {
			tracker.recordFullRead?.(await put(name, 'before'), 'before', name, 'x')
			await put(name, 'after')
		}
		const notices: string[] = []
		// Finite request batches, not a wall-clock poll: each drains pending notices.
		for (let request = 0; request < names.length; request++) {
			const batch = await changedFileReminders({ tracker, cwd: dir })
			expect(batch.join('\n').length).toBeLessThanOrEqual(CHANGED_FILES_TOTAL_MAX_CHARS)
			if (batch.length === 0) break
			notices.push(...batch)
		}
		expect(notices).toHaveLength(names.length)
		for (const name of names) {
			expect(notices.filter((text) => text.includes(`\n${name} changed on disk`))).toHaveLength(1)
			expect(tracker.fullBody?.(join(dir, name))).toBe('before')
		}
		expect(notices.join('\n')).not.toContain('The changed parts')
	})

	it('reports growth beyond the comparison ceiling without showing file contents', async () => {
		const tracker = createFileReadTracker()
		const path = await put('growing.txt', 'before\n')
		tracker.recordFullRead?.(path, 'before\n', 'call-1', 'x')
		await put('growing.txt', 'x'.repeat(2 * 1024 * 1024 + 1))
		const [text] = await changedFileReminders({ tracker, cwd: dir })
		expect(text).toContain('growing.txt changed on disk')
		expect(text).toContain('read the file if you need its current content')
		expect(text).not.toContain('The changed parts')
		expect(tracker.fullBody?.(path)).toBe('before\n')
		expect(tracker.readWitness?.(path)?.callId).toBe('call-1')
		expect(tracker.driftObserved?.(path)).toBe(true)
		expect(await changedFileReminders({ tracker, cwd: dir })).toEqual([])
	})

	it('does nothing for a ledger that keeps no bodies', async () => {
		const tracker = {
			recordRead() {},
			hasRead: () => false,
		}
		expect(await changedFileReminders({ tracker: tracker as never, cwd: dir })).toEqual([])
	})

	it('reaches the model through the terminal reminder source', async () => {
		const { createCliReminderSource } = await import('../index.js')
		const tracker = createFileReadTracker()
		const path = await put('a.txt', 'one\n')
		tracker.recordFullRead?.(path, 'one\n', 'call-1', 'x')
		await put('a.txt', 'two\n')
		const source = createCliReminderSource({
			mode: () => 'default' as never,
			changedFiles: async () => ({ tracker, cwd: dir }),
		})
		const first = await source({ messages: [] } as never)
		expect(first?.filter((t) => t.includes('kind="changed-file"'))).toHaveLength(1)
		const second = await source({ messages: [] } as never)
		expect(second?.filter((t) => t.includes('kind="changed-file"'))).toHaveLength(0)
	})
})
