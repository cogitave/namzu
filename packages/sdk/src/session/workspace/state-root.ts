import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Where generated runtime state goes when the host names no place for it.
 *
 * Runs, checkpoints, token ledgers and crash dumps are written under a
 * {@link import('./path-builder.js').PathBuilder}. A host that passes none
 * used to get `<workingDirectory>/.namzu`, which put generated state inside
 * whatever directory the agent was pointed at: a repository gained a
 * `.namzu/` it had to ignore, a package test left one in the package, and a
 * run started in `$HOME` wrote into `~/.namzu`, the CLI's own application
 * home, as a tree the CLI has no record of.
 *
 * Now it is a per-user state directory, the same for every working directory:
 *
 * - `NAMZU_STATE_DIR`, when set — an absolute path, or one resolved against
 *   the process's working directory;
 * - Linux and other Unix: `$XDG_STATE_HOME/namzu`, else
 *   `~/.local/state/namzu` (XDG Base Directory, "state" is data that should
 *   persist between restarts but is not worth backing up);
 * - macOS: `~/Library/Application Support/namzu/state`;
 * - Windows: `%LOCALAPPDATA%\namzu\state`.
 *
 * It is never the CLI's `~/.namzu`. Runs from different directories do not
 * collide: every path under it is keyed by Project, and an SDK entry point
 * with no Project derives one from the working directory
 * (`projectIdForDirectory`).
 */
export function defaultStateRoot(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	const explicit = env.NAMZU_STATE_DIR
	if (explicit !== undefined && explicit !== '') return resolve(explicit)
	if (platform === 'win32') {
		const local = env.LOCALAPPDATA
		return join(
			local && isAbsolute(local) ? local : join(home, 'AppData', 'Local'),
			'namzu',
			'state',
		)
	}
	if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'namzu', 'state')
	// The XDG spec says a relative value is invalid and must be ignored.
	const xdg = env.XDG_STATE_HOME
	return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state'), 'namzu')
}
