/**
 * The approvals file used to read as empty when it was damaged, and the next
 * approval then wrote a file holding only that one folder: every other
 * folder's answers were gone without a word. A damaged file now approves
 * nothing, is kept in backups/, and is never replaced.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { canonicalProjectPath } from '../../../permissions/canonical-project.js'
import { StateFileUnreadableError } from '../../state/state-file.js'
import {
	approveProjectMcpServers,
	fingerprintMcpServer,
	mcpApprovalsPath,
	mcpApprovalsProblem,
	splitProjectMcpServers,
} from '../project-approval.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function scratch() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-approvals-'))
	roots.push(root)
	const home = join(root, 'namzu-home')
	const cwd = join(root, 'work')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	return { home, cwd }
}

const servers = { tickets: { command: 'node' } }

describe('a damaged approvals file', () => {
	it.each([
		['not JSON', '{"version":1,"folders":{'],
		['folders that are not a mapping', '{"version":1,"folders":[]}'],
		['a newer version', '{"version":9,"folders":{}}'],
	])('(%s) approves nothing, is kept, and is never replaced', (_, text) => {
		const { home, cwd } = scratch()
		writeFileSync(mcpApprovalsPath(home), text)
		expect(splitProjectMcpServers(home, cwd, servers)).toEqual({
			approved: {},
			pending: ['tickets'],
		})
		expect(mcpApprovalsProblem(home)?.file).toBe(mcpApprovalsPath(home))
		expect(() => approveProjectMcpServers(home, cwd, servers)).toThrow(StateFileUnreadableError)
		expect(readFileSync(mcpApprovalsPath(home), 'utf8')).toBe(text)
		const kept = readdirSync(join(home, 'backups'))
		expect(kept).toHaveLength(1)
		expect(kept[0]).toMatch(/^mcp-approvals\.json\.corrupt-\d+$/)
	})

	it('keeps every other folder, and what it does not understand, when one folder is approved', () => {
		const { home, cwd } = scratch()
		const stored = {
			version: 1,
			folders: {
				'/elsewhere': { docs: 'print-1', odd: 7 },
				'/strange': 'not a mapping',
			},
			later: { kept: true },
		}
		writeFileSync(mcpApprovalsPath(home), JSON.stringify(stored))
		approveProjectMcpServers(home, cwd, servers)
		expect(JSON.parse(readFileSync(mcpApprovalsPath(home), 'utf8'))).toEqual({
			...stored,
			folders: {
				...stored.folders,
				[canonicalProjectPath(cwd)]: { tickets: fingerprintMcpServer(servers.tickets) },
			},
		})
		// The answers it understands still count.
		expect(splitProjectMcpServers(home, '/elsewhere', { docs: {} }).pending).toEqual(['docs'])
		expect(mcpApprovalsProblem(home)).toBeUndefined()
		// The file as it was is in backups/.
		const copies = readdirSync(join(home, 'backups'))
		expect(copies).toHaveLength(1)
		expect(JSON.parse(readFileSync(join(home, 'backups', copies[0] as string), 'utf8'))).toEqual(
			stored,
		)
	})
})
