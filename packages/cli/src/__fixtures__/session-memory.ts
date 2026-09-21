import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DiskMemoryStore, projectIdForDirectory } from '@namzu/sdk'

import { resolveNamzuHome } from '../integrations/state/home.js'
import { cliProjectRoot } from '../integrations/state/project.js'

/**
 * Where a session opened on `cwd` without a scope keeps generated memory: the
 * application home, partitioned by the Project the directory stands for.
 * Never `<cwd>/.namzu` — that default put runtime trees inside checkouts.
 */
export function sessionMemoryDir(cwd: string): string {
	return join(
		resolveNamzuHome(),
		'memory',
		projectIdForDirectory(cliProjectRoot(realpathSync(cwd))),
	)
}

/** The store the session's memory tools read and write, opened the same way. */
export function sessionMemoryStore(cwd: string): DiskMemoryStore {
	return new DiskMemoryStore({ baseDir: resolveNamzuHome(), directory: sessionMemoryDir(cwd) })
}
