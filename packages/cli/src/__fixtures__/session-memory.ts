import { realpathSync } from 'node:fs'
import { DiskMemoryStore, MarkdownMemoryStore, SessionPaths, slugForCwd } from '@namzu/sdk'

import { resolveNamzuHome } from '../integrations/state/home.js'
import { cliProjectRoot } from '../integrations/state/project.js'

/**
 * Where a session opened on `cwd` keeps generated memory: the project's
 * `memory/` under `NAMZU_HOME` (`projects/<slug>/memory`). Never
 * `<cwd>/.namzu` — that default put runtime trees inside checkouts.
 */
export function sessionMemoryDir(cwd: string): string {
	const root = realpathSync(cliProjectRoot(realpathSync(cwd)))
	return new SessionPaths({ home: resolveNamzuHome(), slug: slugForCwd(root) }).memoryDir()
}

/** The store the session's memory tools read and write, opened the same way. */
export function sessionMemoryStore(cwd: string): MarkdownMemoryStore {
	return new MarkdownMemoryStore({ directory: sessionMemoryDir(cwd) })
}

/** The pre-Markdown JSON store at the same directory, for seeding what a session migrates. */
export function sessionLegacyMemoryStore(cwd: string): DiskMemoryStore {
	return new DiskMemoryStore({ baseDir: resolveNamzuHome(), directory: sessionMemoryDir(cwd) })
}
