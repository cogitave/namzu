/**
 * Local Git repositories for tests: a working copy that commits, and a bare
 * repository that stands in for a remote. Nothing here touches the network,
 * the person's Git configuration or a real home: the environment is built
 * from scratch and the author is fixed.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function gitEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.TMPDIR ?? '/tmp',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.invalid',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.invalid',
		GIT_AUTHOR_DATE: '2026-11-27T10:00:00Z',
		GIT_COMMITTER_DATE: '2026-11-27T10:00:00Z',
	}
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
		cwd,
		env: gitEnv(),
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim()
}

export interface TestRepo {
	/** The working copy. */
	readonly work: string
	/** The bare repository other code clones from. */
	readonly bare: string
	/** `file://` address of the bare repository. */
	readonly url: string
	/** Write files (string, or `{ content, mode }`), commit all, push. Returns the commit. */
	readonly commit: (
		files: Record<string, string | { content: string; mode?: number }>,
		message?: string,
	) => string
	readonly tag: (name: string) => void
	readonly branch: (name: string) => void
}

export function makeRepo(root: string, name: string): TestRepo {
	const work = join(root, `${name}-work`)
	const bare = join(root, `${name}.git`)
	mkdirSync(work, { recursive: true })
	git(work, 'init', '--quiet', '--initial-branch=main')
	git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare)
	// A local server that allows what a real host does: partial clones and fetching a commit by id.
	git(bare, 'config', 'uploadpack.allowFilter', 'true')
	git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
	git(work, 'remote', 'add', 'origin', bare)
	return {
		work,
		bare,
		url: pathToFileURL(bare).toString(),
		commit: (files, message = 'commit') => {
			for (const [path, value] of Object.entries(files)) {
				const full = join(work, path)
				mkdirSync(dirname(full), { recursive: true })
				const content = typeof value === 'string' ? value : value.content
				writeFileSync(full, content, {
					mode: typeof value === 'string' ? 0o644 : (value.mode ?? 0o644),
				})
			}
			git(work, 'add', '-A')
			git(work, 'commit', '--quiet', '-m', message)
			git(work, 'push', '--quiet', 'origin', 'HEAD:main')
			return git(work, 'rev-parse', 'HEAD')
		},
		tag: (tagName) => {
			git(work, 'tag', tagName)
			git(work, 'push', '--quiet', 'origin', tagName)
		},
		branch: (branchName) => {
			git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branchName}`)
		},
	}
}
