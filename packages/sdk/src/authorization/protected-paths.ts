/**
 * Paths a write is always asked about, in every mode.
 *
 * A repository carries files that are not data but triggers: a git hook runs
 * on the next commit, a shell rc file on the next terminal, `.vscode/tasks.json`
 * when a folder opens, `.envrc` on the next `cd`. A model that can write them
 * does not need to run anything now; it plants code that runs later, outside
 * the turn, with the operator's own rights. So a write to one of them is a
 * question for a person, whatever the mode and whatever a rule or an earlier
 * "approve all" said. That is what a mode is, an answer given before the call
 * existed, and none of them saw this path.
 *
 * The lists are the reference terminal's protected-directory and
 * protected-file tables (version 2.1.302), with its own configuration
 * directory and file mapped to Namzu's: the project directory is `.namzu` and
 * the project file is `namzu.config.json`.
 *
 * Matching is by name, on every segment of the path. `.git` anywhere above a
 * file protects it, and `.config/git` counts as one two-segment unit. Names
 * are case-folded, including the dotless `ı` and long `ſ` that fold to `i`
 * and `s`, so `.GIT` and `.gıt` on a case-insensitive file system are the
 * same directory.
 */

/** Directory names; a path with one of these as any segment is protected. */
export const PROTECTED_DIRECTORIES: readonly string[] = [
	'.git',
	'.vscode',
	'.idea',
	'.namzu',
	'.husky',
	'.cargo',
	'.devcontainer',
	'.yarn',
	'.mvn',
]

/** Directory sequences; the segments must be adjacent. */
export const PROTECTED_NESTED_DIRECTORIES: readonly (readonly string[])[] = [['.config', 'git']]

/** File names; a path whose last segment is one of these is protected. */
export const PROTECTED_FILE_NAMES: readonly string[] = [
	'.gitconfig',
	'.gitmodules',
	'.bashrc',
	'.bash_profile',
	'.zshrc',
	'.zprofile',
	'.profile',
	'.zshenv',
	'.zlogin',
	'.zlogout',
	'.bash_login',
	'.bash_aliases',
	'.bash_logout',
	'.envrc',
	'.ripgreprc',
	'.mcp.json',
	'namzu.config.json',
	'.npmrc',
	'.yarnrc',
	'.yarnrc.yml',
	'.pnp.cjs',
	'.pnp.loader.mjs',
	'.pnpmfile.cjs',
	'bunfig.toml',
	'.bunfig.toml',
	'.bazelrc',
	'.bazelversion',
	'.bazeliskrc',
	'.pre-commit-config.yaml',
	'lefthook.yml',
	'.lefthook.yml',
	'lefthook.yaml',
	'.lefthook.yaml',
	'gradle-wrapper.properties',
	'maven-wrapper.properties',
	'.devcontainer.json',
	'pyrightconfig.json',
]

/** Lower case, with the two letters that fold into ASCII on some file systems. */
function fold(name: string): string {
	return name.toLowerCase().replace(/ı/g, 'i').replace(/ſ/g, 's')
}

const DIRECTORIES = new Set(PROTECTED_DIRECTORIES.map(fold))
const FILE_NAMES = new Set(PROTECTED_FILE_NAMES.map(fold))
const NESTED = PROTECTED_NESTED_DIRECTORIES.map((sequence) => sequence.map(fold))

/**
 * Whether a write to `path` is one of the protected kinds. Pure: it reads the
 * spelling it is given, so a caller that wants a symlink's target covered
 * passes the canonical path as well.
 */
export function isProtectedPath(path: string): boolean {
	const segments = path.split(/[\\/]+/).map(fold)
	for (const segment of segments) {
		if (DIRECTORIES.has(segment)) return true
	}
	for (const sequence of NESTED) {
		for (let start = 0; start + sequence.length <= segments.length; start += 1) {
			if (sequence.every((name, offset) => segments[start + offset] === name)) return true
		}
	}
	const last = segments[segments.length - 1]
	return last !== undefined && last !== '' && FILE_NAMES.has(last)
}
