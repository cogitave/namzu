import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { SqliteSessionStore } from '../sqlite.js'
import { sessionStoreContract } from './session-store-contract.js'
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})
sessionStoreContract('SqliteSessionStore', () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-sqlite-contract-'))
	roots.push(root)
	return new SqliteSessionStore({ databasePath: join(root, 'sessions.sqlite') })
})
