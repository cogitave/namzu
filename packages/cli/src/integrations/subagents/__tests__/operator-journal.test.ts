import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionPaths, generateSessionId } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { acknowledgeChildOperatorNotices, readChildOperatorNotices } from '../operator-journal.js'
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'namzu-child-journal-'))
	roots.push(home)
	const paths = new SessionPaths({ home, slug: 'child-journal' })
	const sessionId = generateSessionId()
	await mkdir(paths.sessionDir({ sessionId }), { recursive: true })
	return {
		paths,
		sessionId,
		path: join(paths.sessionDir({ sessionId }), 'child-operator-messages.jsonl'),
	}
}
function accepted(id: string, message = 'Changed assignment') {
	return JSON.stringify({
		id,
		source: 'operator',
		status: 'accepted',
		viewId: 'agent-1',
		taskId: 'task-1',
		message,
	})
}
it('restores accepted operator evidence without granting execution and acknowledges only the observed snapshot', async () => {
	const f = await fixture()
	await writeFile(
		f.path,
		[
			accepted('one'),
			JSON.stringify({
				id: 'refused',
				status: 'refused',
				source: 'operator',
				message: 'NOT_ACCEPTED',
			}),
			'damaged',
			'null',
			accepted('two', 'SECOND'),
		].join('\n') + '\n',
	)
	const initial = await readChildOperatorNotices(f.paths, f.sessionId)
	expect(initial.map((row) => row.id)).toEqual(['one', 'two'])
	expect(initial[0]?.text).toContain('grants no additional permissions')
	expect(initial[0]?.text).toContain('consumption is not proved')
	await appendFile(f.path, accepted('later', 'LATE') + '\n')
	await acknowledgeChildOperatorNotices(f.paths, f.sessionId, initial)
	expect((await readChildOperatorNotices(f.paths, f.sessionId)).map((row) => row.id)).toEqual([
		'later',
	])
})
it('bounds disk reads and context while ignoring partial records', async () => {
	const f = await fixture()
	await writeFile(
		f.path,
		'x'.repeat(300_000) +
			'\n' +
			Array.from({ length: 8 }, (_, index) => accepted(String(index), 'x'.repeat(16_000))).join(
				'\n',
			) +
			'\n',
	)
	const notices = await readChildOperatorNotices(f.paths, f.sessionId)
	expect(notices.map((row) => row.id)).toEqual(['7'])
	expect(notices.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(32_000)
})

it('keeps older evidence when quoting a long control-character instruction expands its preview', async () => {
	const f = await fixture()
	await writeFile(
		f.path,
		`${accepted('older')}\n${accepted('newer', `A${'\n'.repeat(15_998)}B`)}\n`,
	)
	const notices = await readChildOperatorNotices(f.paths, f.sessionId)
	expect(notices.map((row) => row.id)).toEqual(['older', 'newer'])
	expect(notices[1]?.text).toContain('truncated preview')
	expect(notices[1]?.text).toContain('full 16000-character instruction')
	expect(notices.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(32_000)
})
