import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REVIEW_GIT_TIMEOUT_MS = 10_000
const REVIEW_COMMIT_LIMIT = 100

export interface ReviewBranchListing {
	readonly current: string
	readonly branches: readonly string[]
}

export interface ReviewCommit {
	readonly sha: string
	readonly title: string
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
	try {
		const { stdout } = await run('git', [...args], {
			cwd,
			timeout: REVIEW_GIT_TIMEOUT_MS,
			maxBuffer: 1024 * 1024 * 8,
		})
		return stdout
	} catch {
		return null
	}
}

function isCommitSha(value: string): boolean {
	return /^[0-9a-f]{40,64}$/u.test(value)
}

/** Local branch targets plus the name shown on the left of the comparison. */
export async function listReviewBranches(cwd: string): Promise<ReviewBranchListing | null> {
	const raw = await git(cwd, [
		'for-each-ref',
		'--format=%(refname:short)',
		'--sort=refname',
		'refs/heads',
	])
	if (raw === null) return null

	const branches = raw
		.split('\n')
		.map((branch) => branch.trim())
		.filter(Boolean)
	const current = (await git(cwd, ['branch', '--show-current']))?.trim() || '(detached HEAD)'
	return { current, branches }
}

/** Recent reachable commits, with the display title separated from the executable id. */
export async function listReviewCommits(cwd: string): Promise<readonly ReviewCommit[] | null> {
	const raw = await git(cwd, [
		'log',
		'-n',
		String(REVIEW_COMMIT_LIMIT),
		'--pretty=format:%H%x1f%s%x1e',
	])
	if (raw === null) return null

	const commits: ReviewCommit[] = []
	for (const record of raw.split('\u001e')) {
		const separator = record.indexOf('\u001f')
		if (separator < 0) continue
		const sha = record.slice(0, separator).trim()
		if (!isCommitSha(sha)) continue
		const title = record.slice(separator + 1).trim()
		commits.push({ sha, title: title || '(untitled commit)' })
	}
	return commits
}

/** Resolve the selected ref before composing a model prompt; never make the model interpolate it. */
export async function reviewMergeBase(cwd: string, branch: string): Promise<string | null> {
	const sha = (await git(cwd, ['merge-base', 'HEAD', branch]))?.trim() ?? ''
	return isCommitSha(sha) ? sha : null
}
