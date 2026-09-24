/**
 * The directory the model can open for a skill, in this CLI.
 *
 * The `skill` tool loads a body from the path the CLI discovered it at, and a
 * body that says "run scripts/render.sh" needs a directory the model's own
 * tools can open. On the host that is the same path. Inside the sandbox it
 * is only sometimes: the local sandbox mounts its root (the working directory,
 * or a disposable directory for an `ephemeral` workspace) and, with the
 * working directory, the added directories, each at its own canonical path,
 * and nothing else. The sandbox's file API refuses every other path, links
 * followed. So:
 *
 *   - a project skill (`<cwd>/.namzu/skills`, `<cwd>/.agents/skills`,
 *     `<cwd>/skills`) is reachable, and so is one under an added directory;
 *   - a user skill (`~/.namzu/skills`, `~/.agents/skills`), a built-in skill
 *     (inside the installed package), a plugin skill outside the project, one
 *     in `.agents/skills` above `<cwd>`, and a project skill whose directory
 *     is a link to somewhere unmounted are not, and are answered `undefined`
 *     rather than with a path that would fail;
 *   - under an `ephemeral` workspace nothing of the host is mounted, so every
 *     skill is `undefined`.
 *
 * The bwrap tier also binds `/usr`, `/opt` and the Node prefix read-only for
 * commands to run. A built-in skill of a CLI installed under one of them can
 * be `cat` from `bash` there, but the `read` tool refuses it and the macOS
 * and namespace tiers differ again, so it is not offered as reachable.
 */

import { type SkillDirectoryResolver, resolveWithinReal } from '@namzu/sdk'

export interface SkillDirectoryResolverOptions {
	/**
	 * The directories the sandbox mounts at their own paths besides its root,
	 * read on every call so `/add-dir` counts. Empty for an `ephemeral`
	 * workspace, which mounts none of them.
	 */
	readonly sandboxMounts: () => readonly string[]
}

export function createSkillDirectoryResolver(
	options: SkillDirectoryResolverOptions,
): SkillDirectoryResolver {
	return async (skill, context) => {
		if (skill.directory === undefined) return undefined
		// On the host the model's tools open the path the CLI read the skill
		// from: a path outside the working directory is a permission question,
		// not a wall.
		if (!context.sandbox) return skill.directory
		for (const root of [context.sandbox.rootDir, ...options.sandboxMounts()]) {
			try {
				// Canonical, because that is the path each root is mounted at;
				// a link out of the root throws, and its target is not mounted.
				return await resolveWithinReal(root, skill.directory)
			} catch {
				// Not under this root; try the next.
			}
		}
		return undefined
	}
}
