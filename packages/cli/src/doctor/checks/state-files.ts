import {
	type DoctorCheck,
	type DoctorCheckContext,
	type DoctorCheckResult,
	type StateFileCopy,
	listStateFileCopies,
	resolveNamzuHome,
	stateBackupsDir,
} from '@namzu/sdk'

import { mcpApprovalsProblem } from '../../integrations/mcp/project-approval.js'
import { trustListProblemAtStateRoot } from '../../integrations/trust/store.js'

/**
 * The state files that used to read as empty when damaged (the trusted folders
 * list and the tool server approvals), and where the recovery copies of the
 * Namzu home's state files are kept. Nothing here writes or restores.
 */
export function describeStateFiles(namzuHome: string): DoctorCheckResult {
	const copies = listStateFileCopies(namzuHome)
	const where = stateBackupsDir(namzuHome)
	const problems = [trustListProblemAtStateRoot(namzuHome), mcpApprovalsProblem(namzuHome)].filter(
		(problem) => problem !== undefined,
	)
	if (problems.length > 0) {
		const named = problems.map(({ file, reason }) => `${file} could not be read (${reason})`)
		return {
			status: 'fail',
			message: `${named.join('; ')}. ${copiesLine(copies, where)}`,
			remediation: restoreAdvice(problems.map((p) => p.file)),
		}
	}
	return { status: 'pass', message: `state files readable. ${copiesLine(copies, where)}` }
}

function copiesLine(copies: readonly StateFileCopy[], where: string): string {
	if (copies.length === 0) return `Recovery copies are kept in ${where} (none yet).`
	const files = [...new Set(copies.map((copy) => copy.file))].sort()
	const damaged = copies.filter((copy) => copy.kind === 'corrupt').length
	return `Recovery copies: ${copies.length} in ${where} (${files.join(', ')})${damaged > 0 ? `, ${damaged} of them kept from a file that could not be read` : ''}.`
}

function restoreAdvice(files: readonly string[]): string {
	return `A change to ${files.length === 1 ? 'this file' : 'these files'} is refused until it reads again, and nothing is restored on its own. To go back to a recovery copy, copy the newest <file>.backup.<time> from the backups folder over the file; or fix the file by hand, or remove it to start an empty one.`
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
