import { execFile } from 'node:child_process'

/**
 * Example prompts shown in an empty first prompt, as `Try "..."`. Ones that
 * name a file are only offered when a frequently modified file is known;
 * otherwise the pick falls back to the ones that do not.
 */
const PLAIN_EXAMPLES: readonly string[] = [
	'fix lint errors',
	'fix typecheck errors',
	'how do I log an error?',
	'create a util logging.py that...',
]

const FILE_EXAMPLES: readonly ((file: string) => string)[] = [
	(file) => `how does ${file} work?`,
	(file) => `refactor ${file}`,
	(file) => `edit ${file} to...`,
	(file) => `write a test for ${file}`,
]

/** `seed` is any number in [0, 1); the same seed gives the same example. */
export function examplePlaceholder(file: string | undefined, seed: number): string {
	const pool: readonly string[] = [
		...PLAIN_EXAMPLES,
		...(file ? FILE_EXAMPLES.map((make) => make(file)) : []),
	]
	const at = Math.min(pool.length - 1, Math.floor(Math.max(0, seed) * pool.length))
	return `Try "${pool[at]}"`
}

/** Files that look like source, not lockfiles, generated output or notes. */
function isExampleFile(path: string): boolean {
	if (/(^|\/)(node_modules|dist|build|\.changeset|docs)\//.test(path)) return false
	if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md|log\.md)$/.test(path))
		return false
	return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|c|cc|cpp|h|cs|swift|kt)$/.test(path)
}

/** The most-edited source file among the last commits, or undefined (no repository, no history). */
export function frequentlyModifiedFile(
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(
			'git',
			['log', '--name-only', '--pretty=format:', '-n', '200'],
			{ cwd, signal, maxBuffer: 4 * 1024 * 1024, timeout: 5000 },
			(error, stdout) => {
				if (error) return resolve(undefined)
				const counts = new Map<string, number>()
				for (const line of stdout.split('\n')) {
					const path = line.trim()
					if (path && isExampleFile(path)) counts.set(path, (counts.get(path) ?? 0) + 1)
				}
				let best: string | undefined
				let bestCount = 0
				for (const [path, count] of counts) {
					if (count > bestCount) {
						best = path
						bestCount = count
					}
				}
				resolve(best)
			},
		)
	})
}
