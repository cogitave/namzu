import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	loadResumableConversation,
	openSessions,
	seedConversationHistory,
	startConversation,
} from '../store.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-read-only-history-'))
	roots.push(cwd)
	return { cwd, stateRoot: join(cwd, 'state') }
}

function snapshot(root: string): Record<string, string> {
	const files: Record<string, string> = {}
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) visit(path)
			else files[relative(root, path)] = readFileSync(path).toString('base64')
		}
	}
	visit(root)
	return files
}

describe('reading a source conversation for a transient run', () => {
	it('does not initialize a missing installation', async () => {
		const { cwd, stateRoot } = fixture()
		await expect(openSessions(cwd, { stateRoot, readOnly: true })).rejects.toThrow(
			'No existing installation identity',
		)
		expect(existsSync(stateRoot)).toBe(false)
	})

	it('uses the in-memory scan index and leaves every persisted file unchanged', async () => {
		const { cwd, stateRoot } = fixture()
		const writable = await openSessions(cwd, { stateRoot, indexBackend: 'scan' })
		const id = await startConversation(writable)
		await seedConversationHistory(writable, id, [{ role: 'user', content: 'source', timestamp: 0 }])
		closeSessions(writable)
		const before = snapshot(stateRoot)
		const source = await openSessions(cwd, { stateRoot, readOnly: true })
		try {
			expect(source.index.backend).toBe('scan')
			expect((await loadResumableConversation(source, id))[0]?.content).toBe('source')
		} finally {
			closeSessions(source)
		}
		expect(snapshot(stateRoot)).toEqual(before)
	})
})
