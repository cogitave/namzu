import { execFile } from 'node:child_process'

/** What a workspace's second line says about its folder. */
export interface GitStatus {
	readonly branch: string
	/** Commits ahead of the upstream, when there is one. */
	readonly ahead: number
	/** Commits behind the upstream, when there is one. */
	readonly behind: number
}

/** Reads a folder's branch and how far it is from its upstream; undefined outside a repository. */
export type GitLookup = (cwd: string) => Promise<GitStatus | undefined>

/** A lookup never keeps a frame waiting; it also never runs for long. */
const GIT_TIMEOUT_MS = 2000

function run(cwd: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile(
				'git',
				[...args],
				{
					cwd,
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: 64 * 1024,
					windowsHide: true,
					// Reading must never take the index lock a person's own git command wants.
					env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
				},
				(error, stdout) => resolve(error ? undefined : String(stdout).trim()),
			)
		} catch {
			resolve(undefined)
		}
	})
}

/** The real lookup: two cheap git commands that read refs only and never scan the work tree. */
export const gitLookup: GitLookup = async (cwd) => {
	const branch =
		(await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])) ||
		(await run(cwd, ['rev-parse', '--short', 'HEAD']))
	if (!branch) return undefined
	const counts = await run(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
	const match = counts ? /^(\d+)\s+(\d+)$/u.exec(counts) : null
	return {
		branch,
		ahead: match ? Number(match[1]) : 0,
		behind: match ? Number(match[2]) : 0,
	}
}

/** The newest answer per folder. Asking never blocks: a lookup in flight is not repeated, and a change asks for a redraw. */
export class GitCache {
	private readonly known = new Map<string, GitStatus | undefined>()
	private readonly started = new Map<string, number>()
	private readonly running = new Set<string>()

	constructor(
		private readonly lookup: GitLookup,
		private readonly changed: () => void,
		private readonly now: () => number,
	) {}

	get(cwd: string): GitStatus | undefined {
		return this.known.get(cwd)
	}

	/** Looks again at a folder unless a lookup is running or one started within `within` ms. */
	refresh(cwd: string, within = 0): void {
		if (this.running.has(cwd)) return
		const last = this.started.get(cwd)
		const at = this.now()
		if (last !== undefined && at - last < within) return
		this.running.add(cwd)
		this.started.set(cwd, at)
		void this.lookup(cwd)
			.catch(() => undefined)
			.then((status) => {
				this.running.delete(cwd)
				const before = this.known.get(cwd)
				this.known.set(cwd, status)
				if (
					before?.branch !== status?.branch ||
					before?.ahead !== status?.ahead ||
					before?.behind !== status?.behind
				)
					this.changed()
			})
	}

	refreshAll(cwds: Iterable<string>): void {
		for (const cwd of new Set(cwds)) this.refresh(cwd)
	}
}
