import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiskSessionLog } from '../../store/session-log/index.js'
import type { HarnessBinding, HarnessScope } from '../../types/harness/session.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../utils/id.js'
import { HarnessJournal } from './journal.js'

const paths: string[] = []
const journals: HarnessJournal[] = []
afterEach(async () => {
	for (const journal of journals.splice(0)) await journal.release()
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-harness-journal-'))
	paths.push(root)
	const scope: HarnessScope = {
		sessionId: generateSessionId(),
		projectId: generateProjectId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		cwd: root,
	}
	const log = new DiskSessionLog({
		sessionId: scope.sessionId,
		file: join(root, 'session.jsonl'),
		sessionDir: join(root, 'lease'),
	})
	const binding: HarnessBinding = {
		v: 1,
		engineId: 'external',
		profileRef: 'owned-profile',
		nativeSessionId: 'opaque-native-thread',
		cwd: root,
		initialModel: 'native-model',
	}
	const journal = new HarnessJournal(log, scope, binding.engineId, binding.profileRef)
	journals.push(journal)
	return { root, scope, log, binding, journal }
}
describe('harness journal disk ownership', () => {
	it('reopens exact immutable native binding with a real disk writer, and refuses profile/cwd replacement without file changes', async () => {
		const f = await fixture()
		await f.journal.claim()
		await f.journal.start(f.binding)
		await f.journal.release()
		const before = await readFile(join(f.root, 'session.jsonl'))
		const reopened = new HarnessJournal(
			new DiskSessionLog({
				sessionId: f.scope.sessionId,
				file: join(f.root, 'session.jsonl'),
				sessionDir: join(f.root, 'lease'),
			}),
			f.scope,
			'external',
			'owned-profile',
		)
		journals.push(reopened)
		expect((await reopened.inspect()).binding).toEqual(f.binding)
		await reopened.claim()
		await expect(
			reopened.start({ ...f.binding, nativeSessionId: 'other-native-thread' }),
		).rejects.toThrow('binding changed')
		const wrong = new HarnessJournal(
			f.log,
			{ ...f.scope, cwd: '/foreign' },
			'external',
			'owned-profile',
		)
		journals.push(wrong)
		await expect(wrong.claim()).rejects.toThrow('immutable harness')
		expect(await readFile(join(f.root, 'session.jsonl'))).toEqual(before)
	})
	it('rejects foreign tenant before history or claiming a writer', async () => {
		const f = await fixture()
		await f.journal.claim()
		await f.journal.start(f.binding)
		await f.journal.release()
		const wrong = new HarnessJournal(
			new DiskSessionLog({
				sessionId: f.scope.sessionId,
				file: join(f.root, 'session.jsonl'),
				sessionDir: join(f.root, 'lease'),
			}),
			{ ...f.scope, tenantId: generateTenantId() },
			'external',
			'owned-profile',
		)
		journals.push(wrong)
		await expect(wrong.claim()).rejects.toThrow('tenantId scope')
	})
})
