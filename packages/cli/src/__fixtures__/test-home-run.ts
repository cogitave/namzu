import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

import { removeTempDir } from './temp-dir.js'

declare module 'vitest' {
	export interface ProvidedContext {
		namzuTestHomeRoot: string
	}
}

/** The runner owns the parent, so worker termination cannot skip its cleanup. */
export default function setup(project: TestProject): () => void {
	const root = mkdtempSync(join(realpathSync(tmpdir()), 'namzu-cli-test-run-'))
	project.provide('namzuTestHomeRoot', root)
	// Every suite gets its own NAMZU_HOME below this root (`test-setup.ts`), so
	// no state lands in the developer's home; the cleanup removes the root.
	const cleanup = () => removeTempDir(root)
	// TUI unmount persistence can finish after per-suite teardown. The runner's
	// final exit follows worker shutdown, including any late directory recreation.
	process.once('exit', cleanup)
	return cleanup
}
