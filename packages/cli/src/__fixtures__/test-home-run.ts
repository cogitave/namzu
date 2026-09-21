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
	// An SDK entry point reached without a path builder writes under
	// `defaultStateRoot()`, the user's state directory. Point it here; the
	// forked workers inherit it and the cleanup below removes it.
	process.env.NAMZU_STATE_DIR = join(root, 'sdk-state')
	const cleanup = () => removeTempDir(root)
	// TUI unmount persistence can finish after per-suite teardown. The runner's
	// final exit follows worker shutdown, including any late directory recreation.
	process.once('exit', cleanup)
	return cleanup
}
