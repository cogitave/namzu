import { isAbsolute, relative, resolve } from 'node:path'

import { resolveNamzuHome } from '@namzu/sdk'

import { homePath } from './person-terms.js'

/** What a session's plan file is called on screen. */
export const PLAN_FILE_LABEL = 'the plan'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** The configured Namzu home, or undefined when it cannot be resolved. */
function configuredNamzuHome(): string | undefined {
	try {
		return resolveNamzuHome()
	} catch {
		return undefined
	}
}

/**
 * Whether a path is a session's plan file, `<home>/projects/<project>/<session>/plans/plan.md`.
 * Its location is bookkeeping: a person reads it as the plan, not as a path.
 *
 * Anchored to where a session folder really is: under the Namzu home (the
 * configured one unless `home` is given), or, for a path from another machine
 * or another home, with a session id (a UUID) as the folder before `plans`.
 * A person's own `projects/app/src/plans/plan.md` is neither.
 */
export function isSessionPlanPath(
	path: string,
	home: string | undefined = configuredNamzuHome(),
): boolean {
	const flat = path.replace(/\\/gu, '/')
	const shape = /(^|\/)projects\/[^/]+\/([^/]+)\/plans\/plan\.md$/u.exec(flat)
	if (!shape) return false
	if (SESSION_ID.test(shape[2] ?? '')) return true
	if (home === undefined) return false
	const root = `${home.replace(/\\/gu, '/').replace(/\/+$/u, '')}/projects/`
	return flat.startsWith(root)
}

/**
 * A file path as a person reads it in a row or a sentence.
 *
 * Inside the working folder it is shown relative to it, as the model gave it
 * when it was already relative. Outside it, never `../../x`: under the home
 * folder it is `~/x`, anywhere else the full path. A raw absolute path to a
 * scratch folder is thereby never printed for a file the person is working on.
 */
export function displayPath(path: string, cwd?: string, home?: string): string {
	if (isSessionPlanPath(path)) return PLAN_FILE_LABEL
	if (path.length === 0 || /^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(path)) return path
	if (cwd === undefined) return homePath(path, home)
	const absolute = isAbsolute(path) ? path : resolve(cwd, path)
	const inside = relative(cwd, absolute)
	const escapes = inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')
	if (!escapes && !isAbsolute(inside)) {
		// As the model gave it when relative; relative to the folder when it was absolute.
		return isAbsolute(path) ? inside || '.' : path
	}
	return homePath(absolute, home)
}
