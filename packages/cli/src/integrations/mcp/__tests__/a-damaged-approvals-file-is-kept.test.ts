/**
 * The approvals file used to read as empty when it was damaged, and the next
 * approval then wrote a file holding only that one folder: every other
 * folder's answers were gone without a word. A damaged file now approves
 * nothing, is kept in backups/, and is never replaced.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { canonicalProjectPath } from '../../../permissions/canonical-project.js'
import { StateFileUnreadableError } from '../../state/state-file.js'
import {
	NEW_APPROVALS_LIST_REMEDY,
	approveProjectMcpServers,
	fingerprintMcpServer,
	mcpApprovalsPath,
	mcpApprovalsProblem,
	splitProjectMcpServers,
	startNewMcpApprovals,
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
		expect(kept[0]).toMatch(/^mcp-approvals\.json\.corrupted\.\d+$/)
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

	it('says how to start a new list, and starts one only when asked, keeping the old file', () => {
		const { home, cwd } = scratch()
		writeFileSync(mcpApprovalsPath(home), '{ damaged')
		expect(() => approveProjectMcpServers(home, cwd, servers)).toThrow(NEW_APPROVALS_LIST_REMEDY)
		const kept = startNewMcpApprovals(home)
		expect(readFileSync(kept as string, 'utf8')).toBe('{ damaged')
		expect(mcpApprovalsProblem(home)).toBeUndefined()
		expect(approveProjectMcpServers(home, cwd, servers)).toEqual(['tickets'])
		// A list that reads is never replaced by the same call.
		expect(startNewMcpApprovals(home)).toBeUndefined()
		expect(splitProjectMcpServers(home, cwd, servers).pending).toEqual([])
	})

	it('reads an empty or blank file as no file: there is nothing in it to keep', () => {
		const { home, cwd } = scratch()
		writeFileSync(mcpApprovalsPath(home), '  \n')
		expect(mcpApprovalsProblem(home)).toBeUndefined()
		expect(approveProjectMcpServers(home, cwd, servers)).toEqual(['tickets'])
		// Nothing kept: a blank file is neither damaged nor worth a recovery copy.
		expect(existsSync(join(home, 'backups'))).toBe(false)
	})
})
