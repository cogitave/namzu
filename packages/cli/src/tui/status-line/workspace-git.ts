/**
 * The two repository facts a status line command may want: the linked
 * worktree's name and the `origin` remote's host, owner and name. Asked of
 * `git` with a short deadline; any failure is "not known", never an error.
 */

import { execFile } from 'node:child_process'
import { basename, resolve } from 'node:path'

export interface WorkspaceGit {
	readonly gitWorktree?: string
	readonly repo?: {
		readonly host: string
		readonly owner: string
		readonly name: string
	}
}

const GIT_TIMEOUT_MS = 3_000

export function parseRemoteUrl(url: string): WorkspaceGit['repo'] | undefined {
	const trimmed = url.trim()
	const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^/\s]+)\/(.+?)(?:\.git)?\/?$/u.exec(trimmed)
	if (scp?.[1] && scp[2] && scp[3]) return { host: scp[1], owner: scp[2], name: scp[3] }
	try {
		const parsed = new URL(trimmed)
		const parts = parsed.pathname
			.replace(/\.git\/?$/u, '')
			.split('/')
			.filter(Boolean)
		if (parsed.hostname && parts.length >= 2) {
			return {
				host: parsed.hostname,
				owner: parts[0] as string,
				name: parts[1] as string,
			}
		}
	} catch {
		// Not a URL.
	}
	return undefined
}

export type GitRun = (args: readonly string[], cwd: string) => Promise<string>

const runGit: GitRun = (args, cwd) =>
	new Promise((resolveRun, reject) => {
		execFile(
			'git',
			[...args],
			{ cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
			(error, stdout) => (error ? reject(error) : resolveRun(stdout)),
		)
	})

export async function readWorkspaceGit(cwd: string, git: GitRun = runGit): Promise<WorkspaceGit> {
	const out: {
		gitWorktree?: string
		repo?: NonNullable<WorkspaceGit['repo']>
	} = {}
	try {
		const [gitDir, commonDir, top] = (
			await git(['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], cwd)
		)
			.trim()
			.split('\n')
		if (gitDir && commonDir && top && resolve(cwd, gitDir) !== resolve(cwd, commonDir)) {
			out.gitWorktree = basename(top)
		}
	} catch {
		// Not a repository.
	}
	try {
		const repo = parseRemoteUrl(await git(['remote', 'get-url', 'origin'], cwd))
		if (repo) out.repo = repo
	} catch {
		// No origin.
	}
	return out
}
