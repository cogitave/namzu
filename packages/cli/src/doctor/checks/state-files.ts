import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
	type DoctorCheck,
	type DoctorCheckContext,
	type DoctorCheckResult,
	type StateFileCopy,
	inspectFileLock,
	listStateFileCopies,
	resolveNamzuHome,
	stateBackupsDir,
} from '@namzu/sdk'

import { mcpApprovalsProblem } from '../../integrations/mcp/project-approval.js'
import { trustListProblemAtStateRoot } from '../../integrations/trust/store.js'

/**
 * The state files that used to read as empty when damaged (the trusted folders
 * list and the tool server approvals), the lock files beside the Namzu home's
 * state files, and where the recovery copies are kept. Nothing here writes,
 * takes a lock or restores.
 */
export function describeStateFiles(namzuHome: string, now: number = Date.now()): DoctorCheckResult {
	const copies = listStateFileCopies(namzuHome)
	const where = stateBackupsDir(namzuHome)
	const problems = [trustListProblemAtStateRoot(namzuHome), mcpApprovalsProblem(namzuHome)].filter(
		(problem) => problem !== undefined,
	)
	const locks = lockFindings(namzuHome, now)
	const blocking = locks.filter((lock) => lock.blocks)
	if (problems.length > 0 || blocking.length > 0) {
		const named = [
			...problems.map(({ file, reason }) => `${file} could not be read (${reason})`),
			...blocking.map((lock) => lock.sentence),
		]
		return {
			status: 'fail',
			message: `${named.join('; ')}. ${copiesLine(copies, where)}${leftOver(locks)}`,
			remediation: [
				...(problems.length > 0 ? [restoreAdvice(problems.map((p) => p.file))] : []),
				...(blocking.length > 0
					? [
							'A lock file that cannot be read refuses every change to its file: close Namzu (the terminal and Desktop) and remove it.',
						]
					: []),
			].join(' '),
		}
	}
	const message = `state files readable. ${copiesLine(copies, where)}${leftOver(locks)}`
	return locks.length > 0 ? { status: 'warn', message } : { status: 'pass', message }
}

interface LockFinding {
	readonly sentence: string
	/** True when the next change cannot take it over on its own. */
	readonly blocks: boolean
}

/** The `<file>.lock` files at the top of the Namzu home that no live process holds. */
function lockFindings(namzuHome: string, now: number): LockFinding[] {
	let entries: string[]
	try {
		entries = readdirSync(namzuHome)
	} catch {
		return []
	}
	const findings: LockFinding[] = []
	for (const entry of entries.filter((name) => name.endsWith('.lock')).sort()) {
		const path = join(namzuHome, entry)
		const lock = inspectFileLock(path, now)
		if (lock.state === 'stale') {
			const owner =
				lock.pid === undefined
					? 'was never given an owner'
					: `was left by a process that has exited (pid ${lock.pid})`
			findings.push({
				sentence: `${path} ${owner}; the next change to its file takes it over`,
				blocks: false,
			})
		} else if (lock.state === 'unreadable') {
			findings.push({ sentence: `${path} could not be read (${lock.reason})`, blocks: true })
		}
	}
	return findings
}

function leftOver(locks: readonly LockFinding[]): string {
	const stale = locks.filter((lock) => !lock.blocks)
	return stale.length > 0 ? ` ${stale.map((lock) => lock.sentence).join('; ')}.` : ''
}

function copiesLine(copies: readonly StateFileCopy[], where: string): string {
	if (copies.length === 0) return `Recovery copies are kept in ${where} (none yet).`
	const files = [...new Set(copies.map((copy) => copy.file))].sort()
	const damaged = copies.filter((copy) => copy.kind === 'corrupted').length
	return `Recovery copies: ${copies.length} in ${where} (${files.join(', ')})${damaged > 0 ? `, ${damaged} of them kept from a file that could not be read` : ''}.`
}

function restoreAdvice(files: readonly string[]): string {
	return `A change to ${files.length === 1 ? 'this file' : 'these files'} is refused until it reads again, and nothing is restored on its own. To go back to a recovery copy, close Namzu and copy the newest <file>.backup.<time> from the backups folder over the file; it is the file as it was before a change at that time, so that change and any later one are not in it. To start a new list instead, keeping the old one, answer s in the trust box (trust.json) or run namzu mcp approve --new-list (mcp-approvals.json); or fix the file by hand.`
}

export const stateFilesCheck: DoctorCheck = {
	id: 'runtime.state-files',
	category: 'runtime',
	run: async (ctx: DoctorCheckContext): Promise<DoctorCheckResult> => {
		try {
			return describeStateFiles(resolveNamzuHome({ env: ctx.env }))
		} catch (error) {
			return {
				status: 'inconclusive',
				message: `the Namzu home could not be found: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	},
}
