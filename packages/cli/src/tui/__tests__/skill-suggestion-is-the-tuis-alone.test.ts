/**
 * The proposal to save a task as a skill is the interactive terminal's
 * alone. A headless run (`exec`, `exec --json`, `drain`), ACP, a scheduled
 * run, a resident worker and a sub-agent have no one to read it: none of
 * them imports the heuristic or its ledger, and only the App does.
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

const IMPORTS_LEARNING = /from '[./]*(?:tui\/)?skills\/(?:learning|suggestion-ledger)\.js'/

describe('skill suggestions belong to the TUI alone', () => {
	it('only the App imports the heuristic and its ledger', () => {
		const importers = sources(SRC)
			.filter((file) => IMPORTS_LEARNING.test(readFileSync(file, 'utf8')))
			.map((file) => relative(SRC, file).replaceAll('\\', '/'))
			.sort()
		expect(importers).toEqual(['tui/App.tsx'])
	})

	it('no headless, scheduled or delegated surface mentions it', () => {
		for (const surface of [
			'commands/exec.ts',
			'commands/exec-json.ts',
			'commands/drain.ts',
			'commands/acp.ts',
			'schedule/fire/fire.ts',
			'integrations/resident/session-step.ts',
			'integrations/subagents/runtime.ts',
			'tui/agent.ts',
		]) {
			expect(readFileSync(join(SRC, surface), 'utf8'), surface).not.toMatch(
				/judgeSkillSuggestion|skillSuggestionNotice|suggestion-ledger|skills\/learning/,
			)
		}
	})
})
