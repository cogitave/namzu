/**
 * Composer triggers are the interactive terminal's alone. Only files under
 * `tui/` import `tui/triggers/`; `config/` holds the shape and the merge rule
 * but never the matcher; and no headless, scheduled, resident or delegated
 * surface reaches it. `namzu exec "hypermode …"` is prose.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../', import.meta.url))

function sources(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) {
			if (name === '__tests__' || name === '__fixtures__') continue
			out.push(...sources(path))
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
	}
	return out
}

const IMPORTS_TRIGGERS = /from '(?:\.\.?\/)+(?:tui\/)?triggers\/[a-z-]+\.js'/

describe('composer triggers belong to the TUI alone', () => {
	it('only files under tui/ import the matcher', () => {
		const importers = sources(SRC)
			.filter((file) => IMPORTS_TRIGGERS.test(readFileSync(file, 'utf8')))
			.map((file) => relative(SRC, file).replaceAll('\\', '/'))
			.sort()
		expect(importers.length).toBeGreaterThan(0)
		for (const file of importers) expect(file, file).toMatch(/^tui\//u)
		expect(importers).toContain('tui/Composer.tsx')
		expect(importers).toContain('tui/App.tsx')
	})

	it('no headless, scheduled, resident or delegated surface mentions it', () => {
		for (const surface of [
			'commands/exec.ts',
			'commands/drain.ts',
			'commands/acp.ts',
			'schedule/fire/fire.ts',
			'integrations/resident/session-step.ts',
			'integrations/subagents/runtime.ts',
			'tui/agent.ts',
			'config/load.ts',
			'config/composer-triggers.ts',
		]) {
			expect(readFileSync(join(SRC, surface), 'utf8'), surface).not.toMatch(
				/triggers\/(?:detect|registry|pattern|provenance|copy|analyze|fold|verbs|context-text|setting)\.js/,
			)
		}
	})
})
