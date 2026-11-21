import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

import { removeTempDir } from './temp-dir.js'

declare module 'vitest' {
	export interface ProvidedContext {
		namzuTestHomeRoot: string
	}
}

/**
 * A test may leave a folder it made read-only (an installed extension is locked that way); its
 * entries cannot be removed until it is writable again. Links are not followed.
 */
function makeFoldersWritable(root: string): void {
	const pending = [root]
	while (pending.length > 0) {
		const current = pending.pop() as string
		let entry: ReturnType<typeof lstatSync>
		try {
			entry = lstatSync(current)
		} catch {
			continue
		}
		if (!entry.isDirectory()) continue
		if ((entry.mode & 0o700) !== 0o700) {
			try {
				chmodSync(current, (entry.mode & 0o7777) | 0o700)
			} catch {
				// Not ours to change; the removal below reports what it could not remove.
			}
		}
		let names: string[] = []
		try {
			names = readdirSync(current)
		} catch {
			continue
		}
		for (const name of names) pending.push(join(current, name))
	}
}

/**
 * The runner owns the parent, so worker termination cannot skip its cleanup.
 *
 * Every temporary file of the run goes inside it too: TMPDIR (and TMP, TEMP) point at `<root>/t`
 * before the workers start, so they inherit it, and a test that never removes its
 * `mkdtemp(tmpdir())` folder, a session's scratch folder or a hook's leftovers are removed with
 * the root. `t` is short on purpose: a socket made under it must stay within the platform's limit.
 */
export default function setup(project: TestProject): () => void {
	const root = mkdtempSync(join(realpathSync(tmpdir()), 'nz-run-'))
	const temporaryFiles = join(root, 't')
	mkdirSync(temporaryFiles, { mode: 0o700 })
	project.provide('namzuTestHomeRoot', root)
	const previous = {
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
		NAMZU_TMPDIR: process.env.NAMZU_TMPDIR,
	}
	process.env.TMPDIR = temporaryFiles
	process.env.TMP = temporaryFiles
	process.env.TEMP = temporaryFiles
	// Namzu's own temporary folder follows TMPDIR into the root unless NAMZU_TMPDIR sends it elsewhere.
	// biome-ignore lint/performance/noDelete: assigning undefined creates the string "undefined" in process.env.
	delete process.env.NAMZU_TMPDIR
	// Every suite gets its own NAMZU_HOME below this root (`test-setup.ts`), so
	// no state lands in the developer's home; the cleanup removes the root.
	let cleaned = false
	const cleanup = () => {
		if (cleaned) return
		cleaned = true
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) Reflect.deleteProperty(process.env, name)
			else process.env[name] = value
		}
		makeFoldersWritable(root)
		removeTempDir(root)
	}
	// TUI unmount persistence can finish after per-suite teardown. The runner's
	// final exit follows worker shutdown, including any late directory recreation.
	process.once('exit', () => {
		cleaned = false
		cleanup()
	})
	return cleanup
}
