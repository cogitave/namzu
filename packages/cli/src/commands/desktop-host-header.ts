/** Read-only helpers behind the Desktop conversation header: project git and capped Markdown. */
import { execFile } from 'node:child_process'

export interface ProjectGitState {
	readonly branch: string | null
	readonly subject: string | null
}

export type GitRun = (args: readonly string[], cwd: string) => Promise<string>

export const GIT_TIMEOUT_MS = 3_000
export const GIT_OUTPUT_CAP = 64 * 1024
export const GIT_CACHE_MS = 15_000
export const MARKDOWN_CAP_BYTES = 4 * 1024 * 1024
const SUBJECT_MAX = 200

// No shell, no optional locks, no repo-configured fsmonitor hook.
const gitArgs = (args: readonly string[]) => [
	'-c',
	'core.fsmonitor=false',
	'--no-optional-locks',
	...args,
]

export const runGit: GitRun = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile(
			'git',
			gitArgs(args),
			{
				cwd,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: GIT_OUTPUT_CAP,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
				windowsHide: true,
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		)
	})

/** Branch and last commit subject of the repository at `cwd`; null when there is no usable repository. */
export function createProjectGit(options: { run?: GitRun; now?: () => number } = {}) {
	const run = options.run ?? runGit
	const now = options.now ?? Date.now
	const cache = new Map<string, { at: number; value: Promise<ProjectGitState | null> }>()
	const read = async (cwd: string): Promise<ProjectGitState | null> => {
		let branch: string | null
		try {
			branch = (await run(['symbolic-ref', '--short', '-q', 'HEAD'], cwd)).trim() || null
		} catch (error) {
			// `-q` exits 1 with no output on a detached HEAD; any other failure is not a usable repo.
			if ((error as { code?: unknown }).code !== 1) return null
			branch = null
		}
		let subject: string | null = null
		try {
			subject = (await run(['log', '-1', '--format=%s'], cwd)).trim().slice(0, SUBJECT_MAX) || null
		} catch {
			// A detached HEAD with no commit cannot happen; an unborn branch simply has no subject.
			if (branch === null) return null
		}
		return { branch, subject }
	}
	return (cwd: string): Promise<ProjectGitState | null> => {
		const hit = cache.get(cwd)
		if (hit && now() - hit.at < GIT_CACHE_MS) return hit.value
		const value = read(cwd).catch(() => null)
		cache.set(cwd, { at: now(), value })
		return value
	}
}

/** Cap Markdown at `max` UTF-8 bytes without splitting a character. */
export function capMarkdown(markdown: string, max = MARKDOWN_CAP_BYTES) {
	const bytes = Buffer.from(markdown, 'utf8')
	if (bytes.length <= max) return { markdown, truncated: false }
	let end = max
	// Step back off a continuation byte so the cut lands on a character boundary.
	while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--
	return { markdown: bytes.subarray(0, end).toString('utf8'), truncated: true }
}
